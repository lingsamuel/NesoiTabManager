// 侧边栏「滚动位置跟随活动标签」的端到端回归测试。
//
// 为什么不满足于纯函数单测（scripts/test_scroll_markers.mjs）：这条链路由"chrome 事件 → 状态
// → watcher → 真实滚动容器"四段拼成，最容易坏的一环恰恰是中间的状态流转，而且坏掉时**不会**报错、
// 界面也没有异常，只是"列表不动"。真实案例：`applyActiveTab` 在遇到还没进列表的新标签时
// 把其它标签的活动标记一并清掉，"变化前的活动行"这条跟随依据被丢掉，于是新建标签后再也不跟随；
// 纯函数测试对此完全无感。
//
// 做法：在 Node 里把**真实的** SidebarApp.vue 跑起来——用 vue/compiler-sfc 即时编译 .vue，
// 用 Vue 的 createRenderer 提供假 DOM（只实现 SidebarApp 真正用到的那点几何语义：
// clientHeight、scrollTop 及其夹取），再用假 chrome 控制标签列表与事件顺序。
import { createRenderer } from "vue";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse, compileScript } from "vue/compiler-sfc";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// .vue 加载器：即编译即用（script setup + inlineTemplate）
// ---------------------------------------------------------------------------
registerHooks({
  resolve(specifier, context, nextResolve) {
    // 入口是用绝对 file: URL 动态 import 的（见文件末尾），这里直接放行。
    if (specifier.startsWith("file:")) {
      return { url: specifier, shortCircuit: true, format: "module" };
    }
    if (specifier.endsWith(".vue")) {
      const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : here;
      return {
        url: pathToFileURL(path.resolve(parent, specifier)).href,
        shortCircuit: true,
        format: "module",
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".vue")) {
      return nextLoad(url, context);
    }
    const filename = fileURLToPath(url);
    const source = readFileSync(filename, "utf8");
    const { descriptor } = parse(source, { filename });
    const id = createHash("sha1").update(filename).digest("hex").slice(0, 8);
    const compiled = compileScript(descriptor, { id, inlineTemplate: true });
    return { format: "module", source: compiled.content, shortCircuit: true };
  },
});

// ---------------------------------------------------------------------------
// 假 DOM：只实现 SidebarApp 真正用到的那点几何语义
// ---------------------------------------------------------------------------
const VIEWPORT_HEIGHT = 600;
const ITEM_HEIGHT = 30;
let scrollContainer = null;

function normalizeClass(value) {
  if (!value) return [];
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(normalizeClass);
  if (typeof value === "object") return Object.entries(value).filter(([, on]) => on).map(([key]) => key);
  return [];
}

function styleHeight(style) {
  if (!style) return null;
  const text = typeof style === "string"
    ? style
    : Object.entries(style).map(([key, value]) => `${key}:${value}`).join(";");
  const match = /(?:^|;)\s*height\s*:\s*([0-9.]+)px/.exec(text);
  return match ? Number(match[1]) : null;
}

function createEl(tag) {
  return {
    tag,
    children: [],
    parent: null,
    props: {},
    _class: [],
    _styleHeight: null,
    clientHeight: 0,
    _scrollTop: 0,
    // 模拟浏览器的滚动夹取：内容高度取自 .virtual-content 的 style.height。
    // 不模拟这一步的话，越界赋值会被误当成生效，测出来的位置就是假的。
    get scrollTop() {
      return this._scrollTop;
    },
    set scrollTop(value) {
      const content = this.children.find((child) => child && typeof child._styleHeight === "number");
      const contentHeight = content ? content._styleHeight : 0;
      const max = Math.max(0, contentHeight - this.clientHeight);
      this._scrollTop = Math.max(0, Math.min(Number(value) || 0, max));
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 300, height: this.clientHeight };
    },
  };
}

