import {
  DISCARD_ALARM,
  DISCARD_CONFIG_KEY,
  DISCARD_SESSION_KEY,
} from "./constants.js";
import { storageGet, storageSet, storageSessionGet, storageSessionSet } from "./storage.js";
import { delay, getBaseDomain, getUrlWithoutParams, isDiscardableUrl } from "./utils.js";
import { getTabById } from "./lists.js";

const tabLastActive = new Map();
const activeTabByWindow = new Map();
const discardSession = {
  startEpoch: 0,
  lastDiscarded: [],
  lastDiscardedAt: "",
  historyBatches: [],
  freezeCounts: {},
};

let focusedWindowId = null;
let tabActivityReady = false;
let tabActivityPromise = null;
let discardSweepRunning = false;
let discardConfigCache = null;

function resetTabActivity() {
  tabLastActive.clear();
  activeTabByWindow.clear();
  focusedWindowId = null;
  tabActivityReady = false;
  tabActivityPromise = null;
}

function normalizeWhitelist(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

function sanitizeDiscardConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const enabled = Boolean(config.enabled);
  const idleMinutes = Number.isFinite(Number(config.idleMinutes))
    ? Math.max(1, Math.min(1440, Number(config.idleMinutes)))
    : 20;
  const sweepMinutes = Number.isFinite(Number(config.sweepMinutes))
    ? Math.max(1, Math.min(120, Number(config.sweepMinutes)))
    : 3;
  const batchLimit = Number.isFinite(Number(config.batchLimit))
    ? Math.max(1, Math.min(200, Number(config.batchLimit)))
    : 20;
  const historyLimit = Number.isFinite(Number(config.historyLimit))
    ? Math.max(0, Number(config.historyLimit))
    : 0;
  const allowPinned = Boolean(config.allowPinned);
  const allowAudible = Boolean(config.allowAudible);
  const matchMode = config.matchMode === "url" || config.matchMode === "full" ? config.matchMode : "domain";
  const regexMode = Boolean(config.regexMode);
  const whitelist = normalizeWhitelist(config.whitelist);
  return {
    enabled,
    idleMinutes,
    sweepMinutes,
    batchLimit,
    historyLimit,
    allowPinned,
    allowAudible,
    matchMode,
    regexMode,
    whitelist,
  };
}

async function resetDiscardSession() {
  const now = Date.now();
  discardSession.startEpoch = now;
  discardSession.lastDiscarded = [];
  discardSession.lastDiscardedAt = "";
  discardSession.historyBatches = [];
  discardSession.freezeCounts = {};
  await storageSessionSet({
    [DISCARD_SESSION_KEY]: {
      startEpoch: now,
      lastDiscarded: [],
      lastDiscardedAt: "",
      historyBatches: [],
      freezeCounts: {},
    },
  });
}

async function ensureDiscardSession() {
  if (discardSession.startEpoch) {
    return;
  }
  const stored = await storageSessionGet(DISCARD_SESSION_KEY);
  const now = Date.now();
  const startEpoch = stored && Number.isFinite(Number(stored.startEpoch)) ? Number(stored.startEpoch) : 0;
  discardSession.startEpoch = startEpoch > 0 ? startEpoch : now;
  discardSession.lastDiscarded = Array.isArray(stored && stored.lastDiscarded)
    ? stored.lastDiscarded
    : [];
  discardSession.lastDiscardedAt = stored && stored.lastDiscardedAt ? String(stored.lastDiscardedAt) : "";
  discardSession.historyBatches = Array.isArray(stored && stored.historyBatches)
    ? stored.historyBatches
    : [];
  discardSession.freezeCounts = stored && typeof stored.freezeCounts === "object" && stored.freezeCounts
    ? stored.freezeCounts
    : {};
  if (!startEpoch) {
    await storageSessionSet({
      [DISCARD_SESSION_KEY]: {
        startEpoch: discardSession.startEpoch,
        lastDiscarded: discardSession.lastDiscarded,
        lastDiscardedAt: discardSession.lastDiscardedAt,
        historyBatches: discardSession.historyBatches,
        freezeCounts: discardSession.freezeCounts,
      },
    });
  }
}

async function saveDiscardSession() {
  await storageSessionSet({
    [DISCARD_SESSION_KEY]: {
      startEpoch: discardSession.startEpoch,
      lastDiscarded: discardSession.lastDiscarded,
      lastDiscardedAt: discardSession.lastDiscardedAt,
      historyBatches: discardSession.historyBatches,
      freezeCounts: discardSession.freezeCounts,
    },
  });
}

