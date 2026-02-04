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
