function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTabsInBatches(ids, options = {}) {
  const batchSize = Number.isFinite(options.batchSize) ? options.batchSize : 100;
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : 150;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await new Promise((resolve) => {
      chrome.tabs.remove(batch, () => resolve());
    });
    if (i + batchSize < ids.length) {
      await delay(gapMs);
    }
  }
}

async function moveTabsInBatches(tabIds, windowId, options = {}) {
  const batchSize = Number.isFinite(options.batchSize) ? options.batchSize : 100;
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : 150;
  const baseIndex = Number.isFinite(options.index) ? options.index : -1;
  let offset = 0;
  for (let i = 0; i < tabIds.length; i += batchSize) {
    const batch = tabIds.slice(i, i + batchSize);
    const targetIndex = baseIndex === -1 ? -1 : baseIndex + offset;
    await new Promise((resolve, reject) => {
      chrome.tabs.move(
        batch,
        { windowId, index: targetIndex },
        () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "移动失败"));
            return;
          }
          resolve();
        }
      );
    });
    offset += batch.length;
    if (i + batchSize < tabIds.length) {
      await delay(gapMs);
    }
  }
}

function getSelectedTabsFrom(selectionMap, sourceTabs) {
  const selected = new Set(Object.keys(selectionMap));
  const results = [];
  const seen = new Set();
  sourceTabs.forEach((tab) => {
    const key = String(tab.id);
    if (!selected.has(key) || seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(tab);
  });
  return results;
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

function formatLocalTime(timestamp) {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

function normalizeWhitelistInput(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export {
  delay,
  formatLocalTime,
  getBaseDomain,
  getSelectedTabsFrom,
  normalizeWhitelistInput,
  moveTabsInBatches,
  removeTabsInBatches,
};