async function getDiscardConfig() {
  if (discardConfigCache) {
    return discardConfigCache;
  }
  const stored = await storageGet(DISCARD_CONFIG_KEY);
  discardConfigCache = sanitizeDiscardConfig(stored || {});
  return discardConfigCache;
}

async function setDiscardConfig(config) {
  const sanitized = sanitizeDiscardConfig(config);
  const prevEnabled = discardConfigCache ? discardConfigCache.enabled : false;
  discardConfigCache = sanitized;
  await storageSet({ [DISCARD_CONFIG_KEY]: sanitized });
  if (sanitized.enabled && !prevEnabled) {
    resetTabActivity();
    await resetDiscardSession();
  }
  if (sanitized.historyLimit > 0) {
    trimDiscardHistory(sanitized.historyLimit);
    await saveDiscardSession();
  }
  await ensureDiscardAlarm(sanitized);
  return sanitized;
}

function handleDiscardConfigChanged(newValue) {
  discardConfigCache = sanitizeDiscardConfig(newValue || {});
  ensureDiscardAlarm(discardConfigCache);
  if (discardConfigCache.historyLimit > 0) {
    trimDiscardHistory(discardConfigCache.historyLimit);
    saveDiscardSession();
  }
}

function getWhitelistTarget(tab, mode) {
  if (!tab || !tab.url) {
    return "";
  }
  if (mode === "url") {
    return getUrlWithoutParams(tab.url);
  }
  if (mode === "full") {
    return String(tab.url);
  }
  return getBaseDomain(tab.url);
}

function isTabWhitelisted(tab, config) {
  const entries = Array.isArray(config.whitelist) ? config.whitelist : [];
  if (!tab || entries.length === 0) {
    return false;
  }
  const target = getWhitelistTarget(tab, config.matchMode);
  if (!target) {
    return false;
  }
  if (config.regexMode) {
    for (let i = 0; i < entries.length; i += 1) {
      const pattern = entries[i];
      if (!pattern) {
        continue;
      }
      try {
        const regex = new RegExp(pattern);
        if (regex.test(target)) {
          return true;
        }
      } catch (error) {
        continue;
      }
    }
    return false;
  }
  const lowerTarget = target.toLowerCase();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    if (lowerTarget.includes(String(entry).toLowerCase())) {
      return true;
    }
  }
  return false;
}

function touchTab(tabId, time) {
  if (!tabId) {
    return;
  }
  tabLastActive.set(String(tabId), time || Date.now());
}

function getLastActive(tab, now) {
  const key = String(tab.id);
  let value = tabLastActive.has(key) ? tabLastActive.get(key) : 0;
  const lastAccessed = Number.isFinite(Number(tab.lastAccessed)) ? Number(tab.lastAccessed) : 0;
  if (lastAccessed > value) {
    value = lastAccessed;
  }
  const minBaseline = discardSession.startEpoch || now;
  if (!value) {
    value = lastAccessed || now;
  }
  if (minBaseline > value) {
    value = minBaseline;
  }
  tabLastActive.set(key, value);
  return value;
}

function queryAllTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => resolve(tabs || []));
  });
}

async function ensureTabActivity() {
  if (tabActivityReady) {
    return;
  }
  if (tabActivityPromise) {
    await tabActivityPromise;
    return;
  }
  tabActivityPromise = new Promise((resolve) => {
    queryAllTabs().then(async (tabs) => {
      await ensureDiscardSession();
      const now = Date.now();
      const baseTime = discardSession.startEpoch || now;
      tabs.forEach((tab) => {
        if (!tab || tab.id === undefined) {
          return;
        }
        const key = String(tab.id);
        const existing = tabLastActive.get(key) || 0;
        const lastAccessed = Number.isFinite(Number(tab.lastAccessed)) ? Number(tab.lastAccessed) : 0;
        if (existing) {
          if (lastAccessed > existing) {
            tabLastActive.set(key, lastAccessed);
          }
        } else {
          let initial = lastAccessed || now;
          if (baseTime > initial) {
            initial = baseTime;
          }
          tabLastActive.set(key, initial);
        }
        if (tab.active && tab.windowId !== undefined) {
          activeTabByWindow.set(tab.windowId, tab.id);
        }
      });
      tabActivityReady = true;
      resolve();
    });
  });
  await tabActivityPromise;
}

function evaluateDiscardCandidate(tab, config, now) {
  if (!tab || !tab.id) {
    return null;
  }
  if (!isDiscardableUrl(tab.url)) {
    return null;
  }
  if (tab.active) {
    touchTab(tab.id, now);
    return null;
  }
  if (tab.discarded) {
    return null;
  }
  if (!config.allowPinned && tab.pinned) {
    return null;
  }
  if (!config.allowAudible && tab.audible) {
    return null;
  }
  if (isTabWhitelisted(tab, config)) {
    return null;
  }
  const lastActive = getLastActive(tab, now);
  const idleMs = now - lastActive;
  if (idleMs < config.idleMinutes * 60 * 1000) {
    return null;
  }
  return { lastActive, idleMinutes: Math.floor(idleMs / 60000) };
}

