import {
  DISCARD_ALARM,
  DISCARD_CONFIG_KEY,
  DISCARD_SESSION_KEY,
  DISCARD_TAB_ACTIVITY_KEY,
} from "./constants.js";
import { storageGet, storageSet, storageSessionGet, storageSessionSet } from "./storage.js";
import { delay, getBaseDomain, getUrlWithoutParams, isDiscardableUrl } from "./utils.js";
import { getTabById, getTabsByIds } from "./lists.js";

const tabLastActive = new Map();
const tabFirstSeen = new Map();
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
let tabFirstSeenReady = false;
let tabFirstSeenPromise = null;
let tabFirstSeenSaveTimer = null;
let tabFirstSeenDirty = false;
let discardSweepRunning = false;
let discardConfigCache = null;

function resetTabActivity() {
  tabLastActive.clear();
  tabFirstSeen.clear();
  activeTabByWindow.clear();
  focusedWindowId = null;
  tabActivityReady = false;
  tabActivityPromise = null;
  tabFirstSeenReady = false;
  tabFirstSeenPromise = null;
  if (tabFirstSeenSaveTimer) {
    clearTimeout(tabFirstSeenSaveTimer);
    tabFirstSeenSaveTimer = null;
  }
  tabFirstSeenDirty = false;
  storageSessionSet({ [DISCARD_TAB_ACTIVITY_KEY]: {} });
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

function getWhitelistTargets(tab, mode) {
  if (!tab || !tab.url) {
    return [];
  }
  const url = String(tab.url);
  if (mode === "full") {
    return [url];
  }
  if (mode === "url") {
    const stripped = getUrlWithoutParams(url);
    return stripped ? [stripped] : [];
  }
  const targets = new Set();
  const baseDomain = getBaseDomain(url);
  if (baseDomain) {
    targets.add(baseDomain);
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname) {
      targets.add(parsed.hostname);
    }
    if (parsed.host) {
      targets.add(parsed.host);
    }
  } catch (error) {
    // ignore
  }
  return Array.from(targets);
}

function isTabWhitelisted(tab, config) {
  const entries = Array.isArray(config.whitelist) ? config.whitelist : [];
  if (!tab || entries.length === 0) {
    return false;
  }
  const targets = getWhitelistTargets(tab, config.matchMode);
  if (targets.length === 0) {
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
        for (let j = 0; j < targets.length; j += 1) {
          if (regex.test(targets[j])) {
            return true;
          }
        }
      } catch (error) {
        continue;
      }
    }
    return false;
  }
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const needle = String(entry).toLowerCase();
    for (let j = 0; j < targets.length; j += 1) {
      if (targets[j].toLowerCase().includes(needle)) {
        return true;
      }
    }
  }
  return false;
}

function touchTab(tabId, time) {
  if (tabId === undefined || tabId === null) {
    return;
  }
  const timestamp = time || Date.now();
  tabLastActive.set(String(tabId), timestamp);
  markTabFirstSeen(tabId, timestamp);
}

function scheduleTabFirstSeenSave() {
  tabFirstSeenDirty = true;
  if (tabFirstSeenSaveTimer) {
    return;
  }
  tabFirstSeenSaveTimer = setTimeout(() => {
    tabFirstSeenSaveTimer = null;
    if (!tabFirstSeenDirty) {
      return;
    }
    tabFirstSeenDirty = false;
    const payload = {};
    tabFirstSeen.forEach((value, key) => {
      payload[key] = value;
    });
    storageSessionSet({ [DISCARD_TAB_ACTIVITY_KEY]: payload });
  }, 800);
}

function markTabFirstSeen(tabId, time) {
  if (tabId === undefined || tabId === null) {
    return false;
  }
  const key = String(tabId);
  if (tabFirstSeen.has(key)) {
    return false;
  }
  const timestamp = time || Date.now();
  tabFirstSeen.set(key, timestamp);
  scheduleTabFirstSeenSave();
  return true;
}

