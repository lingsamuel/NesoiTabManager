import browser from "webextension-polyfill";
import {getAllWindows} from "./tab_manager";

export function activateWindow(windowId) {
    browser.windows.update(windowId, {
        focused: true,
    });
}

export function activateTab(tabId, windowId) {
    // let windows = await getAllWindows();
    // const win = windows.find((x) => x.id === windowId);
    // if (!win) {
    //     return
    // }

    browser.tabs.update(tabId, {
        active: true,
    });
    activateWindow(windowId);
}
