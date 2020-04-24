import browser from 'webextension-polyfill'
import {BrowserWindow, NesoiTab, NesoiWindow, SortOptions} from "./ds";

// =====
// Tab Manager
// Functions about tab management.
// =====

export async function getAllWindows(): Promise<NesoiWindow[]> {
    return browser.windows.getAll({populate: true});
}

export async function getAllTabs() {
    let windows = await getAllWindows();

    for (let window of windows) {
        window.title = `Window ${window.id}`;
    }
    return windows;
}

export async function closeTab(tabId) {
    return browser.tabs.remove(tabId);
}

export async function sortTabs(tabs: NesoiTab[], opts: SortOptions<NesoiTab>) {

}
