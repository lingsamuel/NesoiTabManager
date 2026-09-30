import { manualDiscard } from "./discard.js";
import { getLists, saveCurrentTab } from "./lists.js";

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
  copyUrl: "nesoi-tab:copyUrl",
  moveTo: "nesoi-tab:moveTo",
  moveToNew: "nesoi-tab:moveTo:new",
  moveToWindowPrefix: "nesoi-tab:moveTo:win:",
};

// 每个窗口一个子项，窗口增删时需要精确重建。
let moveToWindowItems = [];
// 上一次应用过的"期望菜单状态"签名。
// menus.refresh() 会让 onShown 再次触发，因此必须只在状态真的变化时才写回并刷新，
// 否则会形成 onShown → update → refresh → onShown 的死循环。
let lastTabMenuSignature = "";

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
// 网页右键：保存到列表
// ---------------------------------------------------------------------------

function createPageItems(lists) {
  chrome.contextMenus.create({
    id: "saveTo",
    title: "保存到列表",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: "saveCloseTo",
    title: "关闭并保存到列表",
    contexts: ["page"],
  });

  if (lists.length === 0) {
    chrome.contextMenus.create({
      id: "saveTo-empty",
      title: "暂无列表",
      parentId: "saveTo",
      contexts: ["page"],
      enabled: false,
    });
    chrome.contextMenus.create({
      id: "saveCloseTo-empty",
      title: "暂无列表",
      parentId: "saveCloseTo",
      contexts: ["page"],
      enabled: false,
    });
    return;
  }

  lists.forEach((list) => {
    chrome.contextMenus.create({
      id: `save:${list.id}`,
      title: list.name,
      parentId: "saveTo",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: `saveClose:${list.id}`,
      title: list.name,
      parentId: "saveCloseTo",
      contexts: ["page"],
    });
  });
}

// ---------------------------------------------------------------------------
// 标签右键（Firefox）
// ---------------------------------------------------------------------------

async function createTabItems() {
  // 顺序即显示顺序。
  await menuCreate({ id: TAB_ITEM.reload, title: "刷新标签页", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.pin, title: "固定标签页", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.mute, title: "静音标签页", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.discard, title: "冻结标签页", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.copyUrl, title: "复制链接", contexts: ["tab"] });
  await menuCreate({ id: TAB_ITEM.moveTo, title: "移动到窗口", contexts: ["tab"] });
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
  const muted = Boolean(tab.muted);
  const discarded = Boolean(tab.discarded);
  const tabWindowId = Number(tab.windowId);

  // 把"这次应当呈现的状态"压成签名：标题（由 pinned/muted 决定）、冻结可用性（discarded）、
  // 以及每个窗口子项的可见性（当前窗口那一项要隐藏）。窗口子项集合变化时签名也会变。
  const signature = JSON.stringify([
    pinned,
    muted,
    discarded,
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
 * 复制标签链接。
 * 后台页在 Firefox 下是一个带 DOM 的扩展页面，因此可以直接用剪贴板 API；
 * 这也是这组 tab 菜单项只在 Firefox 注册的原因之一。
 */
async function copyTabUrl(tab) {
  const url = tab && tab.url ? String(tab.url) : "";
  if (!url) {
    return;
  }
  if (typeof navigator === "undefined" || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
    console.warn("复制链接失败：当前环境不支持剪贴板 API。");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
  } catch (error) {
    console.warn("复制链接失败：", String(error && error.message ? error.message : error));
  }
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
    await createTabItems();
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
        updateTab(Number(tab.id), { muted: !tab.muted });
      }
      return;
    case TAB_ITEM.discard:
      if (tab && Number.isFinite(Number(tab.id))) {
        await manualDiscard(Number(tab.id));
      }
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
  handleContextMenuClick,
  handleContextMenuShown,
  handleWindowsChanged,
  rebuildContextMenus,
};
