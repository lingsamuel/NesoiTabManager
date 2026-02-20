import {
  RECENT_ALARM,
  RECENT_CONFIG_KEY,
  RECENT_OPEN_AT_KEY,
  RECENT_STATE_KEY,
} from "./constants.js";
import { storageGet, storageSet, storageSessionGet, storageSessionSet } from "./storage.js";

const DEFAULT_RECENT_CONFIG = {
  reminderIntervalMin: 15,
  startupDelaySec: 60,
  startupQuietSec: 15,
  startupMaxGraceSec: 900,
};

const recentState = {
  lastReviewedAt: 0,
  startupAt: 0,
  startupActive: false,
  startupEndAt: 0,
  snoozedUntil: 0,
};

const openAtMap = new Map();

let recentConfigCache = null;
let recentStateReady = false;
let recentStatePromise = null;
let openAtReady = false;
let openAtPromise = null;
let openAtDirty = false;
let openAtSaveTimer = null;
let startupQuietTimer = null;
let startupMaxTimer = null;
let lastStartupTabAt = 0;

function isExtensionUrl(url) {
  if (!url) {
    return false;
  }
  const lower = String(url).toLowerCase();
  return (
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge-extension://") ||
    lower.startsWith("moz-extension://") ||
    lower.startsWith("extension://")
  );
}

function sanitizeRecentConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const reminderIntervalMin = Number.isFinite(Number(config.reminderIntervalMin))
    ? Math.max(1, Math.min(240, Number(config.reminderIntervalMin)))
    : DEFAULT_RECENT_CONFIG.reminderIntervalMin;
  const startupDelaySec = Number.isFinite(Number(config.startupDelaySec))
    ? Math.max(0, Math.min(3600, Number(config.startupDelaySec)))
    : DEFAULT_RECENT_CONFIG.startupDelaySec;
  const startupQuietSec = Number.isFinite(Number(config.startupQuietSec))
    ? Math.max(5, Math.min(300, Number(config.startupQuietSec)))
    : DEFAULT_RECENT_CONFIG.startupQuietSec;
  const startupMaxGraceSec = Number.isFinite(Number(config.startupMaxGraceSec))
    ? Math.max(60, Math.min(7200, Number(config.startupMaxGraceSec)))
    : DEFAULT_RECENT_CONFIG.startupMaxGraceSec;
  return {
    reminderIntervalMin,
    startupDelaySec,
    startupQuietSec,
    startupMaxGraceSec,
  };
}

async function ensureRecentConfig() {
  if (recentConfigCache) {
    return recentConfigCache;
  }
  const stored = await storageGet(RECENT_CONFIG_KEY);
  recentConfigCache = sanitizeRecentConfig(stored || {});
  if (!stored) {
    await storageSet({ [RECENT_CONFIG_KEY]: recentConfigCache });
  }
  return recentConfigCache;
}

async function saveRecentState() {
  await storageSet({
    [RECENT_STATE_KEY]: {
      lastReviewedAt: recentState.lastReviewedAt,
      startupAt: recentState.startupAt,
      startupActive: recentState.startupActive,
      startupEndAt: recentState.startupEndAt,
      snoozedUntil: recentState.snoozedUntil,
    },
  });
}

async function ensureRecentState() {
  if (recentStateReady) {
    return recentState;
  }
  if (recentStatePromise) {
    return recentStatePromise;
  }
  recentStatePromise = storageGet(RECENT_STATE_KEY).then((stored) => {
    const data = stored && typeof stored === "object" ? stored : {};
    const lastReviewedAt = Number.isFinite(Number(data.lastReviewedAt))
      ? Number(data.lastReviewedAt)
      : 0;
    const startupAt = Number.isFinite(Number(data.startupAt))
      ? Number(data.startupAt)
      : 0;
    const startupActive = Boolean(data.startupActive);
    const startupEndAt = Number.isFinite(Number(data.startupEndAt))
      ? Number(data.startupEndAt)
      : 0;
    const snoozedUntil = Number.isFinite(Number(data.snoozedUntil))
      ? Number(data.snoozedUntil)
      : 0;
    recentState.lastReviewedAt = lastReviewedAt;
    recentState.startupAt = startupAt;
    recentState.startupActive = startupActive;
    recentState.startupEndAt = startupEndAt;
    recentState.snoozedUntil = snoozedUntil;
    recentStateReady = true;
    recentStatePromise = null;
    return recentState;
  });
  return recentStatePromise;
}

