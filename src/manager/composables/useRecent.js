import { computed, reactive, ref } from "vue";
import { getSelectedTabsFrom } from "../utils/helpers.js";

function useRecent({ request }) {
  const recentTabs = ref([]);
  const selectedRecentTabIds = reactive({});
  const lastReviewedAt = ref(0);
  const durationText = ref("");
  const startupActive = ref(false);

  const recentSubtitle = computed(() => {
    if (startupActive.value) {
      return "启动恢复中，近期统计将在恢复完成后开始。";
    }
    const count = recentTabs.value.length;
    if (!lastReviewedAt.value) {
      return `当前：共 ${count} 个近期标签页`;
    }
    return `过去 ${durationText.value} 新增未关闭标签页（共 ${count} 个）`;
  });

  const recentRows = computed(() =>
    recentTabs.value.map((tab) => ({
      type: "tab",
      key: `recent-${tab.id}`,
      tab: {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        discarded: Boolean(tab.discarded),
        pinned: Boolean(tab.pinned),
        active: Boolean(tab.active),
      },
    }))
  );

  function setRecentSelection(checked) {
    recentTabs.value.forEach((tab) => {
      if (!tab || !tab.id) {
        return;
      }
      if (checked) {
        selectedRecentTabIds[tab.id] = true;
      } else {
        delete selectedRecentTabIds[tab.id];
      }
    });
  }

  function toggleRecentTab(tabId, checked) {
    if (checked) {
      selectedRecentTabIds[tabId] = true;
    } else {
      delete selectedRecentTabIds[tabId];
    }
  }

  function toggleRecentTabSelection(tabId) {
    const key = String(tabId);
    if (selectedRecentTabIds[key]) {
      delete selectedRecentTabIds[key];
    } else {
      selectedRecentTabIds[key] = true;
    }
  }

  function clearRecentSelection() {
    Object.keys(selectedRecentTabIds).forEach((key) => delete selectedRecentTabIds[key]);
  }

  function getSelectedRecentTabs() {
    return getSelectedTabsFrom(selectedRecentTabIds, recentTabs.value);
  }

  async function loadRecentTabs() {
    const response = await request("getRecentTabs");
    if (!response.ok) {
      recentTabs.value = [];
      lastReviewedAt.value = 0;
      durationText.value = "";
      startupActive.value = false;
      clearRecentSelection();
      return;
    }
    recentTabs.value = Array.isArray(response.tabs) ? response.tabs : [];
    lastReviewedAt.value = Number(response.lastReviewedAt) || 0;
    durationText.value = String(response.durationText || "");
    startupActive.value = Boolean(response.startupActive);
    const existing = new Set(recentTabs.value.map((tab) => String(tab.id)));
    Object.keys(selectedRecentTabIds).forEach((tabId) => {
      if (!existing.has(String(tabId))) {
        delete selectedRecentTabIds[tabId];
      }
    });
  }

  async function markReviewed() {
    const response = await request("markRecentReviewed");
    if (response && response.ok) {
      lastReviewedAt.value = Number(response.lastReviewedAt) || Date.now();
      durationText.value = "";
      startupActive.value = false;
      clearRecentSelection();
    }
    await loadRecentTabs();
  }

  return {
    recentTabs,
    selectedRecentTabIds,
    recentSubtitle,
    recentRows,
    startupActive,
    setRecentSelection,
    toggleRecentTab,
    toggleRecentTabSelection,
    clearRecentSelection,
    getSelectedRecentTabs,
    loadRecentTabs,
    markReviewed,
  };
}

export { useRecent };
