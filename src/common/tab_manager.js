import browser from 'webextension-polyfill'

// =====
// Tab Manager
// Functions about tab management.
// =====

export async function getAllWindows() {
    return await browser.windows.getAll({populate: true});
}

export async function getAllTabs() {
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

export async function closeTab(tabId) {
    return browser.tabs.remove(tabId);
}