const nodeOps = {
  insert(child, parent, anchor) {
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, child);
    else parent.children.push(child);
  },
  remove(child) {
    if (child.parent) {
      const index = child.parent.children.indexOf(child);
      if (index >= 0) child.parent.children.splice(index, 1);
    }
    child.parent = null;
  },
  createElement: createEl,
  createText: (text) => ({ text, parent: null }),
  createComment: (text) => ({ comment: text, parent: null }),
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    node.text = text;
  },
  parentNode: (node) => node.parent || null,
  nextSibling(node) {
    if (!node.parent) return null;
    const index = node.parent.children.indexOf(node);
    return node.parent.children[index + 1] || null;
  },
  querySelector: () => null,
  setScopeId() {},
  cloneNode: (node) => createEl(node.tag),
  insertStaticContent: () => [createEl("div"), createEl("div")],
  patchProp(el, key, _prev, next) {
    if (key === "class") {
      el._class = normalizeClass(next);
      // 认出滚动容器并给它一个视口高度：这是整套模拟里唯一的"尺寸来源"。
      if (el._class.includes("virtual-scroller")) {
        el.clientHeight = VIEWPORT_HEIGHT;
        scrollContainer = el;
      }
      return;
    }
    if (key === "style") {
      const height = styleHeight(next);
      if (height !== null) el._styleHeight = height;
      el.props.style = next;
      return;
    }
    el.props[key] = next;
  },
};

// ---------------------------------------------------------------------------
// 假 chrome：可控的窗口标签列表 + 可手工触发的事件
// ---------------------------------------------------------------------------
const WINDOW_ID = 1;
const createdTabId = 999;
let browserTabs = [];
const listeners = { created: [], activated: [], updated: [], removed: [] };

/** 返回副本：侧边栏会就地改 active 标记，不能让"假浏览器"的状态被它改掉。 */
function snapshot() {
  return browserTabs.map((tab) => ({ ...tab }));
}

function sendMessage(message, callback) {
  const action = message && message.action;
  if (action === "createRootTab") {
    // 真实顺序：浏览器先创建并激活新标签（此刻侧边栏列表里还没有它），后台随后才回消息。
    // 这一段顺序正是回归的关键，不能简化成"直接刷新出海新标签"。
    const created = {
      id: createdTabId,
      windowId: WINDOW_ID,
      index: browserTabs.length,
      active: true,
      pinned: false,
      title: "新建的标签页",
      url: "about:newtab",
    };
    browserTabs = browserTabs.map((tab) => ({ ...tab, active: false })).concat([created]);
    for (const listener of listeners.activated) {
      listener({ tabId: created.id, windowId: WINDOW_ID });
    }
    callback({ ok: true, tabId: created.id, windowId: WINDOW_ID });
    return;
  }
  if (action === "getTreeStructure") {
    callback({ ok: true, structures: { [WINDOW_ID]: { parents: {} } } });
    return;
  }
  callback({ ok: true });
}

globalThis.chrome = {
  runtime: {
    lastError: null,
    getURL: (resource) => `chrome-extension://abc/${resource}`,
    sendMessage,
  },
  storage: {
    local: { get: (_key, cb) => cb({}), set: (_obj, cb) => cb && cb() },
    session: { get: (_key, cb) => cb({}), set: (_obj, cb) => cb && cb() },
    onChanged: { addListener() {} },
  },
  tabs: {
    query(info, callback) {
      const list = snapshot().filter((tab) => {
        if (info && info.pinned === true && !tab.pinned) return false;
        if (info && info.windowId !== undefined && tab.windowId !== info.windowId) return false;
        return true;
      });
      callback(list);
    },
    create() {},
    remove() {},
    move() {},
    update() {},
    onCreated: { addListener: (fn) => listeners.created.push(fn) },
    onActivated: { addListener: (fn) => listeners.activated.push(fn) },
    onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    onMoved: { addListener() {} },
    onAttached: { addListener() {} },
    onDetached: { addListener() {} },
  },
  windows: {
    getCurrent: (cb) => cb({ id: WINDOW_ID }),
    getAll: (cb) => cb([{ id: WINDOW_ID }]),
    update() {},
  },
  menus: undefined,
  contextMenus: undefined,
};

globalThis.document = {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
};

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = FakeResizeObserver;

// ---------------------------------------------------------------------------
// 启动：60 个标签，活动标签在第 24 行（远在视口之外）
// ---------------------------------------------------------------------------
const TAB_COUNT = 60;
const ACTIVE_INDEX = 24;
browserTabs = Array.from({ length: TAB_COUNT }, (_, index) => ({
  id: index + 1,
  windowId: WINDOW_ID,
  index,
  active: index === ACTIVE_INDEX,
  pinned: false,
  title: `标签 ${index + 1}`,
  url: `https://example.com/${index + 1}`,
}));

const { default: SidebarApp } = await import(
  pathToFileURL(path.join(here, "..", "src", "sidebar", "SidebarApp.vue")).href
);
const root = createEl("root");
createRenderer(nodeOps).createApp(SidebarApp).mount(root);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(50);

