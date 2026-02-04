const STORAGE_KEY = "lists";
const AI_CONFIG_KEY = "aiConfig";
const DISCARD_CONFIG_KEY = "discardConfig";
const DISCARD_ALARM = "discardSweep";
const MANAGER_PAGE = "ui/manager.html";

const tabLastActive = new Map();
const activeTabByWindow = new Map();
let focusedWindowId = null;
let tabActivityReady = false;
let tabActivityPromise = null;
let discardSweepRunning = false;
let discardConfigCache = null;

function clearActionPopup() {
  if (chrome.action && chrome.action.setPopup) {
    chrome.action.setPopup({ popup: "" });
  }
}

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key]));
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function generateId() {
  return `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeListName(name) {
  return (name || "").trim();
}

function normalizeListDescription(description) {
  return (description || "").trim();
}

function sanitizeAiConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const endpoint = String(config.endpoint || "https://api.openai.com/v1/responses").trim();
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "gpt-4.1-mini").trim();
  const apiMode = config.apiMode === "chat" || config.apiMode === "codex" ? config.apiMode : "responses";
  const maxTabs = Number.isFinite(Number(config.maxTabs))
    ? Math.max(10, Math.min(500, Number(config.maxTabs)))
    : 120;
  const includeListTitles =
    config.includeListTitles === undefined ? true : Boolean(config.includeListTitles);
  return {
    endpoint,
    apiKey,
    model,
    apiMode,
    maxTabs,
    includeListTitles,
  };
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
    allowPinned,
    allowAudible,
    matchMode,
    regexMode,
    whitelist,
  };
}

async function getAiConfig() {
  const stored = await storageGet(AI_CONFIG_KEY);
  return sanitizeAiConfig(stored || {});
}

async function setAiConfig(config) {
  const sanitized = sanitizeAiConfig(config);
  await storageSet({ [AI_CONFIG_KEY]: sanitized });
  return sanitized;
}

function resetTabActivity() {
  tabLastActive.clear();
  activeTabByWindow.clear();
  focusedWindowId = null;
  tabActivityReady = false;
  tabActivityPromise = null;
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
  }
  await ensureDiscardAlarm(sanitized);
  return sanitized;
}

function ensureUniqueListName(existingNames, baseName) {
  let name = baseName;
  let counter = 2;
  while (existingNames.has(name)) {
    name = `${baseName}（${counter}）`;
    counter += 1;
  }
  return name;
}

function getBaseDomain(url) {
  if (!url) {
    return "";
  }
  try {
    const hostname = new URL(url).hostname || "";
    const cleaned = hostname.replace(/^www\./, "");
    const parts = cleaned.split(".");
    if (parts.length <= 2) {
      return cleaned;
    }
    return parts.slice(-2).join(".");
  } catch (error) {
    return "";
  }
}

function getUrlWithoutParams(url) {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (error) {
    return "";
  }
}

function isDiscardableUrl(url) {
  if (!url) {
    return false;
  }
  const lower = String(url).toLowerCase();
  if (lower.startsWith("chrome://")) {
    return false;
  }
  if (lower.startsWith("edge://")) {
    return false;
  }
  if (lower.startsWith("about:")) {
    return false;
  }
  if (lower.startsWith("chrome-extension://")) {
    return false;
  }
  if (lower.startsWith("moz-extension://")) {
    return false;
  }
  if (lower.startsWith("extension://")) {
    return false;
  }
  return true;
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

function getLastActive(tabId, now) {
  const key = String(tabId);
  if (!tabLastActive.has(key)) {
    tabLastActive.set(key, now);
    return now;
  }
  return tabLastActive.get(key);
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
    queryAllTabs().then((tabs) => {
      const now = Date.now();
      tabs.forEach((tab) => {
        if (tab && tab.id !== undefined) {
          tabLastActive.set(String(tab.id), now);
          if (tab.active && tab.windowId !== undefined) {
            activeTabByWindow.set(tab.windowId, tab.id);
          }
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
  const lastActive = getLastActive(tab.id, now);
  const idleMs = now - lastActive;
  if (idleMs < config.idleMinutes * 60 * 1000) {
    return null;
  }
  return { lastActive, idleMinutes: Math.floor(idleMs / 60000) };
}

async function discardTabs(tabIds) {
  await Promise.all(
    tabIds.map(
      (tabId) =>
        new Promise((resolve) => {
          chrome.tabs.discard(tabId, () => resolve());
        })
    )
  );
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
    await ensureTabActivity();
    const now = Date.now();
    const tabs = await queryAllTabs();
    const candidates = [];
    for (let i = 0; i < tabs.length; i += 1) {
      const tab = tabs[i];
      const result = evaluateDiscardCandidate(tab, config, now);
      if (!result) {
        continue;
      }
      candidates.push(tab.id);
      if (candidates.length >= config.batchLimit) {
        break;
      }
    }
    if (candidates.length > 0) {
      await discardTabs(candidates);
    }
  } finally {
    discardSweepRunning = false;
  }
}

async function getDiscardCandidates(limit) {
  const config = await getDiscardConfig();
  if (!config.enabled) {
    return { candidates: [], total: 0, enabled: false };
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
  return { candidates, total, enabled: config.enabled };
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
    .then((config) => ensureDiscardAlarm(config))
    .catch(() => {});
}

function normalizeTabItems(items) {
  return items
    .map((item) => ({
      tabId: String(item.tabId || "").trim(),
      title: String(item.title || "").trim(),
      domain: String(item.domain || "").trim(),
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : 0,
    }))
    .filter((item) => item.tabId);
}

function normalizeListHint(raw) {
  if (typeof raw === "string") {
    const name = normalizeListName(raw);
    return name ? { name, description: "" } : null;
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const name = normalizeListName(raw.name);
  if (!name) {
    return null;
  }
  const description = normalizeListDescription(raw.description);
  return { name, description };
}

function buildAiPrompt(items, listHints) {
  const limitedLists = Array.isArray(listHints) ? listHints.slice(0, 100) : [];
  const normalizedHints = limitedLists.map(normalizeListHint).filter(Boolean);
  const payload = {
    tabs: items.map((item) => ({
      tabId: item.tabId,
      title: item.title,
      domain: item.domain,
      index: item.index,
    })),
    listHints: normalizedHints,
  };

  const system = [
    "你是浏览器标签页分组助手。",
    "请根据标题、基础域名、以及打开顺序（index 越小越靠前）进行分组。",
    "分组需考虑主题相关性与“相邻打开”的连续性。",
    "输出必须是严格 JSON，不要输出多余文字。",
    "你在聚类时要优先考虑标题内容，次要考虑域名，并且避免按域名聚类，因为同域名下可能包含大量不同内容。",
    "如果一个内容可以正确被聚类到给出的参考分组中，则优先设置为该参考分组。",
    "如果一个内容难以识别具体内容，则可以分类为“未识别”。",
    "如果一个内容是简单的搜索词条，则识别这个词条可能的含义进行聚类。"
  ].join("\n");

  const user = [
    "请把输入的标签页分成若干组，每组给出简短中文标签。",
    "规则：",
    "1) 主题相近优先，聚类优先考虑标题内容。",
    "2) 连续打开的标签更容易归到同一组。",
    "3) 组数不要过多，优先合并相关内容。",
    "4) tabIds 必须来自输入，禁止编造。",
    "如提供已有列表参考（标题/描述），可作为标签命名提示。",
    "输出格式：",
    "{",
    '  "groups": [',
    '    { "label": "分组名", "tabIds": ["id1", "id2"] }',
    "  ]",
    "}",
    "输入数据：",
    JSON.stringify(payload),
  ].join("\n");

  return { system, user };
}

function extractResponseText(data, mode) {
  if (!data) {
    return "";
  }
  if (mode === "chat") {
    return String(data.choices?.[0]?.message?.content || "").trim();
  }
  if (typeof data.output_text === "string") {
    return data.output_text.trim();
  }
  if (Array.isArray(data.output)) {
    const parts = [];
    data.output.forEach((item) => {
      if (Array.isArray(item.content)) {
        item.content.forEach((content) => {
          if ((content.type === "output_text" || content.type === "text") && content.text) {
            parts.push(content.text);
          }
        });
      }
    });
    return parts.join("\n").trim();
  }
  if (typeof data.text === "string") {
    return data.text.trim();
  }
  return "";
}

function isEventStreamResponse(text, contentType) {
  if (contentType && contentType.includes("text/event-stream")) {
    return true;
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    return true;
  }
  return text.includes("\nevent:") || text.includes("\r\nevent:");
}

function extractResponseTextFromEventStream(text, mode) {
  const lines = text.split(/\r?\n/);
  const collected = [];
  let doneText = "";
  let itemText = "";
  let responseData = null;
  let dataLines = [];

  function flush() {
    if (dataLines.length === 0) {
      return;
    }
    const raw = dataLines.join("\n").trim();
    dataLines = [];
    if (!raw || raw === "[DONE]") {
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      return;
    }
    if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
      collected.push(payload.delta);
      return;
    }
    if (payload.type === "response.output_text.done" && typeof payload.text === "string") {
      doneText = payload.text;
      return;
    }
    if (payload.type === "response.output_item.done" && payload.item) {
      const textFromItem = extractResponseText({ output: [payload.item] }, mode);
      if (textFromItem) {
        itemText = textFromItem;
      }
      return;
    }
    if (payload.type === "response.completed" && payload.response) {
      responseData = payload.response;
    }
  }

  lines.forEach((line) => {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      return;
    }
    if (line === "") {
      flush();
    }
  });
  flush();

  if (responseData) {
    const textFromResponse = extractResponseText(responseData, mode);
    if (textFromResponse) {
      return textFromResponse;
    }
  }
  if (doneText) {
    return doneText.trim();
  }
  if (itemText) {
    return itemText.trim();
  }
  if (collected.length > 0) {
    return collected.join("").trim();
  }
  return "";
}

function parseAiGroups(text, allowedIds) {
  if (!text) {
    throw new Error("AI 返回内容为空。");
  }
  let content = text.trim();
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    content = fenceMatch[1].trim();
  }
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    content = content.slice(firstBrace, lastBrace + 1);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error("无法解析 AI 返回的 JSON。");
  }
  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
  if (groups.length === 0) {
    throw new Error("AI 未返回有效分组。");
  }

  const allowedSet = new Set(allowedIds);
  const assigned = new Set();
  const normalized = [];
  groups.forEach((group, index) => {
    const rawLabel = String(group.label || "").trim();
    const label = rawLabel || `分组 ${index + 1}`;
    const tabIds = Array.isArray(group.tabIds) ? group.tabIds : [];
    const filtered = tabIds
      .map((tabId) => String(tabId))
      .filter((tabId) => allowedSet.has(tabId) && !assigned.has(tabId));
    filtered.forEach((tabId) => assigned.add(tabId));
    if (filtered.length > 0) {
      normalized.push({ label, tabIds: filtered });
    }
  });

  const remaining = Array.from(allowedSet).filter((tabId) => !assigned.has(tabId));
  if (remaining.length > 0) {
    normalized.push({ label: "未分组", tabIds: remaining });
  }

  return normalized;
}

async function requestAiGrouping(config, items, listHints) {
  const endpoint = config.endpoint;
  const mode = config.apiMode || "responses";
  const prompt = buildAiPrompt(items, listHints);
  let payload = null;
  if (mode === "chat") {
    payload = {
      model: config.model,
      temperature: 0.2,
      messages: [
        { role: "user", content: prompt.system }, // 不能写System而要是user，因为端点要求如此。
        { role: "user", content: prompt.user },
      ],
    };
  } else if (mode === "codex") {
    const combined = `${prompt.system}\n\n${prompt.user}`;
    payload = {
      model: config.model,
      temperature: 0.2,
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: combined }],
        },
      ],
    };
  } else {
    payload = {
      model: config.model,
      temperature: 0.2,
      max_output_tokens: 1200,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt.system }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt.user }],
        },
      ],
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`AI 请求失败：${response.status} ${responseText}`);
  }
  const contentType = response.headers.get("content-type") || "";
  let text = "";
  if (isEventStreamResponse(responseText, contentType)) {
    text = extractResponseTextFromEventStream(responseText, mode);
  } else {
    let data = null;
    try {
      data = JSON.parse(responseText);
    } catch (error) {
      throw new Error("AI 返回的响应不是 JSON。");
    }
    text = extractResponseText(data, mode);
  }
  const allowedIds = items.map((item) => item.tabId);
  return parseAiGroups(text, allowedIds);
}

async function saveGroupedTabs(groups) {
  const lists = await getLists();
  const existingNames = new Set(lists.map((list) => list.name));
  const createdLists = [];

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const label = normalizeListName(group.label) || `分组 ${i + 1}`;
    const baseName = `AI 分组：${label}`;
    const name = ensureUniqueListName(existingNames, baseName);
    existingNames.add(name);
    const tabs = await getTabsByIds(Array.isArray(group.tabIds) ? group.tabIds : []);
    const items = tabs.map(tabToItem).filter((item) => item.url);
    if (items.length === 0) {
      continue;
    }
    createdLists.push({ id: generateId(), name, description: "", items });
  }

  if (createdLists.length > 0) {
    lists.push(...createdLists);
    await setLists(lists);
  }

  return { created: createdLists.length };
}

function tabToItem(tab) {
  const url = tab && tab.url ? tab.url : "";
  const title = tab && tab.title ? tab.title : url || "未命名";
  return {
    url,
    title,
    favIconUrl: tab && tab.favIconUrl ? tab.favIconUrl : "",
    savedAt: new Date().toISOString(),
  };
}

async function getLists() {
  const lists = await storageGet(STORAGE_KEY);
  return Array.isArray(lists) ? lists : [];
}

async function setLists(lists) {
  await storageSet({ [STORAGE_KEY]: lists });
}

async function renameList(listId, name) {
  const trimmed = normalizeListName(name);
  if (!trimmed) {
    throw new Error("列表名称不能为空。");
  }
  const lists = await getLists();
  const target = lists.find((list) => list.id === listId);
  if (!target) {
    throw new Error("未找到对应列表。");
  }
  target.name = trimmed;
  await setLists(lists);
  return { listId, name: trimmed };
}

async function deleteList(listId) {
  const lists = await getLists();
  const next = lists.filter((list) => list.id !== listId);
  if (next.length === lists.length) {
    throw new Error("未找到对应列表。");
  }
  await setLists(next);
  return { listId };
}

async function deleteListItems(listId, indices) {
  const lists = await getLists();
  const target = lists.find((list) => list.id === listId);
  if (!target) {
    throw new Error("未找到对应列表。");
  }
  const indexSet = new Set(
    (Array.isArray(indices) ? indices : [])
      .map((item) => Number(item))
      .filter((num) => Number.isFinite(num))
  );
  if (indexSet.size === 0) {
    throw new Error("没有有效的删除索引。");
  }
  const originalCount = target.items.length;
  target.items = target.items.filter((_, index) => !indexSet.has(index));
  await setLists(lists);
  return { removed: originalCount - target.items.length };
}

async function moveListItems(listId, indices, targetListId, newListName) {
  const lists = await getLists();
  const source = lists.find((list) => list.id === listId);
  if (!source) {
    throw new Error("未找到源列表。");
  }
  const indexSet = new Set(
    (Array.isArray(indices) ? indices : [])
      .map((item) => Number(item))
      .filter((num) => Number.isFinite(num))
  );
  if (indexSet.size === 0) {
    throw new Error("没有有效的移动索引。");
  }

  let target = null;
  if (targetListId) {
    target = lists.find((list) => list.id === targetListId) || null;
  }
  if (target && target.id === source.id) {
    throw new Error("目标列表不能是当前列表。");
  }
  if (!target) {
    const name = normalizeListName(newListName);
    if (!name) {
      throw new Error("需要目标列表名称。");
    }
    target = { id: generateId(), name, description: "", items: [] };
    lists.push(target);
  }

  const sorted = Array.from(indexSet).sort((a, b) => a - b);
  const itemsToMove = sorted.map((index) => source.items[index]).filter(Boolean);
  if (itemsToMove.length === 0) {
    throw new Error("没有可移动的标签。");
  }

  source.items = source.items.filter((_, index) => !indexSet.has(index));
  target.items.push(...itemsToMove);
  await setLists(lists);

  return { moved: itemsToMove.length, targetListId: target.id };
}

async function updateListDescription(listId, description) {
  const lists = await getLists();
  const target = lists.find((list) => list.id === listId);
  if (!target) {
    throw new Error("未找到对应列表。");
  }
  target.description = normalizeListDescription(description);
  await setLists(lists);
  return { listId, description: target.description };
}

async function createList(name, description) {
  const trimmed = normalizeListName(name);
  if (!trimmed) {
    throw new Error("列表名称不能为空。");
  }
  const lists = await getLists();
  const list = {
    id: generateId(),
    name: trimmed,
    description: normalizeListDescription(description),
    items: [],
  };
  lists.push(list);
  await setLists(lists);
  return { list };
}

function sanitizeImportedList(rawList) {
  const name = normalizeListName(rawList && rawList.name ? rawList.name : "");
  if (!name) {
    return null;
  }
  const description = normalizeListDescription(
    rawList && rawList.description ? rawList.description : ""
  );
  const items = Array.isArray(rawList.items) ? rawList.items : [];
  const sanitizedItems = items
    .map((item) => ({
      url: item && item.url ? String(item.url) : "",
      title: item && item.title ? String(item.title) : "",
      favIconUrl: item && item.favIconUrl ? String(item.favIconUrl) : "",
      savedAt: item && item.savedAt ? String(item.savedAt) : new Date().toISOString(),
    }))
    .filter((item) => item.url);
  return {
    id: rawList && rawList.id ? String(rawList.id) : generateId(),
    name,
    description,
    items: sanitizedItems,
  };
}

async function getTabsByIds(tabIds) {
  const results = await Promise.all(
    tabIds.map(
      (tabId) =>
        new Promise((resolve) => {
          chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(tab || null);
          });
        })
    )
  );
  return results.filter(Boolean);
}

async function saveTabs({ tabIds, listId, newListName, closeTabs, newListDescription }) {
  const lists = await getLists();
  let targetList = null;

  if (listId) {
    targetList = lists.find((list) => list.id === listId) || null;
  }

  if (!targetList) {
    const name = normalizeListName(newListName);
    if (!name) {
      throw new Error("需要列表名称。");
    }
    targetList = {
      id: generateId(),
      name,
      description: normalizeListDescription(newListDescription),
      items: [],
    };
    lists.push(targetList);
  }

  const tabs = await getTabsByIds(tabIds);
  const items = tabs.map(tabToItem).filter((item) => item.url);

  if (items.length === 0) {
    throw new Error("没有可保存的标签页。");
  }

  targetList.items.push(...items);
  await setLists(lists);

  if (closeTabs) {
    const closeIds = tabs.map((tab) => tab.id).filter(Boolean);
    if (closeIds.length > 0) {
      chrome.tabs.remove(closeIds);
    }
  }

  return { listId: targetList.id, savedCount: items.length };
}

async function saveCurrentTab({ tab, listId, newListName, closeTab }) {
  if (!tab || !tab.id) {
    throw new Error("没有活动标签页。");
  }
  const result = await saveTabs({
    tabIds: [tab.id],
    listId,
    newListName,
    closeTabs: closeTab,
  });
  return result;
}

async function rebuildContextMenus() {
  const lists = await getLists();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "saveTo",
      title: "保存到列表",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "saveCloseTo",
      title: "关闭并保存到列表",
      contexts: ["page"],
    });

    if (lists.length === 0) {
      chrome.contextMenus.create({
        id: "saveTo-empty",
        title: "暂无列表",
        parentId: "saveTo",
        contexts: ["page"],
        enabled: false,
      });
      chrome.contextMenus.create({
        id: "saveCloseTo-empty",
        title: "暂无列表",
        parentId: "saveCloseTo",
        contexts: ["page"],
        enabled: false,
      });
      return;
    }

    lists.forEach((list) => {
      chrome.contextMenus.create({
        id: `save:${list.id}`,
        title: list.name,
        parentId: "saveTo",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: `saveClose:${list.id}`,
        title: list.name,
        parentId: "saveCloseTo",
        contexts: ["page"],
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  clearActionPopup();
  rebuildContextMenus();
  resetTabActivity();
  initializeDiscardSystem();
});

chrome.runtime.onStartup.addListener(() => {
  clearActionPopup();
  rebuildContextMenus();
  resetTabActivity();
  initializeDiscardSystem();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === DISCARD_ALARM) {
    runDiscardSweep();
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
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
});

chrome.windows.onFocusChanged.addListener((windowId) => {
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
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab && tab.id !== undefined) {
    touchTab(tab.id);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabLastActive.delete(String(tabId));
  activeTabByWindow.forEach((value, key) => {
    if (value === tabId) {
      activeTabByWindow.delete(key);
    }
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
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
});

chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL(MANAGER_PAGE);
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length > 0) {
      const target = tabs[0];
      if (target.windowId) {
        chrome.windows.update(target.windowId, { focused: true });
      }
      if (target.id) {
        chrome.tabs.update(target.id, { active: true });
      }
      return;
    }
    chrome.tabs.create({ url });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes[STORAGE_KEY]) {
    rebuildContextMenus();
  }
  if (changes[DISCARD_CONFIG_KEY]) {
    discardConfigCache = sanitizeDiscardConfig(changes[DISCARD_CONFIG_KEY].newValue || {});
    ensureDiscardAlarm(discardConfigCache);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId || !tab || !tab.id) {
    return;
  }
  const menuId = String(info.menuItemId);
  if (menuId.includes("-empty")) {
    return;
  }
  const [action, listId] = menuId.split(":");
  if (!listId) {
    return;
  }
  const closeTab = action === "saveClose";
  try {
    await saveCurrentTab({ tab, listId, closeTab });
  } catch (error) {
    console.warn("右键菜单保存失败：", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message && message.action ? message.action : "";

  if (action === "getLists") {
    getLists()
      .then((lists) => sendResponse({ ok: true, lists }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (action === "saveTabs") {
    const payload = {
      tabIds: Array.isArray(message.tabIds) ? message.tabIds : [],
      listId: message.listId || "",
      newListName: message.newListName || "",
      newListDescription: message.newListDescription || "",
      closeTabs: Boolean(message.closeTabs),
    };
    saveTabs(payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveCurrentTab") {
    const payload = {
      tab: sender.tab,
      listId: message.listId || "",
      newListName: message.newListName || "",
      closeTab: Boolean(message.closeTab),
    };
    saveCurrentTab(payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "renameList") {
    const listId = message.listId || "";
    const name = message.name || "";
    renameList(listId, name)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "updateListDescription") {
    const listId = message.listId || "";
    const description = message.description || "";
    updateListDescription(listId, description)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "createList") {
    const name = message.name || "";
    const description = message.description || "";
    createList(name, description)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "deleteList") {
    const listId = message.listId || "";
    deleteList(listId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "deleteListItems") {
    const listId = message.listId || "";
    const indices = message.indices || [];
    deleteListItems(listId, indices)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "moveListItems") {
    const listId = message.listId || "";
    const indices = message.indices || [];
    const targetListId = message.targetListId || "";
    const newListName = message.newListName || "";
    moveListItems(listId, indices, targetListId, newListName)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getAiConfig") {
    getAiConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveAiConfig") {
    setAiConfig(message.config || {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getDiscardConfig") {
    getDiscardConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveDiscardConfig") {
    setDiscardConfig(message.config || {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "getDiscardCandidates") {
    const limit = Number.isFinite(Number(message.limit)) ? Math.max(1, Number(message.limit)) : 200;
    getDiscardCandidates(limit)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "aiGroupTabs") {
    const rawItems = Array.isArray(message.items) ? message.items : [];
    if (rawItems.length === 0) {
      sendResponse({ ok: false, error: "没有可分组的标签页。" });
      return false;
    }
    (async () => {
      const config = await getAiConfig();
      if (!config.endpoint || !config.apiKey || !config.model) {
        sendResponse({ ok: false, error: "请先在设置中配置 AI 端点与 Key。" });
        return;
      }
      const normalized = normalizeTabItems(rawItems).sort((a, b) => a.index - b.index);
      const maxTabs = config.maxTabs || 120;
      const limited = normalized.slice(0, maxTabs);
      const truncated = normalized.length > limited.length ? normalized.length - limited.length : 0;
      const listHints = config.includeListTitles
        ? (await getLists()).map((list) => ({
            name: list.name,
            description: list.description || "",
          }))
        : [];
      const groups = await requestAiGrouping(config, limited, listHints);
      if (!groups.length) {
        sendResponse({ ok: false, error: "未生成有效分组。" });
        return;
      }
      sendResponse({ ok: true, result: { groups, truncated, used: limited.length } });
    })().catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "saveGroupedTabs") {
    const groups = Array.isArray(message.groups) ? message.groups : [];
    if (groups.length === 0) {
      sendResponse({ ok: false, error: "没有可应用的分组。" });
      return false;
    }
    saveGroupedTabs(groups)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (action === "importLists") {
    const mode = message.mode === "replace" ? "replace" : "merge";
    const rawLists = message.lists;
    if (!Array.isArray(rawLists)) {
      sendResponse({ ok: false, error: "导入格式无效。" });
      return false;
    }
    (async () => {
      const incoming = rawLists.map(sanitizeImportedList).filter(Boolean);
      if (incoming.length === 0) {
        sendResponse({ ok: false, error: "没有可导入的有效列表。" });
        return;
      }
      if (mode === "replace") {
        await setLists(incoming);
        sendResponse({ ok: true, result: { imported: incoming.length, mode } });
        return;
      }
      const existing = await getLists();
      const existingIds = new Set(existing.map((list) => list.id));
      incoming.forEach((list) => {
        if (existingIds.has(list.id)) {
          list.id = generateId();
        }
        existingIds.add(list.id);
        existing.push(list);
      });
      await setLists(existing);
      sendResponse({ ok: true, result: { imported: incoming.length, mode } });
    })().catch((error) =>
      sendResponse({ ok: false, error: String(error.message || error) })
    );
    return true;
  }

  return false;
});

initializeDiscardSystem();