async function discardTabs(tabIds) {
  const batchSize = 100;
  for (let i = 0; i < tabIds.length; i += batchSize) {
    const batch = tabIds.slice(i, i + batchSize);
    await Promise.all(
      batch.map(
        (tabId) =>
          new Promise((resolve) => {
            chrome.tabs.discard(tabId, () => resolve());
          })
      )
    );
    if (i + batchSize < tabIds.length) {
      await delay(150);
    }
  }
}

async function recordDiscardBatch(items, at, config) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  const timestamp = at || Date.now();
  discardSession.lastDiscarded = items;
  discardSession.lastDiscardedAt = new Date(timestamp).toISOString();
  const batch = {
    id: `batch_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
    at: discardSession.lastDiscardedAt,
    items,
  };
  discardSession.historyBatches = discardSession.historyBatches || [];
  discardSession.historyBatches.unshift(batch);
  trimDiscardHistory(config.historyLimit);
  await saveDiscardSession();
}

async function runDiscardSweep() {
  if (discardSweepRunning) {
    return;
  }
  discardSweepRunning = true;
  try {
    const config = await getDiscardConfig();
    if (!config.enabled) {
      return;
    }
    await ensureDiscardSession();
    await ensureTabActivity();
    const now = Date.now();
    const tabs = await queryAllTabs();
    const candidates = [];
    const candidateDetails = [];
    const counts = discardSession.freezeCounts || {};
    for (let i = 0; i < tabs.length; i += 1) {
      const tab = tabs[i];
      const result = evaluateDiscardCandidate(tab, config, now);
      if (!result) {
        continue;
      }
      candidates.push(tab.id);
      const nextCount = (counts[tab.id] || 0) + 1;
      counts[tab.id] = nextCount;
      candidateDetails.push({
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title || tab.url || "未命名",
        url: tab.url || "",
        favIconUrl: tab.favIconUrl || "",
        idleMinutes: result.idleMinutes,
        lastActive: result.lastActive,
        discardedAt: now,
        freezeCount: nextCount,
      });
      if (candidates.length >= config.batchLimit) {
        break;
      }
    }
    if (candidates.length > 0) {
      await discardTabs(candidates);
      discardSession.freezeCounts = counts;
      await recordDiscardBatch(candidateDetails, now, config);
    }
  } finally {
    discardSweepRunning = false;
  }
}

async function manualDiscard(tabId) {
  if (!tabId) {
    throw new Error("缺少标签页 ID。");
  }
  await ensureDiscardSession();
  const config = await getDiscardConfig();
  const tab = await getTabById(tabId);
  if (!tab) {
    throw new Error("未找到标签页。");
  }
  if (tab.discarded) {
    return { skipped: true };
  }
  const now = Date.now();
  const lastActive = getLastActive(tab, now);
  const idleMinutes = Math.max(0, Math.floor((now - lastActive) / 60000));
  const counts = discardSession.freezeCounts || {};
  const nextCount = (counts[tabId] || 0) + 1;
  counts[tabId] = nextCount;
  const item = {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || tab.url || "未命名",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || "",
    idleMinutes,
    lastActive,
    discardedAt: now,
    freezeCount: nextCount,
  };
  await new Promise((resolve, reject) => {
    chrome.tabs.discard(tabId, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "冻结失败"));
        return;
      }
      resolve();
    });
  });
  discardSession.freezeCounts = counts;
  await recordDiscardBatch([item], now, config);
  return { item };
}

async function getDiscardCandidates(limit) {
  await ensureDiscardSession();
  const config = await getDiscardConfig();
  if (!config.enabled) {
    return {
      candidates: [],
      total: 0,
      enabled: false,
      lastDiscarded: discardSession.lastDiscarded || [],
      lastDiscardedAt: discardSession.lastDiscardedAt || "",
      historyBatches: discardSession.historyBatches || [],
      historyLimit: config.historyLimit || 0,
    };
  }
  await ensureTabActivity();
  const now = Date.now();
  const tabs = await queryAllTabs();
  const candidates = [];
  let total = 0;
  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    const result = evaluateDiscardCandidate(tab, config, now);
    if (!result) {
      continue;
    }
    total += 1;
    if (candidates.length < limit) {
      candidates.push({
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title || tab.url || "未命名",
        url: tab.url || "",
        favIconUrl: tab.favIconUrl || "",
        idleMinutes: result.idleMinutes,
        lastActive: result.lastActive,
        pinned: Boolean(tab.pinned),
        audible: Boolean(tab.audible),
      });
    }
  }
  return {
    candidates,
    total,
    enabled: config.enabled,
    lastDiscarded: discardSession.lastDiscarded || [],
    lastDiscardedAt: discardSession.lastDiscardedAt || "",
    historyBatches: discardSession.historyBatches || [],
    historyLimit: config.historyLimit || 0,
  };
}

async function getDiscardHistory() {
  await ensureDiscardSession();
  const config = await getDiscardConfig();
  const batches = discardSession.historyBatches || [];
  const total = batches.reduce((sum, batch) => sum + (batch.items ? batch.items.length : 0), 0);
  return {
    enabled: config.enabled,
    historyBatches: batches,
    historyLimit: config.historyLimit || 0,
    historyTotal: total,
    historyBatchesCount: batches.length,
  };
}

function ensureDiscardAlarm(config) {
  if (!config.enabled) {
    chrome.alarms.clear(DISCARD_ALARM);
    return;
  }
  const period = Math.max(1, Number(config.sweepMinutes) || 3);
  chrome.alarms.create(DISCARD_ALARM, { periodInMinutes: period, delayInMinutes: 1 });
}

function initializeDiscardSystem() {
  getDiscardConfig()
    .then(async (config) => {
      await ensureDiscardSession();
      await ensureDiscardAlarm(config);
    })
    .catch(() => {});
}

function trimDiscardHistory(limit) {
  if (!limit || limit <= 0) {
    return;
  }
  const batches = discardSession.historyBatches || [];
  let total = batches.reduce((sum, batch) => sum + (batch.items ? batch.items.length : 0), 0);
  while (total > limit && batches.length > 0) {
    const lastBatch = batches[batches.length - 1];
    const batchCount = lastBatch.items ? lastBatch.items.length : 0;
    if (total - batchCount >= limit) {
      batches.pop();
      total -= batchCount;
      continue;
    }
    const removeCount = total - limit;
    if (removeCount > 0 && Array.isArray(lastBatch.items)) {
      lastBatch.items = lastBatch.items.slice(removeCount);
      total = limit;
    } else {
      break;
    }
  }
  discardSession.historyBatches = batches;
}

function handleDiscardAlarm(alarm) {
  if (alarm && alarm.name === DISCARD_ALARM) {
    runDiscardSweep();
  }
}

function handleTabActivated(activeInfo) {
  if (!activeInfo || activeInfo.tabId === undefined) {
    return;
  }
  const now = Date.now();
  const previous = activeTabByWindow.get(activeInfo.windowId);
  if (previous && previous !== activeInfo.tabId) {
    touchTab(previous, now);
  }
  activeTabByWindow.set(activeInfo.windowId, activeInfo.tabId);
  touchTab(activeInfo.tabId, now);
}

function handleWindowFocusChanged(windowId) {
  const now = Date.now();
  if (focusedWindowId && focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
    const previousActive = activeTabByWindow.get(focusedWindowId);
    if (previousActive) {
      touchTab(previousActive, now);
    }
  }
  focusedWindowId = windowId;
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].id !== undefined) {
      activeTabByWindow.set(windowId, tabs[0].id);
      touchTab(tabs[0].id, now);
    }
  });
}

function handleTabCreated(tab) {
  if (tab && tab.id !== undefined) {
    touchTab(tab.id);
  }
}

function handleTabRemoved(tabId) {
  tabLastActive.delete(String(tabId));
  activeTabByWindow.forEach((value, key) => {
    if (value === tabId) {
      activeTabByWindow.delete(key);
    }
  });
}

function handleTabReplaced(addedTabId, removedTabId) {
  const key = String(removedTabId);
  if (tabLastActive.has(key)) {
    const lastActive = tabLastActive.get(key);
    tabLastActive.delete(key);
    tabLastActive.set(String(addedTabId), lastActive);
  }
  activeTabByWindow.forEach((value, winId) => {
    if (value === removedTabId) {
      activeTabByWindow.set(winId, addedTabId);
    }
  });
  touchTab(addedTabId);
}

export {
  getDiscardConfig,
  setDiscardConfig,
  getDiscardCandidates,
  getDiscardHistory,
  manualDiscard,
  initializeDiscardSystem,
  resetTabActivity,
  resetDiscardSession,
  handleDiscardAlarm,
  handleTabActivated,
  handleWindowFocusChanged,
  handleTabCreated,
  handleTabRemoved,
  handleTabReplaced,
  handleDiscardConfigChanged,
};
