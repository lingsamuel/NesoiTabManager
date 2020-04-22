import storage from './storage'
import browser from 'webextension-polyfill'

// =====
// Tab Storage
// Functions about saved tabs.
// =====

async function getSelectedTabs() {
    return browser.tabs.query({ highlighted: true, pinned: false });
}

async function storeSelectedTabs(remove = true) {
    let tabs = await getSelectedTabs()
    if (remove) {
        browser.tabs.remove(tabs.map(i => i.id));
    }

    let newList = (await storage.getLists()).then(lists => {
        lists.push({
            tabs: tabs,
            title: '',
            time: Date.now(),
        });
        return lists
    });
    return storage.setLists(newList);
}

async function restoreList(list) {
    for (let tab of list) {
        let createdTab = browser.tabs.create({
            url: tab.url,
            pinned: tab.pinned,
            index: tab.index,
        });

        if (tab.muted) {
            browser.tabs.update(createdTab.id, {
                muted: true
            });
        }
    }
}

export default {
    getSelectedTabs,
    storeSelectedTabs
}
