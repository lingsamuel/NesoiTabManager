import { manualDiscard } from "./discard.js";
import {
  closeTabsAsGroup,
  hasRestorableGroup,
  restoreClosedGroup,
} from "./closed_groups.js";
import { getLists, saveCurrentTab } from "./lists.js";
import { isTabMuted } from "./utils.js";

// 右键菜单分两类：
// 1. `contexts: ["page"]`：网页右键里的「保存到列表 / 关闭并保存到列表」，沿用原有行为；
// 2. `contexts: ["tab"]`：标签操作（刷新/固定/静音/冻结/复制链接/移动到窗口），供 Firefox 侧边栏
//    通过 `menus.overrideContext({ context: "tab", tabId })` 以**原生菜单外壳**呈现。
//
// 关于第 2 类为什么必须自己注册：`overrideContext` 的语义是隐藏所有默认 Firefox 菜单项，
// 只渲染"本扩展与其它扩展注册到该上下文的项"（见 Mozilla 关于 Firefox 64 的说明与 MDN），
// 它带来的是原生菜单外观/键盘导航/自动合并其它扩展项，而不是原生菜单内容。
// Tree Style Tab 的 background/tab-context-menu.js 同样是自建了这一整套项。

// 侧边栏是 Firefox 专有实现；另外"复制链接"依赖后台页面的 DOM（Chrome 的 MV3 service worker 没有 DOM），
// 因此这组 tab 菜单项只在 Firefox 注册，避免在 Chrome 上出现点不动的项。
const IS_FIREFOX = typeof chrome.sidebarAction !== "undefined";

const TAB_ITEM = {
  reload: "nesoi-tab:reload",
  pin: "nesoi-tab:pin",
  mute: "nesoi-tab:mute",
  discard: "nesoi-tab:discard",
  // 「复制标题」必须排在「复制链接」之前（顺序即显示顺序），见 createTabItems。
  copyTitle: "nesoi-tab:copyTitle",
  copyUrl: "nesoi-tab:copyUrl",
  // 保存到列表的两个子菜单（与网页右键同构）。contextMenus 的 id 全局唯一，
  // 因此即使 contexts 不同，也不能和网页右键的 `saveTo` / `save:xxx` 重名。
  saveToList: "nesoi-tab:saveTo",
  saveCloseToList: "nesoi-tab:saveCloseTo",
  savePrefix: "nesoi-tab-save:",
  saveClosePrefix: "nesoi-tab-saveClose:",
  moveTo: "nesoi-tab:moveTo",
  moveToNew: "nesoi-tab:moveTo:new",
  moveToWindowPrefix: "nesoi-tab:moveTo:win:",
  // 撤销关闭：前者是"一组关闭"的来源（关闭该标签及其全部后代），后者是它的逆操作。
  closeTree: "nesoi-tab:closeTree",
  undoCloseGroup: "nesoi-tab:undoCloseGroup",
};

// 每个窗口一个子项，窗口增删时需要精确重建。
let moveToWindowItems = [];
// 上一次应用过的"期望菜单状态"签名。
// menus.refresh() 会让 onShown 再次触发，因此必须只在状态真的变化时才写回并刷新，
// 否则会形成 onShown → update → refresh → onShown 的死循环。
let lastTabMenuSignature = "";

// 侧边栏推来的"当前选中项"，供「复制标题 / 复制链接」输出多行。
//
// 为什么需要它：原生菜单的 onClicked 只拿得到**被右键的那一个标签**，后台完全不知道
// 侧边栏的选中集合，所以多行复制必须由侧边栏在弹出菜单前主动推来（`setCopySelection`）。
// 这里只做暂存与一次性消费，TTL 是兜底（正常路径由 menus.onHidden 与"复制后立即清空"负责）。
const COPY_SELECTION_TTL_MS = 10000;
let copySelection = null;

function clearActionPopup() {
  if (chrome.action && chrome.action.setPopup) {
    chrome.action.setPopup({ popup: "" });
  }
}

