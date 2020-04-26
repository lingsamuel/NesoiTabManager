import browser from 'webextension-polyfill'
import {BrowserWindow, NesoiTab, NesoiWindow, SortOptions} from "./ds";

// =====
// Tab Manager
// Functions about tab management.
// =====

async function getAllWindows(): Promise<NesoiWindow[]> {
    return browser.windows.getAll({populate: true});
}

export function getTabsByWindow(id) :Promise<NesoiWindow> {
    return browser.windows.get(id, {populate: true});
}

export async function getAllTabs(): Promise<NesoiWindow[]> {
    let windows = await getAllWindows();

    for (let window of windows) {
        window.title = `Window ${window.id}`;
    }
    return windows;
}

export async function closeWindow(tabId) {
    return browser.windows.remove(tabId);
}


export async function closeTab(tabId) {
    return browser.tabs.remove(tabId);
}

export async function sortTabs(tabs: NesoiTab[], opts: SortOptions<NesoiTab>) {

}
