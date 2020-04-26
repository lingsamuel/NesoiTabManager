// =====
// Data Structure Transformer
// Transformer functions: convert API DS to Nesoi DS
// =====

import {getDomainNameFromFullURL} from "./url_utils";
import {BrowserTab, BrowserWindow, NesoiTab, NesoiWindow} from "./ds";

export function transformWindowList(windows: (BrowserWindow | any)[]): NesoiWindow[] {
    windows.forEach(w => {
        transformWindow(w);
    });
    return windows;
}

export function transformWindow(window: BrowserWindow | any): NesoiWindow {
    window.vue_key = window.id;
    window.tabs.forEach(tab => {
        return transformTab(tab);
    });
    return window;
}

export function transformTab(tab: BrowserTab | any): NesoiTab {
    tab.vue_key = tab.id;
    tab.url_obj = new URL(tab.url);
    tab.hostname = tab.url_obj.hostname;
    tab.domain = getDomainNameFromFullURL(tab.url_obj);
    return tab;
}