function menuCreate(options) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(options, () => {
      // 创建失败（例如同 id 已存在）不该打断其它项，这里吞掉 lastError。
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function menuRemove(itemId) {
  return new Promise((resolve) => {
    chrome.contextMenus.remove(itemId, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function menuUpdate(itemId, changes) {
  return new Promise((resolve) => {
    chrome.contextMenus.update(itemId, changes, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function getAllWindows() {
  return new Promise((resolve) => {
    chrome.windows.getAll((windows) => resolve(Array.isArray(windows) ? windows : []));
  });
}

// ---------------------------------------------------------------------------
// 「保存到列表 / 关闭并保存到列表」子菜单（网页右键与标签右键共用）
// ---------------------------------------------------------------------------

/**
 * 创建一对「保存到列表 / 关闭并保存到列表」子菜单。
 *
 * 网页右键与标签右键（Firefox 侧边栏右键、浏览器标签栏右键共用同一份 `contexts: ["tab"]` 注册）
 * 的菜单结构、子项来源、执行路径完全相同，因此抽成一个函数统一生成；
 * 两处必须传不同的 id 前缀：`contextMenus` 的 id 是全局唯一的，跨 contexts 也不能重名。
 *
 * @param {Array<{id:string,name:string}>} lists 现有列表
 * @param {{parentId:string, parentIdClose:string, itemPrefix:string, itemPrefixClose:string,
 *          emptyId:string, emptyIdClose:string, contexts:string[]}} options
 */
function createSaveToListItems(lists, options) {
  const { parentId, parentIdClose, itemPrefix, itemPrefixClose, emptyId, emptyIdClose, contexts } =
    options;

  chrome.contextMenus.create({ id: parentId, title: "保存到列表", contexts });
  chrome.contextMenus.create({ id: parentIdClose, title: "关闭并保存到列表", contexts });

  if (lists.length === 0) {
    // 无列表时给出明确的禁用项，而不是让子菜单空着——空子菜单在原生菜单里几乎点不开也看不懂。
    chrome.contextMenus.create({
      id: emptyId,
      title: "暂无列表",
      parentId,
      contexts,
      enabled: false,
    });
    chrome.contextMenus.create({
      id: emptyIdClose,
      title: "暂无列表",
      parentId: parentIdClose,
      contexts,
      enabled: false,
    });
    return;
  }

  lists.forEach((list) => {
    chrome.contextMenus.create({
      id: `${itemPrefix}${list.id}`,
      title: list.name,
      parentId,
      contexts,
    });
    chrome.contextMenus.create({
      id: `${itemPrefixClose}${list.id}`,
      title: list.name,
      parentId: parentIdClose,
      contexts,
    });
  });
}

// ---------------------------------------------------------------------------
// 网页右键：保存到列表
// ---------------------------------------------------------------------------

function createPageItems(lists) {
  createSaveToListItems(lists, {
    parentId: "saveTo",
    parentIdClose: "saveCloseTo",
    itemPrefix: "save:",
    itemPrefixClose: "saveClose:",
    emptyId: "saveTo-empty",
    emptyIdClose: "saveCloseTo-empty",
    contexts: ["page"],
  });
}

// ---------------------------------------------------------------------------
// 标签右键（Firefox）
// ---------------------------------------------------------------------------

async function createTabItems(lists) {
  // 顺序即显示顺序。
  await menuCreate({ id: TAB_ITEM.reload, title: "刷新标签页", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.pin, title: "固定标签页", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.mute, title: "静音标签页", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.discard, title: "冻结标签页", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.copyTitle, title: "复制标题", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.copyUrl, title: "复制链接", contexts: ["tab"] });
  // 「保存到列表 / 关闭并保存到列表」：网页右键早已有这两个能力，标签右键此前缺失，
  // 侧边栏右键又只能弹出这份注册，因此补在这里即同时覆盖"侧边栏右键"与"Firefox 标签栏右键"。
  createSaveToListItems(lists, {
    parentId: TAB_ITEM.saveToList,
    parentIdClose: TAB_ITEM.saveCloseToList,
    itemPrefix: TAB_ITEM.savePrefix,
    itemPrefixClose: TAB_ITEM.saveClosePrefix,
    emptyId: `${TAB_ITEM.saveToList}-empty`,
    emptyIdClose: `${TAB_ITEM.saveCloseToList}-empty`,
    contexts: ["tab"],
  });
  await menuCreate({ id: TAB_ITEM.moveTo, title: "移动到窗口", contexts: ["tab"] });
  // 「关闭整棵子树」把该标签与其全部后代记为**一个关闭组**，之后可用「撤销关闭最近一组」整组恢复。
  // 二者必须放在最后：撤销项的状态由 onShown 按"是否存在关闭组"刷新。
  await menuCreate({ id: TAB_ITEM.closeTree, title: "关闭整棵子树", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.undoCloseGroup, title: "撤销关闭最近一组", contexts: ["tab"] });
}

/**
 * 重建「移动到窗口」的子项。
 * 窗口打开/关闭时调用，保证子菜单里的窗口列表与编号始终与当前状态一致
 * （编号口径与管理页的「窗口 N」一致：chrome.windows.getAll() 的位次 + 1）。
 */
async function rebuildMoveToWindowItems() {
  for (const item of moveToWindowItems) {
    await menuRemove(item.itemId);
  }
  moveToWindowItems = [];
  // 子项集合变了，之前记录的呈现状态不再有效。
  lastTabMenuSignature = "";
  await menuRemove(TAB_ITEM.moveToNew);

  const windows = await getAllWindows();
  for (let index = 0; index < windows.length; index += 1) {
    const windowId = Number(windows[index].id);
    if (!Number.isFinite(windowId)) {
      continue;
    }
    const itemId = `${TAB_ITEM.moveToWindowPrefix}${windowId}`;
    await menuCreate({
      id: itemId,
      parentId: TAB_ITEM.moveTo,
      title: `窗口 ${index + 1}`,
      contexts: ["tab"],
    });
    moveToWindowItems.push({ windowId, itemId });
  }
  // 「移动到新窗口」固定排在最后，因此每轮都重建一次以保证顺序。
  await menuCreate({
    id: TAB_ITEM.moveToNew,
    parentId: TAB_ITEM.moveTo,
    title: "移动到新窗口",
    contexts: ["tab"],
  });
}

/**
 * 菜单即将弹出时按"被右键的那个标签"的真实状态更新文案与可用性。
 * 固定/静音是二态操作，冻结在已冻结时不可用。
 *
 * onShown 的第二个参数就是该菜单对应的标签页：普通标签栏右键时是所在标签，
 * 侧边栏通过 overrideContext({context:"tab", tabId}) 弹出时是那一个标签。
 */
async function handleContextMenuShown(info, tab) {
  if (!info || !Array.isArray(info.contexts) || !info.contexts.includes("tab")) {
    return;
  }
  if (!tab || !Number.isFinite(Number(tab.id))) {
    return;
  }
  const pinned = Boolean(tab.pinned);
  // 静音状态只能读 mutedInfo.muted（tabs.Tab 没有 muted 字段），否则文案永远停在「静音标签页」。
  const muted = isTabMuted(tab);
  const discarded = Boolean(tab.discarded);
  const tabWindowId = Number(tab.windowId);

  // 把"这次应当呈现的状态"压成签名：标题（由 pinned/muted 决定）、冻结可用性（discarded）、
  // 撤销关闭可用性（是否存在关闭组）、以及每个窗口子项的可见性（当前窗口那一项要隐藏）。
  // 窗口子项集合变化时签名也会变。
  const canUndoClose = hasRestorableGroup();
  const signature = JSON.stringify([
    pinned,
    muted,
    discarded,
    canUndoClose,
    moveToWindowItems.map((item) => [item.windowId, item.windowId !== tabWindowId]),
  ]);
  if (signature === lastTabMenuSignature) {
    return;
  }
  lastTabMenuSignature = signature;

  await Promise.all([
    menuUpdate(TAB_ITEM.pin, { title: pinned ? "取消固定" : "固定标签页" }),
    menuUpdate(TAB_ITEM.mute, { title: muted ? "取消静音" : "静音标签页" }),
    menuUpdate(TAB_ITEM.discard, { enabled: !discarded }),
    // 没有可撤销的关闭组时置灰，避免点了没反应。
    menuUpdate(TAB_ITEM.undoCloseGroup, { enabled: canUndoClose }),
    ...moveToWindowItems.map((item) =>
      menuUpdate(item.itemId, { visible: item.windowId !== tabWindowId })
    ),
  ]);
  chrome.contextMenus.refresh();
}

function updateTab(tabId, changes) {
  chrome.tabs.update(tabId, changes, () => {
    void chrome.runtime.lastError;
  });
}

function moveTabToWindow(tabId, windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.move(tabId, { windowId, index: -1 }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "移动标签页失败。"));
        return;
      }
      resolve();
    });
  });
}

/**
 * 写入剪贴板。
 *
 * 后台页在 Firefox 下是一个带 DOM 的扩展页面，因此这里可以直接用剪贴板 API；
 * 这也是这组 tab 菜单项只在 Firefox 注册的原因之一。
 * 没有可写内容（空字符串）时直接返回：调用方已经做过"内容为空就不复制"的判定，
 * 这里再兜一层是为了避免把空串写进剪贴板、覆盖用户原有的内容。
 *
 * @param {string} text 要写入的文本（可含换行，多行复制时由调用方拼好）
 * @param {string} label 失败日志里显示的动作名（如「复制标题」）
 */
async function writeClipboard(text, label) {
  const content = text === null || text === undefined ? "" : String(text);
  if (!content) {
    return;
  }
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof navigator.clipboard.writeText !== "function"
  ) {
    console.warn(`${label}失败：当前环境不支持剪贴板 API。`);
    return;
  }
  try {
    await navigator.clipboard.writeText(content);
  } catch (error) {
    console.warn(`${label}失败：`, String(error && error.message ? error.message : error));
  }
}

/**
 * 取一个标签用于复制的标题。
 * `tabs.Tab.title` 在页面还没有标题时可能是空串，此时回退到 URL——
 * 侧边栏行内显示用的也是同一口径（`title || url`），复制结果与用户看到的一致。
 */
function tabCopyTitle(tab) {
  const title = tab && tab.title ? String(tab.title) : "";
  if (title) {
    return title;
  }
  return tab && tab.url ? String(tab.url) : "";
}

/**
 * 侧边栏推送当前选中项（多选模式），供「复制标题 / 复制链接」输出多行。
 *
 * 使用场景：侧边栏在 `contextmenu` 处理里、调用 `menus.overrideContext` **之前**调用它，
 * 且**不等待**返回——overrideContext 必须在事件的同步调用栈里执行，而用户点菜单项至少
 * 在数百毫秒之后，消息足够在此之前送达并被处理。
 *
 * 传空数组等价于清空：侧边栏没有选中项时也要推，才能把上一次的暂存清掉。
 *
 * 为什么不做窗口校验：侧边栏的固定标签区是**跨窗口聚合**的，右键一个其它窗口的固定标签时
 * `tab.windowId` 与该侧边栏所属窗口并不相同；而"是否使用选中集合"的判据是"这次菜单由侧边栏弹出"，
 * 与被右键的是哪个标签无关（用户已确认：右键项不在选中集合里时同样复制全部已选）。
 * 因此这里只用"新鲜度 + 菜单关闭即清空 + 复制后一次性消费"来界定生命周期。
 *
 * @param {{items?: Array<{title?: string, url?: string}>}} payload
 */
function setCopySelection(payload) {
  const rawItems = payload && Array.isArray(payload.items) ? payload.items : [];
  const items = rawItems
    .map((item) => ({
      title: item && item.title ? String(item.title) : "",
      url: item && item.url ? String(item.url) : "",
    }))
    .filter((item) => item.title || item.url);
  if (items.length === 0) {
    copySelection = null;
    return;
  }
  copySelection = { items, at: Date.now() };
}

/** 清空暂存的选中项（菜单关闭时调用；菜单不提供"这次是谁弹的"信息，只能整体作废）。 */
function clearCopySelection() {
  copySelection = null;
}

/**
 * 菜单关闭后的暂存清理（由 background.js 接到 `menus.onHidden` 上）。
 *
 * 为什么要延后一个短任务才清：`onClicked` 与 `onHidden` 的先后顺序浏览器没有明确保证，
 * 立即清空有可能把这次点击正要使用的选中集合清掉——表现就是"多选复制退化成单行"。
 * 延后 50ms 足够让同一轮点击的 `onClicked` 先执行；而用户不可能在 50ms 内再弹出下一个菜单，
 * 所以对"菜单关闭即作废、避免残留状态被标签栏右键误用"这个目的没有影响。
 */
function handleContextMenuHidden() {
  setTimeout(clearCopySelection, 50);
}

/**
 * 按侧边栏的显示顺序把选中项拼成多行文本。
 * 标题：为空回退 URL（与单标签口径一致）；链接：为空的行直接跳过——空行会让粘贴结果多出莫名其妙的空行。
 */
function buildCopyLines(items, kind) {
  const lines = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    const url = item && item.url ? String(item.url) : "";
    if (kind === "title") {
      const title = item && item.title ? String(item.title) : "";
      const line = title || url;
      if (line) {
        lines.push(line);
      }
      return;
    }
    if (url) {
      lines.push(url);
    }
  });
  return lines;
}

/**
 * 计算本次复制要写入剪贴板的文本。
 *
 * 优先使用侧边栏推来的选中集合（未过期时）→ 多选模式下复制全部已选；
 * 否则回退到被右键的那一个标签（Firefox 自带标签栏右键、单标签场景都走这条路径）。
 * 命中集合时**立即清空**（一次性消费）：这次菜单的复制动作已完成，残留状态只会污染下一次弹出。
 *
 * @param {object} tab 被右键的标签（onClicked 的第二参）
 * @param {"title"|"url"} kind 复制的是标题还是链接
 */
function takeCopyText(tab, kind) {
  const stored = copySelection;
  if (stored && Date.now() - stored.at <= COPY_SELECTION_TTL_MS) {
    const lines = buildCopyLines(stored.items, kind);
    copySelection = null;
    // 集合非空但全被过滤（标题与 URL 都空）时也回退单标签，避免"点了没反应"。
    if (lines.length > 0) {
      return lines.join("\n");
    }
  }
  return kind === "title" ? tabCopyTitle(tab) : tab && tab.url ? String(tab.url) : "";
}

/** 复制标签标题。 */
async function copyTabTitle(tab) {
  await writeClipboard(takeCopyText(tab, "title"), "复制标题");
}

/** 复制标签链接。 */
async function copyTabUrl(tab) {
  await writeClipboard(takeCopyText(tab, "url"), "复制链接");
}

// ---------------------------------------------------------------------------
// 注册与点击
// ---------------------------------------------------------------------------

async function rebuildContextMenus() {
  const lists = await getLists();
  await new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });

  createPageItems(lists);

  if (IS_FIREFOX) {
    lastTabMenuSignature = "";
    await createTabItems(lists);
    await rebuildMoveToWindowItems();
  }
}

