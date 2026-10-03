// 侧边栏与「打开的窗口」视图里"滚动位置自动跟随"的端到端回归测试。
//
// 为什么不满足于纯函数单测（scripts/test_scroll_markers.mjs）：这条链路由"chrome 事件 → 状态
// → watcher → 真实滚动容器"四段拼成，最容易坏的一环恰恰是中间的状态流转，而且坏掉时**不会**报错、
// 界面也没有异常，只是"列表不动"。真实案例：`applyActiveTab` 在遇到还没进列表的新标签时
// 把其它标签的活动标记一并清掉，"变化前的活动行"这条跟随依据被丢掉，于是新建标签后再也不跟随；
// 纯函数测试对此完全无感。
//
// 覆盖两处：侧边栏（跟随活动标签 + 跳转模式提交关键词后的显式滚动）、管理页「打开的窗口」（跳转模式同上）。
// 另外还覆盖侧边栏的**行内展示态**（发声/静音喇叭按钮、"需要关注"圆点）：它同样是
// "chrome 事件 → 本地增量补丁 → 重新渲染"这条链路。判定逻辑有纯函数测试（test_audio_state.mjs），
// 但"补丁有没有真的写进组件状态、有没有误触发整窗重查、点击有没有调到 tabs.update"只有把真组件跑起来才能验。
// 以及**普通模式下 Shift+点击 = 隐式进入多选**（区间起点是当前活动标签、不激活被点标签、
// 活动标签被过滤/跨区域时退化为只选中被点项）：这条链由"组件点击 → 父级开多选 → 区间计算 → 重新渲染"拼成，
// 正是最容易只改对一半的地方（例如开了多选却仍然激活了标签）。
// 做法：在 Node 里把**真实的** .vue 组件跑起来——用 vue/compiler-sfc 即时编译 .vue，
// 用 Vue 的 createRenderer 提供假 DOM（只实现 SidebarApp 真正用到的那点几何语义：
// clientHeight、scrollTop 及其夹取），再用假 chrome 控制标签列表与事件顺序。
import { computed, createRenderer, h, reactive } from "vue";
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

// 多选条占用的列表高度（真实侧边栏约 55–85px，即 2–3 行）。
// 假 DOM 不做布局，因此要手动模拟"多选条进/出 DOM 时列表视口变矮/变高"——这正是
// "选中最底部的标签后它们被多选条挤出视野"那条 bug 的触发条件，不模拟就测不到补偿逻辑。
const BULK_BAR_HEIGHT = 90;
let bulkBarMounted = false;

function isBulkBar(node) {
  return Boolean(node && node._class && node._class.includes("sb-bulk"));
}