function scheduleOpenAtSave() {
  if (openAtSaveTimer) {
    return;
  }
  openAtSaveTimer = setTimeout(async () => {
    openAtSaveTimer = null;
    if (!openAtDirty) {
      return;
    }
    openAtDirty = false;
    const data = {};
    openAtMap.forEach((value, key) => {
      data[key] = value;
    });
    await storageSessionSet({ [RECENT_OPEN_AT_KEY]: data });
  }, 800);
}

async function ensureOpenAtMap() {
  if (openAtReady) {
    return openAtMap;
  }
  if (openAtPromise) {
    return openAtPromise;
  }
  openAtPromise = storageSessionGet(RECENT_OPEN_AT_KEY).then((stored) => {
    const data = stored && typeof stored === "object" ? stored : {};
    Object.keys(data).forEach((key) => {
      const value = Number(data[key]);
      if (!Number.isFinite(value)) {
        return;
      }
      const mapKey = String(key);
      const existing = openAtMap.get(mapKey);
      if (!Number.isFinite(existing)) {
        openAtMap.set(mapKey, value);
      }
    });
    openAtReady = true;
    openAtPromise = null;
    return openAtMap;
  });
  return openAtPromise;
}

function setTabOpenAt(tabId, openAt) {
  if (!Number.isFinite(Number(tabId))) {
    return;
  }
  const key = String(tabId);
  openAtMap.set(key, openAt);
  openAtDirty = true;
  scheduleOpenAtSave();
}

function deleteTabOpenAt(tabId) {
  if (!Number.isFinite(Number(tabId))) {
    return;
  }
  const key = String(tabId);
  if (openAtMap.delete(key)) {
    openAtDirty = true;
    scheduleOpenAtSave();
  }
}

async function primeOpenAtForExistingTabs(openAtValue) {
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({}, (result) => resolve(result || []));
  });
  tabs.forEach((tab) => {
    if (tab && Number.isFinite(Number(tab.id))) {
      setTabOpenAt(tab.id, openAtValue);
    }
  });
}

function clearStartupTimers() {
  if (startupQuietTimer) {
    clearTimeout(startupQuietTimer);
    startupQuietTimer = null;
  }
  if (startupMaxTimer) {
    clearTimeout(startupMaxTimer);
    startupMaxTimer = null;
  }
}

function scheduleStartupQuietCheck(config) {
  if (!recentState.startupActive) {
    return;
  }
  if (startupQuietTimer) {
    clearTimeout(startupQuietTimer);
    startupQuietTimer = null;
  }
  const quietMs = config.startupQuietSec * 1000;
  startupQuietTimer = setTimeout(() => {
    startupQuietTimer = null;
    if (!recentState.startupActive) {
      return;
    }
    const elapsed = Date.now() - lastStartupTabAt;
    if (elapsed >= quietMs) {
      endStartup({ manual: false });
    } else {
      scheduleStartupQuietCheck(config);
    }
  }, quietMs);
}

function scheduleStartupMaxTimer(config) {
  if (!recentState.startupActive) {
    return;
  }
  if (startupMaxTimer) {
    clearTimeout(startupMaxTimer);
    startupMaxTimer = null;
  }
  const maxMs = config.startupMaxGraceSec * 1000;
  const elapsed = Date.now() - recentState.startupAt;
  const remaining = Math.max(0, maxMs - elapsed);
  if (remaining === 0) {
    endStartup({ manual: false });
    return;
  }
  startupMaxTimer = setTimeout(() => {
    startupMaxTimer = null;
    if (!recentState.startupActive) {
      return;
    }
    endStartup({ manual: false });
  }, remaining);
}

function scheduleStartupTimers(config) {
  if (!recentState.startupActive) {
    return;
  }
  scheduleStartupQuietCheck(config);
  scheduleStartupMaxTimer(config);
}

async function startStartup() {
  await ensureRecentConfig();
  await ensureRecentState();
  await ensureOpenAtMap();
  const now = Date.now();
  recentState.startupActive = true;
  recentState.startupAt = now;
  recentState.startupEndAt = 0;
  recentState.snoozedUntil = 0;
  lastStartupTabAt = now;
  openAtMap.clear();
  openAtDirty = true;
  scheduleOpenAtSave();
  await primeOpenAtForExistingTabs(now);
  await saveRecentState();
  scheduleStartupTimers(recentConfigCache);
}

function endStartup({ manual }) {
  if (!recentState.startupActive) {
    return;
  }
  recentState.startupActive = false;
  recentState.startupEndAt = Date.now();
  if (!manual && recentConfigCache) {
    recentState.lastReviewedAt =
      recentState.startupEndAt + recentConfigCache.startupDelaySec * 1000;
  }
  clearStartupTimers();
  saveRecentState();
}

