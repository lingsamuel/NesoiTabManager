// chrome.storage 的薄封装。
//
// 独立成模块的原因：视图模式、折叠状态、筛选模式都各自需要读写，
// 而"浮层（网页内嵌 iframe）里 chrome.* 可能不可用"这件事必须在所有调用点统一降级，
// 不能每个 composable 各写一份能力探测。

// 浮层中 chrome.* 可能不可用，这里统一做能力探测，缺失时降级为页面内存。
const HAS_CHROME_STORAGE = typeof chrome !== "undefined" && Boolean(chrome.storage);
const HAS_SESSION_STORAGE = HAS_CHROME_STORAGE && Boolean(chrome.storage.session);

function storageLocalGet(key) {
  if (!HAS_CHROME_STORAGE) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result ? result[key] : undefined));
  });
}

function storageLocalSet(obj) {
  if (!HAS_CHROME_STORAGE) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function storageSessionGet(key) {
  if (!HAS_SESSION_STORAGE) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    chrome.storage.session.get(key, (result) => resolve(result ? result[key] : undefined));
  });
}

function storageSessionSet(obj) {
  if (!HAS_SESSION_STORAGE) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    chrome.storage.session.set(obj, () => resolve());
  });
}

export { storageLocalGet, storageLocalSet, storageSessionGet, storageSessionSet };
