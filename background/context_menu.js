import { getLists, saveCurrentTab } from "./lists.js";

function clearActionPopup() {
  if (chrome.action && chrome.action.setPopup) {
    chrome.action.setPopup({ popup: "" });
  }
}

async function rebuildContextMenus() {
  const lists = await getLists();
  chrome.contextMenus.removeAll(() => {
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
  });
}

async function handleContextMenuClick(info, tab) {
  if (!info.menuItemId || !tab || !tab.id) {
    return;
  }
  const menuId = String(info.menuItemId);
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

export { clearActionPopup, rebuildContextMenus, handleContextMenuClick };