async function ensureRecentAlarm(config) {
  const period = Math.max(1, Number(config.reminderIntervalMin) || DEFAULT_RECENT_CONFIG.reminderIntervalMin);
  chrome.alarms.get(RECENT_ALARM, (alarm) => {
    if (alarm && Number(alarm.periodInMinutes) === period) {
      return;
    }
    chrome.alarms.create(RECENT_ALARM, { periodInMinutes: period });
  });
}

async function initializeRecentSystem(options = {}) {
  const config = await ensureRecentConfig();
  await ensureRecentState();
  await ensureOpenAtMap();
  if (options.forceStartup) {
    await startStartup();
  } else if (recentState.startupActive) {
    lastStartupTabAt = recentState.startupAt || Date.now();
    scheduleStartupTimers(config);
  }
  await ensureRecentAlarm(config);
}

async function getRecentConfig() {
  return ensureRecentConfig();
}

async function setRecentConfig(config) {
  const sanitized = sanitizeRecentConfig(config);
  recentConfigCache = sanitized;
  await storageSet({ [RECENT_CONFIG_KEY]: sanitized });
  await ensureRecentAlarm(sanitized);
  if (recentState.startupActive) {
    scheduleStartupTimers(sanitized);
  }
  return sanitized;
}

function handleRecentConfigChanged(newValue) {
  recentConfigCache = sanitizeRecentConfig(newValue || {});
  ensureRecentAlarm(recentConfigCache);
  if (recentState.startupActive) {
    scheduleStartupTimers(recentConfigCache);
  }
}

function updateStartupActivity() {
  if (!recentState.startupActive) {
    return;
  }
  lastStartupTabAt = Date.now();
  if (recentConfigCache) {
    scheduleStartupQuietCheck(recentConfigCache);
  }
}

function getFallbackOpenAt(now) {
  if (recentState.startupActive) {
    return recentState.startupAt || now;
  }
  if (recentState.lastReviewedAt) {
    return recentState.lastReviewedAt;
  }
  return now;
}

function getOpenAtForTab(tabId, now) {
  const key = String(tabId);
  const existing = openAtMap.get(key);
  if (Number.isFinite(existing)) {
    return existing;
  }
  const fallback = getFallbackOpenAt(now);
  setTabOpenAt(tabId, fallback);
  return fallback;
}

async function getRecentTabsSnapshot() {
  await ensureRecentConfig();
  await ensureRecentState();
  await ensureOpenAtMap();
  if (recentState.startupActive) {
    return {
      tabs: [],
      count: 0,
      lastReviewedAt: recentState.lastReviewedAt,
      sinceMs: 0,
      startupActive: true,
    };
  }
  const now = Date.now();
  const lastReviewedAt = Number.isFinite(Number(recentState.lastReviewedAt))
    ? Number(recentState.lastReviewedAt)
    : 0;
  if (lastReviewedAt && now < lastReviewedAt) {
    return {
      tabs: [],
      count: 0,
      lastReviewedAt,
      sinceMs: 0,
      startupActive: false,
    };
  }
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({}, (result) => resolve(result || []));
  });
  const filtered = [];
  tabs.forEach((tab) => {
    if (!tab || !Number.isFinite(Number(tab.id))) {
      return;
    }
    if (tab.pinned) {
      return;
    }
    if (isExtensionUrl(tab.url)) {
      return;
    }
    const openAt = getOpenAtForTab(tab.id, now);
    if (openAt <= lastReviewedAt) {
      return;
    }
    filtered.push({ ...tab, openAt });
  });
  filtered.sort((a, b) => (b.openAt || 0) - (a.openAt || 0));
  return {
    tabs: filtered,
    count: filtered.length,
    lastReviewedAt,
    sinceMs: now - lastReviewedAt,
    startupActive: false,
  };
}

async function sendRecentReminder() {
  chrome.tabs.query({ active: true }, (tabs) => {
    sendRecentReminderToTabs(tabs || [], { hideWhenEmpty: false });
  });
}

function handleRecentAlarm(alarm) {
  if (!alarm || alarm.name !== RECENT_ALARM) {
    return;
  }
  sendRecentReminder();
}

function sendPayloadToTabs(tabs, payload) {
  (tabs || []).forEach((tab) => {
    if (!tab || !tab.id) {
      return;
    }
    chrome.tabs.sendMessage(tab.id, payload, () => {});
  });
}