async function ensureTabFirstSeen() {
  if (tabFirstSeenReady) {
    return;
  }
  if (tabFirstSeenPromise) {
    await tabFirstSeenPromise;
    return;
  }
  tabFirstSeenPromise = storageSessionGet(DISCARD_TAB_ACTIVITY_KEY)
    .then((stored) => {
      if (stored && typeof stored === "object") {
        Object.keys(stored).forEach((key) => {
          const timestamp = Number(stored[key]);
          if (!Number.isFinite(timestamp) || timestamp <= 0) {
            return;
          }
          if (tabFirstSeen.has(key)) {
            const existing = tabFirstSeen.get(key);
            if (timestamp < existing) {
              tabFirstSeen.set(key, timestamp);
            }
          } else {
            tabFirstSeen.set(key, timestamp);
          }
        });
      }
      tabFirstSeenReady = true;
    })
    .catch(() => {
      tabFirstSeenReady = true;
    })
    .finally(() => {
      tabFirstSeenPromise = null;
    });
  await tabFirstSeenPromise;
}

function getLastActive(tab, now) {
  const key = String(tab.id);
  let value = tabLastActive.has(key) ? tabLastActive.get(key) : 0;
  const lastAccessed = Number.isFinite(Number(tab.lastAccessed)) ? Number(tab.lastAccessed) : 0;
  if (lastAccessed > value) {
    value = lastAccessed;
  }
  if (tabFirstSeen.has(key)) {
    const firstSeen = tabFirstSeen.get(key);
    if (firstSeen > value) {
      value = firstSeen;
    }
  }
  const minBaseline = discardSession.startEpoch || now;
  if (!value) {
    value = lastAccessed || now;
  }
  if (minBaseline > value) {
    value = minBaseline;
  }
  tabLastActive.set(key, value);
  markTabFirstSeen(tab.id, value);
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
      await ensureTabFirstSeen();
      await ensureDiscardSession();
      const now = Date.now();
      const baseTime = discardSession.startEpoch || now;
      let firstSeenDirty = false;
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
          if (markTabFirstSeen(tab.id, initial)) {
            firstSeenDirty = true;
          }
        }
        if (tab.active && tab.windowId !== undefined) {
          activeTabByWindow.set(tab.windowId, tab.id);
        }
      });
      if (firstSeenDirty) {
        scheduleTabFirstSeenSave();
      }
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

/**
 * 把任意来源的标签 id 归一成合法整数；非法时返回 null。
 * 存在意义：id 可能来自消息（数字会被原样传递，但其它入口可能是字符串/空值），
 * 而 Firefox 的 tabs.* schema 对 tabId 是严格的 integer 校验，
 * 传字符串会直接抛 "Incorrect argument types for tabs.get/discard"。
 */
function normalizeTabId(raw) {
  // 必须先排掉 null/undefined/空串：Number(null) 与 Number("") 都是 0，会被误判成合法 id 0。
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) {
    return null;
  }
  return id;
}

/**
 * 冻结（discard）单个标签页。
 *
 * 使用场景：自动冻结的批量扫描、手动冻结（侧边栏按钮 / 原生右键菜单 / 管理页）都汇聚到这两个入口。
 * 前置要求：tabId 是标签 id；非法 id 会同步 reject。
 *
 * 为什么**不能**写成 `chrome.tabs.discard(tabId, callback)`：
 * Firefox 的 `tabs.discard` schema 只声明了 `tabIds` 一个形参（`"async": true`，Promise 形式），
 * 没有 callback。多传一个函数会被 schema 校验直接拒绝并抛
 * "Incorrect argument types for tabs.discard"——表现为"按钮点了没反应/控制台报错"。
 * 因此这里统一走 Promise 形式：Chrome MV3 与 Firefox 都支持。
 * 极老实现若没有 Promise 形式，调用本身已经发出（事后拿不到 lastError），按成功处理，
 * 不能因为探测不到 Promise 就把功能判死。
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function discardTabById(tabId) {
  const id = normalizeTabId(tabId);
  if (id === null) {
    return Promise.reject(new Error(`标签页 ID 无效：${String(tabId)}`));
  }
  return new Promise((resolve, reject) => {
    let result;
    try {
      result = chrome.tabs.discard(id);
    } catch (error) {
      reject(error);
      return;
    }
    if (result && typeof result.then === "function") {
      result.then(
        () => resolve(),
        (error) => reject(error instanceof Error ? error : new Error(String(error)))
      );
      return;
    }
    resolve();
  });
}

/**
 * 批量冻结。
 *
 * 前置要求：调用方负责保证 tabIds 里的标签确实存在且未被冻结（本函数不做校验）。
 * 返回失败清单而不是抛出：自动冻结的每次扫描都是"能做多少做多少"，
 * 单条失败（已关闭 / 是活动标签 / 页面禁止卸载）不应该中断整批，
 * 手动冻结则用返回的清单给出诚实的成功/跳过数量。
 *
 * @param {number[]} tabIds
 * @returns {Promise<Array<{tabId: number, error: Error}>>}
 */