let failures = 0;
function check(condition, label, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `（${detail}）` : ""}`);
  }
}

function visibleRange() {
  const start = Math.floor(scrollContainer.scrollTop / ITEM_HEIGHT);
  return { start, end: start + Math.floor(VIEWPORT_HEIGHT / ITEM_HEIGHT) };
}

function isRowVisible(index) {
  const range = visibleRange();
  return range.start <= index && index < range.end;
}

function find(className, node = root) {
  if (node._class && node._class.includes(className)) return node;
  for (const child of node.children || []) {
    const found = find(className, child);
    if (found) return found;
  }
  return null;
}

/** 找到标题为 title 的那一行，返回它的 class 数组（用来确认高亮是否跟着切换）。 */
function rowClassOfTitle(title) {
  const walk = (node) => {
    if (node._class && node._class.includes("sb-title")) {
      // 纯文本子节点会走 hostSetElementText，落在 node.text 上；插值产生的文本节点落在 children 上。
      const text = node.text !== undefined
        ? node.text
        : (node.children || []).map((child) => child.text || "").join("");
      if (text === title) {
        let cursor = node.parent;
        while (cursor) {
          if (cursor._class && cursor._class.includes("sb-row")) return cursor._class;
          cursor = cursor.parent;
        }
      }
    }
    for (const child of node.children || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

console.log("场景 1：初始化（活动标签在第 24 行，远在视口之外）");
check(scrollContainer !== null, "滚动容器已挂载");
check(scrollContainer.scrollTop > 0, "列表不再是默认的顶部位置", `scrollTop=${scrollContainer.scrollTop}`);
check(
  isRowVisible(ACTIVE_INDEX),
  "活动标签落在可见区间里",
  `可见 ${visibleRange().start}..${visibleRange().end}，活动行 ${ACTIVE_INDEX}`
);

console.log("场景 2：点「新建标签页」（新标签在窗口末尾，事件先到、列表后刷新）");
{
  const before = scrollContainer.scrollTop;
  const button = find("sb-newtab");
  check(Boolean(button && typeof button.props.onClick === "function"), "找到底部新建按钮");
  button.props.onClick();
  await sleep(50);
  const lastRow = TAB_COUNT; // 追加的那一个（0 基行号 = 原行数）
  check(scrollContainer.scrollTop > before, "列表滚到了更靠下的位置", `${before} → ${scrollContainer.scrollTop}`);
  check(
    isRowVisible(lastRow),
    "新建的标签落在可见区间里",
    `可见 ${visibleRange().start}..${visibleRange().end}，新标签行 ${lastRow}`
  );
  // 防抖刷新（250ms）落地后不能把位置拉回去
  const after = scrollContainer.scrollTop;
  await sleep(400);
  check(scrollContainer.scrollTop === after, "防抖刷新后滚动位置保持不变", `${after} → ${scrollContainer.scrollTop}`);
}

console.log("场景 3：新活动行已经完整可见 → 不滚动，但高亮要跟上");
{
  const before = scrollContainer.scrollTop;
  // 第 55 行（标签 id 55）此刻在可见区间里、且不贴边
  check(isRowVisible(54), "目标行确实完整可见", `可见 ${visibleRange().start}..${visibleRange().end}`);
  for (const listener of listeners.activated) {
    listener({ tabId: 55, windowId: WINDOW_ID });
  }
  await sleep(50);
  check(scrollContainer.scrollTop === before, "列表没有被无意义地移动", `${before} → ${scrollContainer.scrollTop}`);
  const newActiveClass = rowClassOfTitle("标签 55");
  check(Boolean(newActiveClass && newActiveClass.includes("current")), "高亮切到了新的活动标签");
  const oldActiveClass = rowClassOfTitle("新建的标签页");
  check(Boolean(oldActiveClass && !oldActiveClass.includes("current")), "旧活动标签取消了高亮");
}

console.log("场景 4：旧活动标签已滚出视野时切换标签 → 不动");
{
  scrollContainer.scrollTop = 0; // 模拟用户自己滚到顶部
  const before = scrollContainer.scrollTop;
  for (const listener of listeners.activated) {
    listener({ tabId: 8, windowId: WINDOW_ID }); // 第 7 行，已知标签 → 走本地高亮
  }
  await sleep(50);
  check(scrollContainer.scrollTop === before, "列表没有被拉走", `${before} → ${scrollContainer.scrollTop}`);
}

console.log("");
console.log(failures === 0 ? "✓ 集成验证全部通过" : `✗ 集成验证失败 ${failures} 项`);
process.exitCode = failures === 0 ? 0 : 1;