async function sendRecentReminderToTabs(tabs, options = {}) {
  const snapshot = await getRecentTabsSnapshot();
  const now = Date.now();
  if (recentState.snoozedUntil && now < recentState.snoozedUntil) {
    return;
  }
  if (snapshot.startupActive) {
    if (options.hideWhenEmpty) {
      sendPayloadToTabs(tabs, { action: "recentReminder", count: 0, minutes: 0 });
    }
    return;
  }
  if (snapshot.lastReviewedAt && now < snapshot.lastReviewedAt) {
    if (options.hideWhenEmpty) {
      sendPayloadToTabs(tabs, { action: "recentReminder", count: 0, minutes: 0 });
    }
    return;
  }
  if (snapshot.count === 0) {
    if (options.hideWhenEmpty) {
      sendPayloadToTabs(tabs, { action: "recentReminder", count: 0, minutes: 0 });
    }
    return;
  }
  const minutes = Math.max(1, Math.floor(snapshot.sinceMs / 60000));
  sendPayloadToTabs(tabs, {
    action: "recentReminder",
    count: snapshot.count,
    minutes,
  });
}

function sendRecentClearToActiveTabs() {
  chrome.tabs.query({ active: true }, (tabs) => {
    sendPayloadToTabs(tabs || [], { action: "recentReminder", count: 0, minutes: 0 });
  });
}

function handleRecentTabActivated(activeInfo) {
  const windowId = activeInfo && Number.isFinite(Number(activeInfo.windowId))
    ? Number(activeInfo.windowId)
    : null;
  if (windowId === null) {
    return;
  }
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    const list = tabs || [];
    const activeTab = list[0];
    if (
      activeTab &&
      Number.isFinite(Number(activeTab.id)) &&
      !recentState.startupActive
    ) {
      if (!isExtensionUrl(activeTab.url)) {
        setTabOpenAt(activeTab.id, Date.now());
      }
    }
    sendRecentReminderToTabs(list, { hideWhenEmpty: true });
  });
}

function handleRecentWindowFocusChanged(windowId) {
  if (!Number.isFinite(Number(windowId))) {
    return;
  }
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    const list = tabs || [];
    const activeTab = list[0];
    if (
      activeTab &&
      Number.isFinite(Number(activeTab.id)) &&
      !recentState.startupActive
    ) {
      if (!isExtensionUrl(activeTab.url)) {
        setTabOpenAt(activeTab.id, Date.now());
      }
    }
    sendRecentReminderToTabs(list, { hideWhenEmpty: true });
  });
}

function handleRecentTabCreated(tab) {
  if (!tab || !Number.isFinite(Number(tab.id))) {
    return;
  }
  const now = Date.now();
  setTabOpenAt(tab.id, now);
  updateStartupActivity();
}

function handleRecentTabRemoved(tabId) {
  deleteTabOpenAt(tabId);
}

function handleRecentTabReplaced(addedTabId, removedTabId) {
  const key = String(removedTabId);
  const existing = openAtMap.get(key);
  deleteTabOpenAt(removedTabId);
  if (Number.isFinite(Number(addedTabId))) {
    const openAt = Number.isFinite(existing) ? existing : Date.now();
    setTabOpenAt(addedTabId, openAt);
  }
  updateStartupActivity();
}

async function markRecentReviewed() {
  await ensureRecentConfig();
  await ensureRecentState();
  const now = Date.now();
  recentState.lastReviewedAt = now;
  recentState.snoozedUntil = 0;
  if (recentState.startupActive) {
    endStartup({ manual: true });
  } else {
    await saveRecentState();
  }
  sendRecentClearToActiveTabs();
  return { lastReviewedAt: recentState.lastReviewedAt };
}

async function snoozeRecentReminder() {
  await ensureRecentConfig();
  await ensureRecentState();
  const now = Date.now();
  const intervalMs = recentConfigCache
    ? recentConfigCache.reminderIntervalMin * 60 * 1000
    : DEFAULT_RECENT_CONFIG.reminderIntervalMin * 60 * 1000;
  recentState.snoozedUntil = now + intervalMs;
  await saveRecentState();
  sendRecentClearToActiveTabs();
  return { snoozedUntil: recentState.snoozedUntil };
}

export {
  getRecentConfig,
  setRecentConfig,
  handleRecentConfigChanged,
  initializeRecentSystem,
  handleRecentAlarm,
  handleRecentTabCreated,
  handleRecentTabRemoved,
  handleRecentTabReplaced,
  handleRecentTabActivated,
  handleRecentWindowFocusChanged,
  getRecentTabsSnapshot,
  markRecentReviewed,
  snoozeRecentReminder,
};
