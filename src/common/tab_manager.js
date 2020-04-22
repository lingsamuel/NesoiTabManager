import browser from 'webextension-polyfill'

// =====
// Tab Manager
// Functions about tab management.
// =====

async function getAllWindows() {
    return await browser.windows.getAll({ populate: true });
}

async function getAllTabs() {
    let windows = await getAllWindows();

    let windowList = [];
    for (let window of windows) {
        windowList.push({
            title: window.title,
            tabs: window.tabs,
            titleEditing: false,
            id: window.id,
        })
    }
    return windowList;
}

async function activateTab(tabId, windowId) {
    let windows = await getAllWindows();
    const win = windows.find((x) => x.id === windowId);
    if (!win) {
        return
    }
    // for (const tab of win.tabs) {
    //     // console.log(tab.title, tab.active, tab.id, tabId);
    //     if (tab.id !== tabId) {
    //         tab.active = false
    //     } else if (tab.id === tabId) {
    //         tab.active = true;
    //         console.log("tab found", typeof tab.id, typeof tabId);
    //         break;
    //     }
    // }
    browser.tabs.update(tabId, {
        active: true,
    });
    browser.windows.update(windowId, {
        focused: true,
    });
}

export default {
    getAllTabs,
    activateTab,
}
