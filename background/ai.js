import { storageGet, storageSet } from "./storage.js";
import { AI_CONFIG_KEY } from "./constants.js";
import { getLists } from "./lists.js";

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

async function getAiConfig() {
  const stored = await storageGet(AI_CONFIG_KEY);
  return sanitizeAiConfig(stored || {});
}

async function setAiConfig(config) {
  const sanitized = sanitizeAiConfig(config);
  await storageSet({ [AI_CONFIG_KEY]: sanitized });
  return sanitized;
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
    const name = String(raw || "").trim();
    return name ? { name, description: "" } : null;
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const name = String(raw.name || "").trim();
  if (!name) {
    return null;
  }
  const description = String(raw.description || "").trim();
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
    "如果一个内容是简单的搜索词条，则识别这个词条可能的含义进行聚类。",
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
        { role: "user", content: prompt.system },
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

async function aiGroupTabs(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("没有可分组的标签页。");
  }
  const config = await getAiConfig();
  if (!config.endpoint || !config.apiKey || !config.model) {
    throw new Error("请先在设置中配置 AI 端点与 Key。");
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
    throw new Error("未生成有效分组。");
  }
  return { groups, truncated, used: limited.length };
}

export { getAiConfig, setAiConfig, aiGroupTabs };
