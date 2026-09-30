import {
  RECENT_ALARM,
  RECENT_CONFIG_KEY,
  RECENT_OPEN_AT_KEY,
  RECENT_STATE_KEY,
} from "./constants.js";
import { storageGet, storageSet, storageSessionGet, storageSessionSet } from "./storage.js";
import { formatDuration } from "./utils.js";

const DEFAULT_RECENT_CONFIG = {
  // 提醒总开关：关闭后只停止页面浮窗与后台定时器，
  // 管理页「近期标签页」的展示与统计不受影响。
  reminderEnabled: true,
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
  bubblePosition: null,
};

const openAtMap = new Map();
const tabCache = new Map();
const activeTabByWindow = new Map();

let recentConfigCache = null;
let recentStateReady = false;
let recentStatePromise = null;
let openAtReady = false;
let openAtPromise = null;
let tabCacheReady = false;
let tabCachePromise = null;
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

function getReminderIntervalMs() {
  const minutes = recentConfigCache
    ? Number(recentConfigCache.reminderIntervalMin)
    : DEFAULT_RECENT_CONFIG.reminderIntervalMin;
  return Math.max(1, minutes || DEFAULT_RECENT_CONFIG.reminderIntervalMin) * 60 * 1000;
}

function getNextReminderAt() {
  const base = Number.isFinite(Number(recentState.lastReviewedAt))
    ? Number(recentState.lastReviewedAt)
    : 0;
  let dueAt = base + getReminderIntervalMs();
  if (recentState.snoozedUntil && recentState.snoozedUntil > dueAt) {
    dueAt = recentState.snoozedUntil;
  }
  return dueAt;
}

function isReminderDue(now) {
  if (recentState.startupActive) {
    return false;
  }
  const dueAt = getNextReminderAt();
  return now >= dueAt;
}

function sanitizeRecentConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  // 开关只接受布尔值：老版本存储里没有这个字段，缺省或异常值一律按开启处理，
  // 保证升级后行为与升级前一致，不会静默把用户的提醒关掉。
  const reminderEnabled =
    typeof config.reminderEnabled === "boolean" ? config.reminderEnabled : true;
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
    reminderEnabled,
    reminderIntervalMin,
    startupDelaySec,
    startupQuietSec,
    startupMaxGraceSec,
  };
}

function sanitizeBubblePosition(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const left = Number(raw.left);
  const top = Number(raw.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }
  const updatedAt = Number.isFinite(Number(raw.updatedAt))
    ? Number(raw.updatedAt)
    : Date.now();
  return { left, top, updatedAt };
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
      bubblePosition: recentState.bubblePosition,
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
    const bubblePosition = sanitizeBubblePosition(data.bubblePosition);
    recentState.lastReviewedAt = lastReviewedAt;
    recentState.startupAt = startupAt;
    recentState.startupActive = startupActive;
    recentState.startupEndAt = startupEndAt;
    recentState.snoozedUntil = snoozedUntil;
    recentState.bubblePosition = bubblePosition;
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

function normalizeTabCacheEntry(tab) {
  if (!tab || !Number.isFinite(Number(tab.id))) {
    return null;
  }
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || "",
    pinned: Boolean(tab.pinned),
    discarded: Boolean(tab.discarded),
    active: Boolean(tab.active),
    index: Number.isFinite(Number(tab.index)) ? Number(tab.index) : 0,
  };
}

function updateTabCache(tab) {
  const entry = normalizeTabCacheEntry(tab);
  if (!entry) {
    return;
  }
  tabCache.set(String(entry.id), entry);
  if (entry.active && Number.isFinite(Number(entry.windowId))) {
    activeTabByWindow.set(Number(entry.windowId), entry.id);
  }
}

function deleteTabCache(tabId) {
  if (!Number.isFinite(Number(tabId))) {
    return;
  }
  tabCache.delete(String(tabId));
}

async function ensureTabCache() {
  if (tabCacheReady) {
    return tabCache;
  }
  if (tabCachePromise) {
    return tabCachePromise;
  }
  tabCachePromise = new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      (tabs || []).forEach((tab) => updateTabCache(tab));
      tabCacheReady = true;
      tabCachePromise = null;
      resolve(tabCache);
    });
  });
  return tabCachePromise;
}

function setActiveTab(windowId, tabId) {
  if (!Number.isFinite(Number(windowId)) || !Number.isFinite(Number(tabId))) {
    return;
  }
  const winId = Number(windowId);
  const newId = Number(tabId);
  const prevId = activeTabByWindow.get(winId);
  if (prevId && prevId !== newId) {
    const prevEntry = tabCache.get(String(prevId));
    if (prevEntry) {
      prevEntry.active = false;
    }
  }
  const activeEntry = tabCache.get(String(newId));
  if (activeEntry) {
    activeEntry.active = true;
  }
  activeTabByWindow.set(winId, newId);
}

