function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTabsInBatches(ids, options = {}) {
  const batchSize = Number.isFinite(options.batchSize) ? options.batchSize : 100;
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : 150;
  let removed = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await new Promise((resolve) => {
      chrome.tabs.remove(batch, () => {
        if (!chrome.runtime.lastError) {
          removed += batch.length;
          resolve();
          return;
        }
        Promise.all(
          batch.map(
            (tabId) =>
              new Promise((innerResolve) => {
                chrome.tabs.remove(tabId, () => {
                  if (chrome.runtime.lastError) {
                    skipped += 1;
                  } else {
                    removed += 1;
                  }
                  innerResolve();
                });
              })
          )
        ).then(resolve);
      });
    });
    if (i + batchSize < ids.length) {
      await delay(gapMs);
    }
  }
  return { removed, skipped };
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

// 标签/保存项筛选：对标题与网址做不区分大小写的包含匹配。
// keyword 为空时视为不筛选，返回 true。
function matchesTabQuery(tab, keyword) {
  const kw = String(keyword || "").trim().toLowerCase();
  if (!kw) {
    return true;
  }
  const title = String((tab && tab.title) || "").toLowerCase();
  const url = String((tab && tab.url) || "").toLowerCase();
  return title.includes(kw) || url.includes(kw);
}

// 树状拖拽的落点分区：行上 1/4 → 插到该行之前（同级兄弟），行下 1/4 → 插到该行之后（同级兄弟），
// 中间 1/2 → 成为该行的子标签。分区口径与 TST 一致，管理页与 Firefox 侧边栏共用。
function getTreeDropZone(event) {
  const element = event && event.currentTarget;
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return "child";
  }
  const rect = element.getBoundingClientRect();
  if (!rect.height) {
    return "child";
  }
  const ratio = (event.clientY - rect.top) / rect.height;
  if (ratio < 0.25) {
    return "before";
  }
  if (ratio > 0.75) {
    return "after";
  }
  return "child";
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
  getTreeDropZone,
  matchesTabQuery,
  normalizeWhitelistInput,
  moveTabsInBatches,
  removeTabsInBatches,
};
