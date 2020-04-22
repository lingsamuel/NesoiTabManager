import browser from 'webextension-polyfill'

async function getLists() {
    return (await browser.storage.local.get('lists')) || [];
}

async function setLists(lists) {
    return await browser.storage.local.set({ lists });
}

export default {
    getLists,
    setLists,
}
