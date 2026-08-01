export function generateId() {
  return `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeListName(name) {
  return (name || "").trim();
}

export function normalizeListDescription(description) {
  return (description || "").trim();
}

export function ensureUniqueListName(existingNames, baseName) {
  let name = baseName;
  let counter = 2;
  while (existingNames.has(name)) {
    name = `${baseName}（${counter}）`;
    counter += 1;
  }
  return name;
}

export function getBaseDomain(url) {
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

export function getUrlWithoutParams(url) {
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

export function isDiscardableUrl(url) {
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

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 将毫秒时长格式化为自适应中文描述：不足 1 小时显示“X分钟”，
// 不足 1 天显示“X小时Y分钟”，否则显示“X天Y小时Z分钟”。
// 非最高位的零值分量省略（如 120 分钟显示“2小时”而非“2小时0分钟”），
// 最短按 1 分钟展示，避免时长过短时出现“0分钟”。
export function formatDuration(ms) {
  const totalMinutes = Math.max(1, Math.floor((Number(ms) || 0) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) {
    parts.push(`${days}天`);
  }
  if (hours > 0) {
    parts.push(`${hours}小时`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}分钟`);
  }
  return parts.join("");
}
