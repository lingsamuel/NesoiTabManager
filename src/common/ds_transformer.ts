// =====
// Data Structure Transformer
// Transformer functions: convert API DS to Nesoi DS
// =====

import {getDomainName} from "./url_utils";
import {BrowserTab, NesoiTab} from "./ds";

export function transformWindow(window) {
    window.vue_key = window.id;
    window.tabs.forEach(tab => {
        return transformTab(tab);
    });
}

export function transformTab(tab: NesoiTab) {
    tab.vue_key = tab.id;
    tab.url_obj = new URL(tab.url);
    tab.hostname = tab.url_obj.hostname;
    tab.domain = getDomainName(tab.hostname);
}
