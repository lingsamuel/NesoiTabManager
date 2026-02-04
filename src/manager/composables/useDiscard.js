import { computed, reactive, ref } from "vue";
import {
  formatLocalTime,
  getSelectedTabsFrom,
  normalizeWhitelistInput,
} from "../utils/helpers.js";

function useDiscard({ request, view }) {
  const discardConfig = reactive({
    enabled: false,
    idleMinutes: 20,
    sweepMinutes: 3,
    batchLimit: 20,
    historyLimit: 0,
    allowPinned: false,
    allowAudible: false,
    whitelist: "",
    matchMode: "domain",
    regexMode: false,
  });

  const discardConfigStatus = reactive({ message: "", type: "" });
  const discardDebugStatus = reactive({ message: "", type: "" });

  const discardHistoryBatches = ref([]);
  const discardHistorySummary = reactive({ total: 0, batches: 0, limit: 0 });
  const historySelectedTabIds = reactive({});

  const historyTabsFlat = computed(() => {
    const tabs = [];
    discardHistoryBatches.value.forEach((batch) => {
      (batch.items || []).forEach((item) => {
        if (!item || !item.id) {
          return;
        }
        const freezeCount = Number(item.freezeCount) || 1;
        tabs.push({
          id: item.id,
          windowId: item.windowId,
          title: item.title,
          url: item.url,
          favIconUrl: item.favIconUrl,
          discarded: true,
          freezeCount,
        });
      });
    });
    return tabs;
  });

  const historyRows = computed(() => {
    const rows = [];
    const batches = discardHistoryBatches.value || [];
    batches.forEach((batch, index) => {
      const label = batch.at ? `冻结时间：${formatLocalTime(batch.at)}` : "冻结记录";
      rows.push({
        type: "window",
        key: `batch-${batch.id || index}`,
        label,
        count: batch.items ? batch.items.length : 0,
      });
      (batch.items || []).forEach((item, itemIndex) => {
        const freezeCount = Number(item.freezeCount) || 1;
        rows.push({
          type: "tab",
          key: `batch-${batch.id || index}-tab-${item.id || itemIndex}`,
          tab: {
            id: item.id,
            windowId: item.windowId,
            title: item.title,
            url: item.url,
            favIconUrl: item.favIconUrl,
            discarded: true,
            freezeCount,
          },
        });
      });
      if (index < batches.length - 1) {
        rows.push({
          type: "separator",
          key: `batch-sep-${batch.id || index}`,
        });
      }
    });
    return rows;
  });

  const historySubtitle = computed(() => {
    const total = discardHistorySummary.total || 0;
    const batches = discardHistorySummary.batches || 0;
    const selected = Object.keys(historySelectedTabIds).length;
    const limit = discardHistorySummary.limit;
    const limitText = limit && limit > 0 ? `，上限 ${limit}` : "，不限制";
    const selectedText = selected > 0 ? `，已选 ${selected}` : "";
    return `共 ${batches} 批，记录 ${total} 条${limitText}${selectedText}`;
  });

  function setStatus(target, message, type) {
    target.message = message;
    target.type = type || "";
  }

  function setHistorySelection(checked) {
    historyTabsFlat.value.forEach((tab) => {
      if (checked) {
        historySelectedTabIds[tab.id] = true;
      } else {
        delete historySelectedTabIds[tab.id];
      }
    });
  }

  function toggleHistoryTab(tabId, checked) {
    if (checked) {
      historySelectedTabIds[tabId] = true;
    } else {
      delete historySelectedTabIds[tabId];
    }
  }

  function toggleHistoryTabSelection(tabId) {
    const key = String(tabId);
    if (historySelectedTabIds[key]) {
      delete historySelectedTabIds[key];
    } else {
      historySelectedTabIds[key] = true;
    }
  }

  function clearHistorySelection() {
    Object.keys(historySelectedTabIds).forEach((key) => delete historySelectedTabIds[key]);
  }

  function applyDiscardConfig(config) {
    discardConfig.enabled = Boolean(config.enabled);
    discardConfig.idleMinutes = Number.isFinite(Number(config.idleMinutes))
      ? Number(config.idleMinutes)
      : 20;
    discardConfig.sweepMinutes = Number.isFinite(Number(config.sweepMinutes))
      ? Number(config.sweepMinutes)
      : 3;
    discardConfig.batchLimit = Number.isFinite(Number(config.batchLimit))
      ? Number(config.batchLimit)
      : 20;
    discardConfig.historyLimit = Number.isFinite(Number(config.historyLimit))
      ? Number(config.historyLimit)
      : 0;
    discardConfig.allowPinned = Boolean(config.allowPinned);
    discardConfig.allowAudible = Boolean(config.allowAudible);
    discardConfig.matchMode =
      config.matchMode === "url" || config.matchMode === "full" ? config.matchMode : "domain";
    discardConfig.regexMode = Boolean(config.regexMode);
    discardConfig.whitelist = Array.isArray(config.whitelist)
      ? config.whitelist.join("\n")
      : "";
  }

  async function loadDiscardConfig() {
    const response = await request("getDiscardConfig");
    if (!response.ok) {
      setStatus(discardConfigStatus, response.error || "自动冻结配置加载失败。", "error");
      return;
    }
    applyDiscardConfig(response.config || {});
  }

  async function saveDiscardConfig() {
    const whitelist = normalizeWhitelistInput(discardConfig.whitelist);
    const payload = {
      enabled: Boolean(discardConfig.enabled),
      idleMinutes: Number(discardConfig.idleMinutes),
      sweepMinutes: Number(discardConfig.sweepMinutes),
      batchLimit: Number(discardConfig.batchLimit),
      historyLimit: Number(discardConfig.historyLimit),
      allowPinned: Boolean(discardConfig.allowPinned),
      allowAudible: Boolean(discardConfig.allowAudible),
      matchMode: discardConfig.matchMode,
      regexMode: Boolean(discardConfig.regexMode),
      whitelist,
    };
    const response = await request("saveDiscardConfig", { config: payload });
    if (!response.ok) {
      setStatus(discardConfigStatus, response.error || "保存失败。", "error");
      return;
    }
    applyDiscardConfig(response.config || payload);
    setStatus(discardConfigStatus, "自动冻结配置已保存。", "ok");
    if (view.value === "discard") {
      await loadDiscardHistory();
    }
  }

  async function loadDiscardHistory() {
    setStatus(discardDebugStatus, "正在刷新冻结历史...", "");
    const response = await request("getDiscardHistory");
    if (!response.ok) {
      setStatus(discardDebugStatus, response.error || "冻结历史加载失败。", "error");
      discardHistoryBatches.value = [];
      discardHistorySummary.total = 0;
      discardHistorySummary.batches = 0;
      return;
    }
    discardHistoryBatches.value = response.historyBatches || [];
    discardHistorySummary.total = Number(response.historyTotal) || 0;
    discardHistorySummary.batches = Number(response.historyBatchesCount) || 0;
    discardHistorySummary.limit = Number(response.historyLimit) || 0;
    const existing = new Set(historyTabsFlat.value.map((tab) => String(tab.id)));
    Object.keys(historySelectedTabIds).forEach((tabId) => {
      if (!existing.has(String(tabId))) {
        delete historySelectedTabIds[tabId];
      }
    });
    if (!response.enabled) {
      setStatus(discardDebugStatus, "自动冻结未开启，请先在设置中启用。", "error");
      return;
    }
    setStatus(discardDebugStatus, "冻结历史已更新。", "ok");
  }

  function getSelectedHistoryTabs() {
    return getSelectedTabsFrom(historySelectedTabIds, historyTabsFlat.value);
  }

  return {
    discardConfig,
    discardConfigStatus,
    discardDebugStatus,
    discardHistoryBatches,
    discardHistorySummary,
    historySelectedTabIds,
    historySubtitle,
    historyRows,
    setHistorySelection,
    toggleHistoryTab,
    toggleHistoryTabSelection,
    clearHistorySelection,
    getSelectedHistoryTabs,
    loadDiscardConfig,
    saveDiscardConfig,
    loadDiscardHistory,
  };
}

export { useDiscard };