/** 窗口增删时刷新「移动到窗口」子菜单。 */
async function handleWindowsChanged() {
  if (!IS_FIREFOX) {
    return;
  }
  await rebuildMoveToWindowItems();
}

async function handleContextMenuClick(info, tab) {
  if (!info || !info.menuItemId) {
    return;
  }
  const menuId = String(info.menuItemId);

  // 标签右键的「保存到列表 / 关闭并保存到列表」：与网页右键同一套 saveTabs 路径，
  // 只是 id 前缀不同（见 TAB_ITEM.savePrefix 注释）。tab 参数就是被右键的那个标签。
  if (menuId.startsWith(TAB_ITEM.savePrefix) || menuId.startsWith(TAB_ITEM.saveClosePrefix)) {
    const closeTab = menuId.startsWith(TAB_ITEM.saveClosePrefix);
    const prefix = closeTab ? TAB_ITEM.saveClosePrefix : TAB_ITEM.savePrefix;
    const listId = menuId.slice(prefix.length);
    if (!tab || !tab.id || !listId) {
      return;
    }
    try {
      await saveCurrentTab({ tab, listId, closeTab });
    } catch (error) {
      console.warn("标签右键保存失败：", error);
    }
    return;
  }

  if (menuId.startsWith(TAB_ITEM.moveToWindowPrefix)) {
    const targetWindowId = Number(menuId.slice(TAB_ITEM.moveToWindowPrefix.length));
    if (!tab || !Number.isFinite(Number(tab.id)) || !Number.isFinite(targetWindowId)) {
      return;
    }
    try {
      await moveTabToWindow(Number(tab.id), targetWindowId);
    } catch (error) {
      console.warn("移动到窗口失败：", String(error && error.message ? error.message : error));
    }
    return;
  }

  switch (menuId) {
    case TAB_ITEM.reload:
      if (tab && Number.isFinite(Number(tab.id))) {
        chrome.tabs.reload(Number(tab.id));
      }
      return;
    case TAB_ITEM.pin:
      if (tab && Number.isFinite(Number(tab.id))) {
        updateTab(Number(tab.id), { pinned: !tab.pinned });
      }
      return;
    case TAB_ITEM.mute:
      if (tab && Number.isFinite(Number(tab.id))) {
        // 取反必须以 mutedInfo.muted 为基准：读 tab.muted 恒为 undefined，`!undefined` 恒真，
        // 于是这个菜单项只能"静音"，永远无法取消静音。
        updateTab(Number(tab.id), { muted: !isTabMuted(tab) });
      }
      return;
    case TAB_ITEM.discard:
      if (tab && Number.isFinite(Number(tab.id))) {
        await manualDiscard(Number(tab.id));
      }
      return;
    // 关闭整棵子树：走后台的关闭组路径，之后可整组撤销（含层级与物理位置）。
    // 叶子标签也允许点（等于只关它自己，仍然记为一个一元的关闭组）。
    case TAB_ITEM.closeTree: {
      if (!tab || !Number.isFinite(Number(tab.id)) || !Number.isFinite(Number(tab.windowId))) {
        return;
      }
      const result = await closeTabsAsGroup(Number(tab.windowId), [], "关闭的子树", {
        subtreeOf: Number(tab.id),
      });
      if (!result.ok) {
        console.warn("关闭整棵子树失败：", result.error);
      }
      return;
    }
    // 撤销关闭最近一组：原生菜单没有状态条，失败只写调试日志，不打扰用户。
    case TAB_ITEM.undoCloseGroup: {
      const result = await restoreClosedGroup();
      if (!result.ok) {
        console.warn("撤销关闭失败：", result.error);
      }
      return;
    }
    case TAB_ITEM.copyTitle:
      await copyTabTitle(tab);
      return;
    case TAB_ITEM.copyUrl:
      await copyTabUrl(tab);
      return;
    case TAB_ITEM.moveToNew:
      if (tab && Number.isFinite(Number(tab.id))) {
        chrome.windows.create({ tabId: Number(tab.id) }, () => {
          void chrome.runtime.lastError;
        });
      }
      return;
    default:
      break;
  }

  // 以下为网页右键的「保存到列表」逻辑。
  if (!tab || !tab.id) {
    return;
  }
  if (menuId.includes("-empty")) {
    return;
  }
  const [action, listId] = menuId.split(":");
  if (!listId) {
    return;
  }
  const closeTab = action === "saveClose";
  try {
    await saveCurrentTab({ tab, listId, closeTab });
  } catch (error) {
    console.warn("右键菜单保存失败：", error);
  }
}

export {
  clearActionPopup,
  clearCopySelection,
  handleContextMenuClick,
  handleContextMenuHidden,
  handleContextMenuShown,
  handleWindowsChanged,
  rebuildContextMenus,
  setCopySelection,
};
