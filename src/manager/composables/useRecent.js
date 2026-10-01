import { computed, reactive, ref } from "vue";
import { getSelectedTabsFrom, matchesTabQuery } from "../utils/helpers.js";
import {
  applySelectionClick,
  clearSelection,
  pruneSelection,
  setManySelected,
  setSelectionChecked,
} from "../utils/selection.js";

function useRecent({ request, filterQuery, filterMode }) {
  const recentTabs = ref([]);
  const selectedRecentTabIds = reactive({});
  // 「连续选择」的锚点：最近一次被置为选中的标签 id（规则见 utils/selection.js）。
  const selectedAnchorId = ref(null);
  const lastReviewedAt = ref(0);
  const durationText = ref("");
  const startupActive = ref(false);

  function getKeyword() {
    return filterQuery ? filterQuery.value : "";
  }

  function hasKeyword() {
    return Boolean(String(getKeyword() || "").trim());
  }

  // 仅“过滤”模式下才隐藏不匹配项；跳转模式保持完整列表，只标记匹配项。
  function shouldFilterRows() {
    return filterMode ? filterMode.value === "filter" && hasKeyword() : hasKeyword();
  }

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

  const recentRows = computed(() => {
    const keyword = getKeyword();
    return recentTabs.value
      .filter((tab) => (shouldFilterRows() ? matchesTabQuery(tab, keyword) : true))
      .map((tab) => ({
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
          matched: hasKeyword() && matchesTabQuery(tab, keyword),
        },
      }));
  });

  function setRecentSelection(checked) {
    setManySelected(
      selectedRecentTabIds,
      recentRows.value.map((row) => row.tab.id),
      checked
    );
    // 全选/全不选不对应"某一行被选中"，锚点随之作废。
    selectedAnchorId.value = null;
  }

  /** 当前渲染出来的标签行 id（近期标签页是平铺列表，顺序即渲染顺序）。 */
  function visibleTabKeys() {
    return recentRows.value.map((row) => String(row.tab.id));
  }

  function toggleRecentTab(tabId, checked, options = {}) {
    selectedAnchorId.value = setSelectionChecked(selectedRecentTabIds, tabId, checked, {
      shiftKey: Boolean(options && options.shiftKey),
      orderedKeys: visibleTabKeys(),
      anchor: selectedAnchorId.value,
    });
  }

  function toggleRecentTabSelection(tabId, options = {}) {
    selectedAnchorId.value = applySelectionClick(selectedRecentTabIds, {
      key: tabId,
      shiftKey: Boolean(options && options.shiftKey),
      orderedKeys: visibleTabKeys(),
      anchor: selectedAnchorId.value,
    });
  }

  function clearRecentSelection() {
    clearSelection(selectedRecentTabIds);
    selectedAnchorId.value = null;
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
    // 标签关闭后选中项与锚点都可能已不存在：一起剪掉，避免下次 Shift 圈到错误区间。
    selectedAnchorId.value = pruneSelection(selectedRecentTabIds, existing, selectedAnchorId.value);
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