function syncBulkBarLayout() {
  if (!scrollContainer) {
    return;
  }
  scrollContainer.clientHeight = VIEWPORT_HEIGHT - (bulkBarMounted ? BULK_BAR_HEIGHT : 0);
}

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
    if (isBulkBar(child)) {
      bulkBarMounted = true;
      syncBulkBarLayout();
    }
  },
  remove(child) {
    if (child.parent) {
      const index = child.parent.children.indexOf(child);
      if (index >= 0) child.parent.children.splice(index, 1);
    }
    child.parent = null;
    if (isBulkBar(child)) {
      bulkBarMounted = false;
      syncBulkBarLayout();
    }
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
      // 高度始终由 syncBulkBarLayout 统一给出，免得后续的 class 更新把多选条压小的高度冲掉。
      if (el._class.includes("virtual-scroller")) {
        scrollContainer = el;
        syncBulkBarLayout();
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
// tabs.update 的调用记录（展示态场景用它验证"点击喇叭 = 一次 tabs.update"）。
const updateCalls = [];
// 发往后台的消息动作（展示态场景用它验证"点喇叭不会走 activateTab"）。
const messageLog = [];
const diagnosticMode = process.argv.includes('--diagnostics');
const diagnosticMessages = [];
let diagnosticStructure = { parents: {}, revision: 1, revisionToken: 'test-ui' };
let heldStructureResponses = null;
// 整窗查询次数：展示态变化只要走了"整窗重查"这条错路，计数就会露馅。
let queryCount = 0;

/** 返回副本：侧边栏会就地改 active 标记，不能让"假浏览器"的状态被它改掉。 */
function snapshot() {
  return browserTabs.map((tab) => ({ ...tab }));
}

/** 假事件对象：addListener / removeListener 都要有，否则组件卸载时清理监听会抛错。 */
function makeEvent(store) {
  return {
    addListener: (listener) => store.push(listener),
    removeListener: (listener) => {
      const index = store.indexOf(listener);
      if (index >= 0) store.splice(index, 1);
    },
  };
}

function sendMessage(message, callback) {
  const action = message && message.action;
  messageLog.push(action);
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
    if (heldStructureResponses) heldStructureResponses.push(callback);
    else callback({ ok: true, structures: { [WINDOW_ID]: diagnosticStructure } });
    return;
  }
  if (action === 'recordTreeDiagnostics') {
    diagnosticMessages.push(...message.events);
    callback({ ok: true });
    return;
  }
  if (action === 'getTreeDebugStatus') {
    callback({ ok: true, status: { enabled: diagnosticMode, incidentCount: 0 } });
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
    local: { get: (key, cb) => cb(diagnosticMode && key === 'treeDebugConfig' ? { treeDebugConfig: { enabled: true, printTree: true } } : {}), set: (_obj, cb) => cb && cb() },
    session: { get: (_key, cb) => cb({}), set: (_obj, cb) => cb && cb() },
    onChanged: makeEvent([]),
  },
  tabs: {
    query(info, callback) {
      queryCount += 1;
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
    // 回调参数按真实 API 的形状给：tabs.update 的回调收到的是更新后的 Tab（静音状态在 mutedInfo 里）。
    update(tabId, props, callback) {
      updateCalls.push({ tabId, props });
      if (callback) {
        callback({ id: tabId, mutedInfo: { muted: Boolean(props && props.muted) } });
      }
    },
    onCreated: makeEvent(listeners.created),
    onActivated: makeEvent(listeners.activated),
    onUpdated: makeEvent(listeners.updated),
    onRemoved: makeEvent(listeners.removed),
    onMoved: makeEvent([]),
    onAttached: makeEvent([]),
    onDetached: makeEvent([]),
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
const sidebarApp = createRenderer(nodeOps).createApp(SidebarApp);
sidebarApp.mount(root);

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

function visibleRange(itemHeight = ITEM_HEIGHT) {
  const start = Math.floor(scrollContainer.scrollTop / itemHeight);
  return { start, end: start + Math.floor(VIEWPORT_HEIGHT / itemHeight) };
}

function isRowVisible(index, itemHeight = ITEM_HEIGHT) {
  const range = visibleRange(itemHeight);
  return range.start <= index && index < range.end;
}

/**
 * 该行此刻是否**完整**落在真实视口里。
 * 视口高度取容器当前值（会被多选条压小），不能再用 VIEWPORT_HEIGHT——这正是要验证的点。
 */
function isRowFullyVisible(index, itemHeight = ITEM_HEIGHT) {
  const top = index * itemHeight;
  const bottom = top + itemHeight;
  const viewportBottom = scrollContainer.scrollTop + scrollContainer.clientHeight;
  return top >= scrollContainer.scrollTop && bottom <= viewportBottom;
}

function find(className, node = root) {
  if (node._class && node._class.includes(className)) return node;
  for (const child of node.children || []) {
    const found = find(className, child);
    if (found) return found;
  }
  return null;
}

/** 按标签名找元素（搜索框是 <input>，没有可用的 class）。 */
function findByTag(tag, node = root) {
  if (node.tag === tag) return node;
  for (const child of node.children || []) {
    const found = findByTag(tag, child);
    if (found) return found;
  }
  return null;
}

/** 按纯文本找按钮（「过滤 / 跳转」两个按钮没有各自的 class）。 */
function findButtonByText(text, node = root) {
  // 模板里的换行会被"压缩空白"保留成单个空格，这里按 trim 后比较
  if (node.tag === "button" && String(node.text || "").trim() === text) return node;
  for (const child of node.children || []) {
    const found = findButtonByText(text, child);
    if (found) return found;
  }
  return null;
}

/** 收集所有带指定 class 的节点（按文档顺序），用于固定标签方块等"同类元素有多个"的断言。 */
function collect(className, node = root, result = []) {
  if (node._class && node._class.includes(className)) result.push(node);
  for (const child of node.children || []) collect(className, child, result);
  return result;
}

/** 取节点的纯文本：插值产生的文本可能落在 children 上，整段文本也可能直接落在 node.text 上。 */
function nodeText(node) {
  if (!node) return "";
  if (node.text !== undefined) return node.text;
  return (node.children || []).map((child) => child.text || "").join("");
}

/** 按标题找到那一行的 DOM 节点（多选测试要直接调用它的点击处理，只拿 class 不够）。 */
function rowNodeOfTitle(title) {
  const walk = (node) => {
    if (node._class && node._class.includes("sb-title")) {
      // 纯文本子节点会走 hostSetElementText，落在 node.text 上；插值产生的文本节点落在 children 上。
      const text = node.text !== undefined
        ? node.text
        : (node.children || []).map((child) => child.text || "").join("");
      if (text === title) {
        let cursor = node.parent;
        while (cursor) {
          if (cursor._class && cursor._class.includes("sb-row")) return cursor;
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

/** 找到标题为 title 的那一行，返回它的 class 数组（用来确认高亮/选中是否跟着切换）。 */
function rowClassOfTitle(title) {
  const node = rowNodeOfTitle(title);
  return node ? node._class : null;
}

/** 标题为 title 的行是否带某个状态 class（行没被渲染时返回 false，而不是抛错）。 */
function rowHasClass(title, className) {
  const classes = rowClassOfTitle(title);
  return Boolean(classes && classes.includes(className));
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

console.log("场景 5：停在固定标签上按 Ctrl+T → 跟随到新标签");
{
  // 固定标签追加到窗口里：先广播 onCreated，再由防抖整窗刷新带进列表（真实顺序）
  const pinned = {
    id: 777,
    windowId: WINDOW_ID,
    index: browserTabs.length,
    active: true,
    pinned: true,
    title: "固定标签",
    url: "https://pinned.example",
  };
  browserTabs = browserTabs.map((tab) => ({ ...tab, active: false })).concat([pinned]);
  for (const listener of listeners.created) {
    listener({ id: pinned.id, windowId: WINDOW_ID });
  }
  for (const listener of listeners.activated) {
    listener({ tabId: pinned.id, windowId: WINDOW_ID });
  }
  await sleep(400); // 等防抖刷新把固定标签带进列表
  const before = scrollContainer.scrollTop;
  check(before === 0, "停在固定标签上时列表没有被动过", `scrollTop=${before}`);

  // Ctrl+T：浏览器自己新建并激活标签，侧边栏只收到事件（没有我们的后台消息）
  const ctrlT = {
    id: 1000,
    windowId: WINDOW_ID,
    index: browserTabs.length,
    active: true,
    pinned: false,
    title: "Ctrl+T 新标签",
    url: "about:newtab",
  };
  browserTabs = browserTabs.map((tab) => ({ ...tab, active: false })).concat([ctrlT]);
  for (const listener of listeners.created) {
    listener({ id: ctrlT.id, windowId: WINDOW_ID });
  }
  for (const listener of listeners.activated) {
    listener({ tabId: ctrlT.id, windowId: WINDOW_ID });
  }
  await sleep(400);

  // 固定标签不占行，所以新标签是非固定标签里的最后一行
  const lastRow = browserTabs.filter((tab) => !tab.pinned).length - 1;
  check(scrollContainer.scrollTop > before, "列表跟着滚了下去", `${before} → ${scrollContainer.scrollTop}`);
  check(
    isRowVisible(lastRow),
    "新标签落在可见区间里",
    `可见 ${visibleRange().start}..${visibleRange().end}，新标签行 ${lastRow}`
  );
}

console.log("场景 6：跳转模式下输入能匹配到的关键词 → 直接跳到匹配项");
{
  const jumpButton = findButtonByText("跳转");
  check(Boolean(jumpButton && typeof jumpButton.props.onClick === "function"), "找到「跳转」模式按钮");
  jumpButton.props.onClick();
  await sleep(50);
  // 把视野挪回顶部：这样"跳转"如果真的发生，滚动位置一定会变
  scrollContainer.scrollTop = 0;
  const before = scrollContainer.scrollTop;

  const input = findByTag("input");
  check(Boolean(input && typeof input.props.onInput === "function"), "找到搜索框");
  input.props.onInput({ target: { value: "标签 55" } });
  await sleep(400); // FilterInput 的 250ms 防抖 + 渲染

  const targetRow = 54; // 标签 55 在非固定标签行序列里的行号
  check(scrollContainer.scrollTop > before, "列表滚动了", `${before} → ${scrollContainer.scrollTop}`);
  check(
    isRowVisible(targetRow),
    "匹配项落在可见区间里",
    `可见 ${visibleRange().start}..${visibleRange().end}，匹配行 ${targetRow}`
  );
}

console.log("场景 7：滚动同步改写了当前项，但绝不能反过来把列表拉回去");
{
  // 换一个匹配项分散在列表里的关键词（标签 5 与 标签 50–59，共 11 项）：
  // 这样"滚到别处"时可见范围里一定有别的匹配项，会触发滚动同步改写当前项。
  // 注意这里不断言"跳到第几个匹配"——当前项由 useMatchNavigation 重置 + 滚动同步共同决定，
  // 只保证提交关键词后视野里一定有匹配项（这正是用户要的效果）。
  const input = findByTag("input");
  input.props.onInput({ target: { value: "标签 5" } });
  await sleep(400);
  check(
    isRowVisible(4) || isRowVisible(49),
    "提交关键词后视野里有匹配项",
    `可见 ${visibleRange().start}..${visibleRange().end}（匹配行 4 与 49..58）`
  );

  // 模拟用户自己往下滚：直接改滚动位置并派发 scroll（虚拟列表据此重算可见区间）
  scrollContainer.scrollTop = 1200;
  scrollContainer.props.onScroll();
  await sleep(50);
  check(
    scrollContainer.scrollTop === 1200,
    "用户滚到别处后没有被拉回匹配项",
    `scrollTop=${scrollContainer.scrollTop}`
  );
}

console.log("场景 8：行内展示态（发声/静音/关注）走本地增量补丁——不重查、点了不跳转");
{
  // 挑一个**当前可见**的行来改状态：虚拟列表只渲染可见行，改看不见的行观察不到渲染结果。
  const nonPinned = browserTabs.filter((tab) => !tab.pinned);
  const rowIndex = visibleRange().start + 1;
  const target = nonPinned[rowIndex];
  check(Boolean(target), "观察对象落在可见区间里", `行 ${rowIndex}`);

  console.log("  8.1 开始发声 → 只改本地对象，不排整窗刷新");
  const queriesBefore = queryCount;
  for (const listener of listeners.updated) {
    listener(target.id, { audible: true }, { ...target, audible: true });
  }
  await sleep(60);
  const audioButton = find("sb-audio");
  check(Boolean(audioButton), "发声标签行渲染出喇叭按钮");
  check(queryCount === queriesBefore, "发声变化没有触发整窗重查", `查询次数 ${queriesBefore} → ${queryCount}`);
  check(Boolean(audioButton && audioButton.props.title === "静音此标签页"), "未静音时提示「静音此标签页」");

  console.log("  8.2 点喇叭 → 一次 tabs.update，且不激活标签");
  const updatesBefore = updateCalls.length;
  const messagesBefore = messageLog.length;
  audioButton.props.onClick({ stopPropagation() {} });
  await sleep(60);
  check(
    updateCalls.length === updatesBefore + 1 &&
      updateCalls[updatesBefore].tabId === target.id &&
      updateCalls[updatesBefore].props.muted === true,
    "点击喇叭 → tabs.update({ muted: true })",
    JSON.stringify(updateCalls.slice(updatesBefore))
  );
  check(!messageLog.slice(messagesBefore).includes("activateTab"), "点击喇叭不会激活/跳转该标签");
  const mutedButton = find("sb-audio");
  check(
    Boolean(mutedButton && mutedButton._class.includes("muted")),
    "乐观补丁让按钮立刻变成「已静音」样式"
  );
  check(Boolean(mutedButton && mutedButton.props.title === "取消静音"), "已静音时提示「取消静音」");

  console.log("  8.3 在别处取消静音 → onUpdated 把侧边栏同步回去，并且没有重查");
  const queriesBeforeUnmute = queryCount;
  for (const listener of listeners.updated) {
    listener(
      target.id,
      { audible: false, mutedInfo: { muted: false } },
      { ...target, audible: false, mutedInfo: { muted: false } }
    );
  }
  await sleep(60);
  check(find("sb-audio") === null, "既无声也未静音后按钮消失（不占位）");
  check(queryCount === queriesBeforeUnmute, "取消静音同样没有触发整窗重查");

  console.log("  8.4 需要关注 → 圆点出现/消失同样只走本地补丁");
  const queriesBeforeAttention = queryCount;
  for (const listener of listeners.updated) {
    listener(target.id, { attention: true }, { ...target, attention: true });
  }
  await sleep(60);
  check(Boolean(find("sb-attention")), "attention=true 时标题左侧出现关注圆点");
  for (const listener of listeners.updated) {
    listener(target.id, { attention: false }, { ...target, attention: false });
  }
  await sleep(60);
  check(find("sb-attention") === null, "attention 清除后圆点消失");
  check(queryCount === queriesBeforeAttention, "关注状态变化没有触发整窗重查");

  console.log("  8.5 固定标签的静音圆点读的是同一份数据（回归：曾经读 tab.muted 恒为 undefined）");
  const pinnedTab = browserTabs.find((tab) => tab.pinned);
  check(Boolean(pinnedTab), "存在一个固定标签用于观察");
  for (const listener of listeners.updated) {
    listener(pinnedTab.id, { mutedInfo: { muted: true } }, { ...pinnedTab, mutedInfo: { muted: true } });
  }
  await sleep(60);
  check(Boolean(find("sb-pin-muted")), "固定标签被静音后出现静音圆点");
  for (const listener of listeners.updated) {
    listener(pinnedTab.id, { mutedInfo: { muted: false } }, { ...pinnedTab, mutedInfo: { muted: false } });
  }
  await sleep(60);
  check(find("sb-pin-muted") === null, "取消静音后圆点消失");
}

console.log("场景 8.6：普通模式下 Shift+点击 → 自动进入多选、选中区间，并补偿多选条压小的视口");
{
  // 此刻活动标签是「Ctrl+T 新标签」（非固定标签的最后一行）；把视野挪到列表底部，
  // 让活动行与目标行都真的被虚拟列表渲染出来（虚拟列表只渲染可见区间）。
  const treeRowCount = browserTabs.filter((tab) => !tab.pinned).length;
  scrollContainer.scrollTop = treeRowCount * ITEM_HEIGHT; // 会被夹取到最大滚动位置
  scrollContainer.props.onScroll();
  await sleep(60);
  const bottomBefore = scrollContainer.scrollTop + scrollContainer.clientHeight;
  check(isRowFullyVisible(61), "点击前最后一行完整可见", `scrollTop=${scrollContainer.scrollTop}`);

  check(find("sb-bulk") === null, "普通模式下没有批量操作条");
  const messagesBefore = messageLog.length;

  const targetRow = rowNodeOfTitle("标签 60"); // 非固定标签的第 59 行
  check(Boolean(targetRow && typeof targetRow.props.onClick === "function"), "找到区间终点行「标签 60」");
  if (targetRow) targetRow.props.onClick({ shiftKey: true });
  await sleep(60);

  const multiButton = findButtonByText("多选");
  check(Boolean(find("sb-bulk")), "Shift+点击后自动出现批量操作条（已进入多选模式）");
  check(Boolean(multiButton && multiButton._class.includes("active")), "工具栏「多选」按钮同步点亮");
  // 活动标签在第 61 行、被点项在第 59 行 → 第 59..61 行全部选中
  check(rowHasClass("标签 60", "selected"), "区间终点行被选中");
  check(rowHasClass("新建的标签页", "selected"), "区间中间行被选中");
  check(rowHasClass("Ctrl+T 新标签", "selected"), "区间起点（活动标签）被选中");
  check(!rowHasClass("标签 46", "selected"), "区间之外、同样可见的行不受影响");
  check(rowHasClass("Ctrl+T 新标签", "current"), "被点标签没有被激活（活动标记仍在原标签上）");
  check(!messageLog.slice(messagesBefore).includes("activateTab"), "Shift+点击不会激活/跳转标签");
  check(nodeText(find("sb-bulk-count")) === "已选 3 项", "批量条显示「已选 3 项」", nodeText(find("sb-bulk-count")));

  // 多选条把列表视口压小了（假 DOM 里 600 → 510）。修复前 scrollTop 不动，最下面几行直接落到
  // 视口之外（虚拟列表也不再渲染它们）；现在应"底边锚定"，且选中的 3 行完整可见。
  check(scrollContainer.clientHeight === VIEWPORT_HEIGHT - BULK_BAR_HEIGHT, "多选条确实压小了列表视口");
  check(
    scrollContainer.scrollTop + scrollContainer.clientHeight === bottomBefore,
    "底边锚定：视口下边缘的内容坐标保持不变",
    `${scrollContainer.scrollTop} + ${scrollContainer.clientHeight}`
  );
  check(isRowFullyVisible(59) && isRowFullyVisible(60) && isRowFullyVisible(61), "选中的三行都完整落在视口里");
}

console.log("场景 8.7：再次 Shift+点击 → 锚点回到被点项，可继续扩选");
{
  // 补偿后视野停在列表底部，先像真实用户那样往上滚一点，才能点到第 42 行。
  scrollContainer.scrollTop = 1260;
  scrollContainer.props.onScroll();
  await sleep(60);
  const row = rowNodeOfTitle("标签 43"); // 第 42 行
  check(Boolean(row && typeof row.props.onClick === "function"), "找到新的终点行「标签 43」");
  if (row) row.props.onClick({ shiftKey: true });
  await sleep(60);
  check(rowHasClass("标签 43", "selected"), "第二次 Shift+点击的终点被选中");
  check(rowHasClass("Ctrl+T 新标签", "selected"), "并集语义：上一次区间仍然保留");
  check(
    nodeText(find("sb-bulk-count")) === "已选 20 项",
    "第 42..61 行共 20 项（不是从活动标签重算）",
    nodeText(find("sb-bulk-count"))
  );
  check(scrollContainer.scrollTop === 1260, "已在多选模式里的普通扩选不再改动滚动位置");
}

console.log("场景 8.8：区间长过视口 → 视口落在区间内部，被点行仍完整可见");
{
  findButtonByText("多选").props.onClick(); // 退出多选模式（同时清空选择）
  await sleep(60);
  check(find("sb-bulk") === null, "退出多选后批量操作条消失");
  check(scrollContainer.clientHeight === VIEWPORT_HEIGHT, "视口高度随多选条消失而恢复");

  // 把活动标签切到第 5 行（标签 6）：从它到最后一行的区间长过视口，不可能整段可见。
  for (const listener of listeners.activated) {
    listener({ tabId: 6, windowId: WINDOW_ID });
  }
  await sleep(60);
  scrollContainer.scrollTop = 1350; // 会被夹到当时的最大滚动位置（列表底部）
  scrollContainer.props.onScroll();
  await sleep(60);
  const bottomBefore = scrollContainer.scrollTop + scrollContainer.clientHeight;

  const targetRow = rowNodeOfTitle("Ctrl+T 新标签"); // 第 61 行
  check(Boolean(targetRow && typeof targetRow.props.onClick === "function"), "找到区间终点行「Ctrl+T 新标签」");
  if (targetRow) targetRow.props.onClick({ shiftKey: true });
  await sleep(60);

  check(nodeText(find("sb-bulk-count")) === "已选 57 项", "第 5..61 行共 57 项", nodeText(find("sb-bulk-count")));
  check(isRowFullyVisible(61), "被点行（区间终点）完整可见");
  check(
    scrollContainer.scrollTop + scrollContainer.clientHeight === bottomBefore,
    "底边锚定后视口仍贴着列表底部",
    `${scrollContainer.scrollTop} + ${scrollContainer.clientHeight}`
  );
  // 区间长过视口时的最优解：视口完全落在区间内部（可见的选中行最多）。
  const totalRows = browserTabs.filter((tab) => !tab.pinned).length;
  check(
    scrollContainer.scrollTop >= 5 * ITEM_HEIGHT &&
      scrollContainer.scrollTop + scrollContainer.clientHeight <= totalRows * ITEM_HEIGHT,
    "视口完全落在选中区间内部",
    `scrollTop=${scrollContainer.scrollTop}`
  );
}

console.log("场景 8.9：活动标签被过滤隐藏 → 退化为只选中被点项");
{
  findButtonByText("多选").props.onClick(); // 退出多选模式（同时清空选择）
  await sleep(60);
  check(find("sb-bulk") === null, "退出多选后批量操作条消失");

  findButtonByText("过滤").props.onClick();
  await sleep(60);
  const input = findByTag("input");
  check(Boolean(input && typeof input.props.onInput === "function"), "找到搜索框");
  input.props.onInput({ target: { value: "标签 1" } }); // 只匹配「标签 1」「标签 10..19」，活动标签不在其中
  await sleep(400);
  scrollContainer.scrollTop = 0;
  scrollContainer.props.onScroll();
  await sleep(60);

  const row = rowNodeOfTitle("标签 10");
  check(Boolean(row && typeof row.props.onClick === "function"), "过滤后目标行「标签 10」仍然渲染");
  const messagesBefore = messageLog.length;
  if (row) row.props.onClick({ shiftKey: true });
  await sleep(60);
  check(Boolean(find("sb-bulk")), "活动标签不可见时仍然会进入多选模式");
  check(
    nodeText(find("sb-bulk-count")) === "已选 1 项",
    "活动标签不在渲染顺序里 → 只选中被点项",
    nodeText(find("sb-bulk-count"))
  );
  check(!messageLog.slice(messagesBefore).includes("activateTab"), "依然不激活标签");
}

console.log("场景 8.10：固定标签方块同样支持隐式进入多选");
{
  findButtonByText("多选").props.onClick(); // 回到普通模式
  await sleep(60);
  findButtonByText("跳转").props.onClick();
  const input = findByTag("input");
  input.props.onInput({ target: { value: "" } }); // 清空关键词，恢复完整列表
  await sleep(400);
  // 把活动标签切到固定标签上（浏览器事件 → 侧边栏本地打补丁，不触发整窗重查）
  for (const listener of listeners.activated) {
    listener({ tabId: 777, windowId: WINDOW_ID });
  }
  await sleep(60);
  scrollContainer.scrollTop = 0;
  scrollContainer.props.onScroll();
  await sleep(60);

  check(find("sb-bulk") === null, "仍是普通模式");
  const messagesBefore = messageLog.length;
  const pin = find("sb-pin");
  check(Boolean(pin && typeof pin.props.onClick === "function"), "找到固定标签方块");
  if (pin) pin.props.onClick({ shiftKey: true });
  await sleep(60);
  const pinAfter = find("sb-pin");
  check(Boolean(find("sb-bulk")), "Shift+点击固定方块同样自动进入多选");
  check(Boolean(pinAfter && pinAfter._class.includes("selected")), "活动固定方块被选中（锚点就在固定区序列里）");
  check(!rowHasClass("标签 5", "selected"), "树区域的行没有被牵连选中");
  check(!messageLog.slice(messagesBefore).includes("activateTab"), "固定方块没有被激活");
  // 被点项不在滚动列表里，此时只做底边锚定：视口下边缘的内容坐标不变。
  check(
    scrollContainer.scrollTop + scrollContainer.clientHeight === VIEWPORT_HEIGHT,
    "固定区入口只做底边锚定",
    `${scrollContainer.scrollTop} + ${scrollContainer.clientHeight}`
  );
}

console.log("场景 8.11：活动标签与被点项分处两区 → 只选中被点项");
{
  findButtonByText("多选").props.onClick(); // 回到普通模式
  await sleep(60);
  scrollContainer.scrollTop = 0;
  scrollContainer.props.onScroll();
  await sleep(60);
  const messagesBefore = messageLog.length;

  const row = rowNodeOfTitle("标签 5");
  check(Boolean(row && typeof row.props.onClick === "function"), "找到树区域目标行「标签 5」");
  if (row) row.props.onClick({ shiftKey: true });
  await sleep(60);
  check(Boolean(find("sb-bulk")), "仍然进入多选模式");
  check(
    nodeText(find("sb-bulk-count")) === "已选 1 项",
    "活动标签（固定标签）不在树区域序列里 → 只选中被点项",
    nodeText(find("sb-bulk-count"))
  );
  check(rowHasClass("标签 5", "selected"), "被点的树行被选中");
  const pinAfter = find("sb-pin");
  check(Boolean(pinAfter && !pinAfter._class.includes("selected")), "固定标签方块没有被选中");
  check(!messageLog.slice(messagesBefore).includes("activateTab"), "依然不激活标签");
  check(isRowFullyVisible(4), "被点行在补偿后仍完整可见（视口顶部越界不会把它顶出去）");
}

if (diagnosticMode) {
  console.log('诊断场景：真实侧边栏 watcher 在标签删除与父映射响应之间不累计异常包');
  const { getTreeDiagnostics } = await import('../src/manager/utils/tree_diagnostics.js');
  const client = getTreeDiagnostics();
  browserTabs = [101, 102, 103].map((id, index) => ({ id, index, windowId: WINDOW_ID,
    title: `诊断样本 ${id}`, url: `https://example.com/${id}`, active: index === 0, pinned: false }));
  diagnosticStructure = { parents: { 102: 101, 103: 102 }, revision: 2, revisionToken: 'test-ui' };
  for (const listener of listeners.created) listener(browserTabs[0]);
  await sleep(350);
  await client.flush();
  diagnosticMessages.length = 0;
  heldStructureResponses = [];
  browserTabs = browserTabs.filter(tab => tab.id !== 102).map((tab, index) => ({ ...tab, index }));
  for (const listener of listeners.removed) listener(102, { windowId: WINDOW_ID, isWindowClosing: false });
  await sleep(350);
  await client.flush();
  check(heldStructureResponses.length > 0, '实际标签查询已应用，结构响应确实被暂停');
  check(diagnosticMessages.some(item => item.payload.classification === 'pending'), '真实 watcher 观察到处理中悬空父');
  check(!diagnosticMessages.some(item => item.kind === 'incident'), '处理中暂态没有累计异常包');
  diagnosticStructure = { parents: { 103: 101 }, revision: 3, revisionToken: 'test-ui',
    diagnosticContext: { revision: 3, pending: false, operations: [{ type: 'close', correlationId: 'close-102',
      registered: true, phase: 'complete', focusIds: [102], expectedParents: [{ childId: 103, parentId: 101 }],
      revisionBefore: 2, revision: 3 }] } };
  const callbacks = heldStructureResponses;
  heldStructureResponses = null;
  for (const callback of callbacks) callback({ ok: true, structures: { [WINDOW_ID]: diagnosticStructure } });
  await sleep(50);
  await client.flush();
  check(!diagnosticMessages.some(item => item.kind === 'incident'), '父映射对齐后正常提升仍不产生异常提示');


  console.log('诊断场景：后台实例切换丢失登记，真实关闭监听仍能解释正确继承');
  browserTabs = [201,202,203,204,205,206].map((id,index) => ({ id,index,windowId:WINDOW_ID,
    title:`诊断样本 ${id}`,url:`https://example.com/${id}`,active:index===0,pinned:false }));
  diagnosticStructure = { parents:{202:201,203:202,204:203,205:202,206:201},revision:4,revisionToken:'test-ui' };
  for(const listener of listeners.created) listener(browserTabs[0]);
  await sleep(350);
  await client.flush();
  diagnosticMessages.length=0;
  heldStructureResponses=[];
  browserTabs=browserTabs.filter(tab=>tab.id!==202).map((tab,index)=>({...tab,index}));
  for(const listener of listeners.removed) listener(202,{windowId:WINDOW_ID,isWindowClosing:false});
  await sleep(350);
  await client.flush();
  check(heldStructureResponses.length>0,'跨实例场景确实经过结构响应间隙');
  diagnosticStructure={parents:{203:201,204:203,205:203,206:201},revision:1,revisionToken:'test-ui-restarted'};
  const restartedCallbacks=heldStructureResponses;
  heldStructureResponses=null;
  for(const callback of restartedCallbacks) callback({ok:true,structures:{[WINDOW_ID]:diagnosticStructure}});
  await sleep(50);
  await client.flush();
  check(!diagnosticMessages.some(item=>item.kind==='incident'),'跨实例正常关闭不会积累异常包');
  check(diagnosticMessages.some(item=>item.payload.observation?.operations?.some(
    operation=>operation.explanation==='observed-removal')),'实际侧边栏使用完整物理序列与真实关闭事件解释继承');
}

console.log("场景 9：管理页「打开的窗口」跳转模式下输入关键词 → 同样要跳转");
{
  // 侧边栏那套已经跑完，先卸载：两个应用都靠同一个 scrollContainer 变量记录滚动容器。
  sidebarApp.unmount();
  await sleep(20);

  // 真实应用里 windowRows 的 matched 由 App.vue 按关键词算好，这里按同一口径现算。
  const baseRows = Array.from({ length: 60 }, (_, index) => ({
    type: "tab",
    tab: {
      id: index + 1,
      windowId: WINDOW_ID,
      title: `标签 ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      active: index === 0,
      pinned: false,
    },
  }));
  const managerState = reactive({ committed: "" });
  const managerRows = computed(() =>
    baseRows.map((row) => ({
      ...row,
      tab: {
        ...row.tab,
        matched: Boolean(managerState.committed) && row.tab.title.includes(managerState.committed),
      },
    }))
  );

  const { default: WindowsView } = await import(
    pathToFileURL(path.join(here, "..", "src", "manager", "views", "WindowsView.vue")).href
  );
  const managerRoot = createEl("root");
  const Host = {
    render: () =>
      h(WindowsView, {
        windowSubtitle: "窗口 1",
        selectedWindowId: 1,
        windowRows: managerRows.value,
        filterMode: "jump",
        filterQuery: managerState.committed,
        committedFilterQuery: managerState.committed,
      }),
  };
  createRenderer(nodeOps).createApp(Host).mount(managerRoot);
  await sleep(50);

  const MANAGER_ITEM_HEIGHT = 44;
  scrollContainer.scrollTop = 0;
  const before = scrollContainer.scrollTop;
  managerState.committed = "标签 55"; // 只匹配第 55 行（标签 55），远在视口之外
  await sleep(50);

  check(scrollContainer.scrollTop > before, "提交关键词后列表滚动了", `${before} → ${scrollContainer.scrollTop}`);
  check(
    isRowVisible(54, MANAGER_ITEM_HEIGHT),
    "匹配行落在可见区间里",
    `可见 ${visibleRange(MANAGER_ITEM_HEIGHT).start}..${visibleRange(MANAGER_ITEM_HEIGHT).end}`
  );
}

console.log("");
console.log(failures === 0 ? "✓ 集成验证全部通过" : `✗ 集成验证失败 ${failures} 项`);
process.exitCode = failures === 0 ? 0 : 1;