async function primeOpenAtForExistingTabs(openAtValue) {
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({}, (result) => resolve(result || []));
  });
  tabs.forEach((tab) => {
    if (tab && Number.isFinite(Number(tab.id))) {
      setTabOpenAt(tab.id, openAtValue);
      updateTabCache(tab);
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
  // 提醒开关关闭后不需要任何定时器：直接清掉 alarm 让后台彻底静默。
  // 重新开启时会走到下面的 chrome.alarms.get：此时拿不到已存在的 alarm，自然重建。
  if (!config || !config.reminderEnabled) {
    chrome.alarms.clear(RECENT_ALARM);
    return;
  }
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
  await ensureTabCache();
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

/**
 * 供内容脚本在初始化阶段读取气泡位置。
 * 约束：仅返回最近一次持久化结果，不做多页面同步推送。
 */
async function getRecentBubblePosition() {
  await ensureRecentState();
  return recentState.bubblePosition;
}

async function setRecentConfig(config) {
  const sanitized = sanitizeRecentConfig(config);
  const wasEnabled = !recentConfigCache || recentConfigCache.reminderEnabled !== false;
  recentConfigCache = sanitized;
  await storageSet({ [RECENT_CONFIG_KEY]: sanitized });
  await ensureRecentAlarm(sanitized);
  if (!sanitized.reminderEnabled && wasEnabled) {
    // 为什么不在 handleRecentConfigChanged 里处理这一次切换：
    // 上面已经把 recentConfigCache 改成新值，随后触发的 storage.onChanged
    // 在那边读不到"旧的开启态"，判定不出是由开转关，所以必须在写盘前记下旧值并在本地补播一次，
    // 让页面上已经显示的提醒气泡随开关关闭立刻消失。
    sendRecentClearToActiveTabs();
  }
  if (recentState.startupActive) {
    scheduleStartupTimers(sanitized);
  }
  return sanitized;
}

function handleRecentConfigChanged(newValue) {
  const previous = recentConfigCache;
  recentConfigCache = sanitizeRecentConfig(newValue || {});
  ensureRecentAlarm(recentConfigCache);
  if (
    !recentConfigCache.reminderEnabled &&
    (!previous || previous.reminderEnabled !== false)
  ) {
    // 由开启切到关闭（例如其他扩展上下文直接改写了存储）：
    // 立即向各窗口活动标签广播隐藏消息，回收已经显示出来的提醒气泡。
    sendRecentClearToActiveTabs();
  }
  if (recentState.startupActive) {
    scheduleStartupTimers(recentConfigCache);
  }
}

/**
 * 由内容脚本在拖动结束时调用，写入全局位置记忆。
 * 前置条件：调用方已做视口边界裁剪，这里只做结构与数值校验。
 */
async function setRecentBubblePosition(position) {
  await ensureRecentState();
  const sanitized = sanitizeBubblePosition(position);
  if (!sanitized) {
    throw new Error("气泡位置无效。");
  }
  recentState.bubblePosition = sanitized;
  await saveRecentState();
  return recentState.bubblePosition;
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
  await ensureTabCache();
  if (recentState.startupActive) {
    return {
      tabs: [],
      count: 0,
      lastReviewedAt: recentState.lastReviewedAt,
      sinceMs: 0,
      durationText: "",
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
      durationText: "",
      startupActive: false,
    };
  }
  const filtered = [];
  tabCache.forEach((tab) => {
    if (!tab) {
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
    durationText: formatDuration(now - lastReviewedAt),
    startupActive: false,
  };
}

async function sendRecentReminder() {
  await ensureRecentConfig();
  // 关闭提醒后定时器已被清除，这里再兜一层：即使有残留 alarm 也不广播气泡。
  if (!recentConfigCache || !recentConfigCache.reminderEnabled) {
    return;
  }
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
  await ensureRecentConfig();
  // 开关关闭时绝不推送计数气泡；但 hideWhenEmpty 的那次调用必须保留"隐藏"消息，
  // 否则在开关关闭之前已经显示气泡的页面会一直挂着旧气泡（切换标签/窗口时才可能被清理）。
  if (!recentConfigCache || !recentConfigCache.reminderEnabled) {
    if (options.hideWhenEmpty) {
      sendPayloadToTabs(tabs, { action: "recentReminder", count: 0, durationText: "" });
    }
    return;
  }
  await ensureRecentState();
  const now = Date.now();
  if (!isReminderDue(now)) {
    if (options.hideWhenEmpty) {
      sendPayloadToTabs(tabs, { action: "recentReminder", count: 0, durationText: "" });
    }
    return;
  }
  const snapshot = await getRecentTabsSnapshot();
  if (snapshot.startupActive) {
    if (options.hideWhenEmpty) {
      sendPayloadToTabs(tabs, { action: "recentReminder", count: 0, durationText: "" });
    }
    return;
  }
  if (snapshot.lastReviewedAt && now < snapshot.lastReviewedAt) {
    if (options.hideWhenEmpty) {
      sendPayloadToTabs(tabs, { action: "recentReminder", count: 0, durationText: "" });
    }
    return;
  }
  if (snapshot.count === 0) {
    if (options.hideWhenEmpty) {
      sendPayloadToTabs(tabs, { action: "recentReminder", count: 0, durationText: "" });
    }
    return;
  }
  sendPayloadToTabs(tabs, {
    action: "recentReminder",
    count: snapshot.count,
    durationText: formatDuration(snapshot.sinceMs),
  });
}

function sendRecentClearToActiveTabs() {
  chrome.tabs.query({ active: true }, (tabs) => {
    sendPayloadToTabs(tabs || [], { action: "recentReminder", count: 0, durationText: "" });
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
      updateTabCache(activeTab);
      if (Number.isFinite(Number(activeTab.windowId))) {
        setActiveTab(activeTab.windowId, activeTab.id);
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
      updateTabCache(activeTab);
      if (Number.isFinite(Number(activeTab.windowId))) {
        setActiveTab(activeTab.windowId, activeTab.id);
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
  updateTabCache(tab);
  if (tab.active && Number.isFinite(Number(tab.windowId))) {
    setActiveTab(tab.windowId, tab.id);
  }
  setTabOpenAt(tab.id, now);
  updateStartupActivity();
}

function handleRecentTabRemoved(tabId) {
  deleteTabOpenAt(tabId);
  deleteTabCache(tabId);
  activeTabByWindow.forEach((value, key) => {
    if (Number(value) === Number(tabId)) {
      activeTabByWindow.delete(key);
    }
  });
}

function handleRecentTabReplaced(addedTabId, removedTabId) {
  const key = String(removedTabId);
  const existing = openAtMap.get(key);
  deleteTabOpenAt(removedTabId);
  deleteTabCache(removedTabId);
  const removedId = Number(removedTabId);
  activeTabByWindow.forEach((value, key) => {
    if (Number(value) === removedId) {
      activeTabByWindow.delete(key);
    }
  });
  if (Number.isFinite(Number(addedTabId))) {
    const openAt = Number.isFinite(existing) ? existing : Date.now();
    setTabOpenAt(addedTabId, openAt);
    chrome.tabs.get(addedTabId, (tab) => {
      if (!chrome.runtime.lastError) {
        updateTabCache(tab);
        if (tab.active && Number.isFinite(Number(tab.windowId))) {
          setActiveTab(tab.windowId, tab.id);
        }
      }
    });
  }
  updateStartupActivity();
}

function handleRecentTabUpdated(tabId, changeInfo, tab) {
  if (!Number.isFinite(Number(tabId))) {
    return;
  }
  if (!tab) {
    return;
  }
  const hasMeaningfulChange = Boolean(
    changeInfo &&
      (Object.prototype.hasOwnProperty.call(changeInfo, "url") ||
        Object.prototype.hasOwnProperty.call(changeInfo, "title") ||
        Object.prototype.hasOwnProperty.call(changeInfo, "favIconUrl") ||
        Object.prototype.hasOwnProperty.call(changeInfo, "pinned") ||
        Object.prototype.hasOwnProperty.call(changeInfo, "discarded"))
  );
  if (!hasMeaningfulChange) {
    return;
  }
  updateTabCache(tab);
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
  const intervalMs = getReminderIntervalMs();
  recentState.snoozedUntil = now + intervalMs;
  await saveRecentState();
  sendRecentClearToActiveTabs();
  return { snoozedUntil: recentState.snoozedUntil };
}

export {
  getRecentConfig,
  getRecentBubblePosition,
  setRecentConfig,
  setRecentBubblePosition,
  handleRecentConfigChanged,
  initializeRecentSystem,
  handleRecentAlarm,
  handleRecentTabCreated,
  handleRecentTabRemoved,
  handleRecentTabReplaced,
  handleRecentTabUpdated,
  handleRecentTabActivated,
  handleRecentWindowFocusChanged,
  getRecentTabsSnapshot,
  markRecentReviewed,
  snoozeRecentReminder,
};
