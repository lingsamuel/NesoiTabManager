import tabs from './common/tab_storage'
import storage from './common/storage'
import browser from 'webextension-polyfill'

browser.browserAction.onClicked.addListener(() => {
    browser.runtime.openOptionsPage();
});
