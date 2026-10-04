import { HAS_SESSION_STORAGE } from "./constants.js";

// 树恢复等不能把读取失败当作“没有快照”的调用方，显式要求错误向上传递。
export function storageGet(key, { strict = false } = {}) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (strict && chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || '读取本地存储失败'));
        return;
      }
      resolve(result?.[key]);
    });
  });
}

export function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

export function storageRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

export function storageSessionGet(key) {
  if (!HAS_SESSION_STORAGE) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    chrome.storage.session.get(key, (result) => resolve(result[key]));
  });
}

export function storageSessionSet(obj) {
  if (!HAS_SESSION_STORAGE) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    chrome.storage.session.set(obj, () => resolve());
  });
}
