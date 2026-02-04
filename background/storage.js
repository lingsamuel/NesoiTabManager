import { HAS_SESSION_STORAGE } from "./constants.js";

export function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key]));
  });
}

export function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
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