async function discardTabs(tabIds) {
  const batchSize = 100;
  const failures = [];
  for (let i = 0; i < tabIds.length; i += batchSize) {
    const batch = tabIds.slice(i, i + batchSize);
    await Promise.all(
      batch.map((tabId) =>
        discardTabById(tabId).catch((error) => {
          failures.push({ tabId, error });
        })
      )
    );
    if (i + batchSize < tabIds.length) {
      await delay(150);
    }
  }
  return failures;
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
  const id = normalizeTabId(tabId);
  if (id === null) {
    throw new Error("缺少标签页 ID。");
  }
  await ensureDiscardSession();
  const config = await getDiscardConfig();
  const tab = await getTabById(id);
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
  const nextCount = (counts[id] || 0) + 1;
  counts[id] = nextCount;
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
  await discardTabById(id);
  discardSession.freezeCounts = counts;
  await recordDiscardBatch([item], now, config);
  return { item };
}

async function manualDiscardTabs(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) {
    throw new Error("缺少标签页 ID。");
  }
  await ensureDiscardSession();
  const config = await getDiscardConfig();
  // 先归一化再查询：非法 id 既查不到也没法 discard，直接算作跳过项。
  const ids = tabIds.map(normalizeTabId).filter((id) => id !== null);
  if (ids.length === 0) {
    throw new Error("缺少标签页 ID。");
  }
  const tabs = await getTabsByIds(ids);
  if (tabs.length === 0) {
    throw new Error("未找到标签页。");
  }
  const now = Date.now();
  const counts = discardSession.freezeCounts || {};
  const items = [];
  const discardIds = [];
  tabs.forEach((tab) => {
    if (!tab || !tab.id) {
      return;
    }
    if (tab.discarded) {
      return;
    }
    const lastActive = getLastActive(tab, now);
    const idleMinutes = Math.max(0, Math.floor((now - lastActive) / 60000));
    const nextCount = (counts[tab.id] || 0) + 1;
    counts[tab.id] = nextCount;
    discardIds.push(tab.id);
    items.push({
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || tab.url || "未命名",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || "",
      idleMinutes,
      lastActive,
      discardedAt: now,
      freezeCount: nextCount,
    });
  });
  if (discardIds.length === 0) {
    return { discarded: 0, skipped: tabIds.length };
  }
  const failures = await discardTabs(discardIds);
  discardSession.freezeCounts = counts;
  await recordDiscardBatch(items, now, config);
  // 失败的单条既不算成功也不算"已冻结跳过"以外的类别：统一并入 skipped，界面不会虚报成功数。
  return {
    discarded: discardIds.length - failures.length,
    skipped: tabIds.length - discardIds.length + failures.length,
  };
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
  if (tabId !== undefined && tabId !== null) {
    const key = String(tabId);
    if (tabFirstSeen.has(key)) {
      tabFirstSeen.delete(key);
      scheduleTabFirstSeenSave();
    }
  }
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
  if (tabFirstSeen.has(key)) {
    const firstSeen = tabFirstSeen.get(key);
    tabFirstSeen.delete(key);
    tabFirstSeen.set(String(addedTabId), firstSeen);
    scheduleTabFirstSeenSave();
  } else {
    markTabFirstSeen(addedTabId);
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
  manualDiscardTabs,
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
