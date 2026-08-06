import { computed, reactive, ref } from "vue";
import { getSelectedTabsFrom, matchesTabQuery } from "../utils/helpers.js";

function useWindows(options = {}) {
  const hideDiscarded = options.hideDiscarded;
  const filterQuery = options.filterQuery;
  const filterMode = options.filterMode;
  const windows = ref([]);
  const selectedWindowId = ref("all");
  const selectedTabIds = reactive({});

  function shouldHideDiscarded() {
    return Boolean(hideDiscarded && hideDiscarded.value);
  }

  function getVisibleTabs(tabs) {
    const list = Array.isArray(tabs) ? tabs : [];
    if (!shouldHideDiscarded()) {
      return list;
    }
    return list.filter((tab) => !tab.discarded);
  }

  function getKeyword() {
    return filterQuery ? filterQuery.value : "";
  }

  function hasKeyword() {
    return Boolean(String(getKeyword() || "").trim());
  }

  // 仅“过滤”模式下才真正隐藏不匹配标签；跳转模式保持完整列表，只标记匹配项。
  function shouldFilterRows() {
    return filterMode ? filterMode.value === "filter" && hasKeyword() : hasKeyword();
  }

  function getDisplayTabs(tabs) {
    const keyword = getKeyword();
    const filtering = shouldFilterRows();
    return getVisibleTabs(tabs)
      .filter((tab) => (filtering ? matchesTabQuery(tab, keyword) : true))
      .map((tab) => ({
        ...tab,
        // 仅在存在关键词时标记匹配，避免无关键词时整表误高亮。
        matched: hasKeyword() && matchesTabQuery(tab, keyword),
      }));
  }

  const totalTabCount = computed(() =>
    windows.value.reduce((sum, win) => sum + getVisibleTabs(win.tabs).length, 0)
  );

  const windowSubItems = computed(() =>
    windows.value.map((win, index) => ({
      id: win.id,
      label: `窗口 ${index + 1}`,
      count: getVisibleTabs(win.tabs).length,
    }))
  );

  const windowsToRender = computed(() => {
    if (selectedWindowId.value === "all") {
      return windows.value;
    }
    return windows.value.filter(
      (win) => String(win.id) === String(selectedWindowId.value)
    );
  });

  const windowSubtitle = computed(() => {
    const tabCount = windowsToRender.value.reduce(
      (sum, win) => sum + getVisibleTabs(win.tabs).length,
      0
    );
    if (selectedWindowId.value === "all") {
      return `当前：全部窗口（共 ${tabCount} 个标签页）`;
    }
    const index = windows.value.findIndex(
      (win) => String(win.id) === String(selectedWindowId.value)
    );
    const label = index >= 0 ? `窗口 ${index + 1}` : "当前窗口";
    return `当前：${label}（共 ${tabCount} 个标签页）`;
  });

  const windowRows = computed(() => {
    const rows = [];
    let globalIndex = 0;
    windowsToRender.value.forEach((win) => {
      const actualIndex = windows.value.findIndex(
        (item) => String(item.id) === String(win.id)
      );
      const labelIndex = actualIndex >= 0 ? actualIndex + 1 : 1;
      const tabs = getDisplayTabs(win.tabs);
      if (tabs.length === 0 && shouldFilterRows()) {
        return;
      }
      rows.push({
        type: "window",
        key: `window-${win.id}`,
        label: `窗口 ${labelIndex}`,
        count: win.tabs ? win.tabs.length : 0,
      });

      if (tabs.length === 0) {
        rows.push({
          type: "empty",
          key: `empty-${win.id}`,
        });
        return;
      }

      tabs.forEach((tab) => {
        rows.push({
          type: "tab",
          key: `tab-${tab.id}`,
          tab: {
            id: tab.id,
            windowId: tab.windowId,
            title: tab.title,
            url: tab.url,
            favIconUrl: tab.favIconUrl,
            discarded: Boolean(tab.discarded),
            pinned: Boolean(tab.pinned),
          active: Boolean(tab.active),
          windowIndex: tab.index,
          index: globalIndex,
          matched: Boolean(tab.matched),
        },
      });
        globalIndex += 1;
      });
    });
    return rows;
  });

  function setSelectedWindow(windowId) {
    selectedWindowId.value = windowId;
    Object.keys(selectedTabIds).forEach((key) => delete selectedTabIds[key]);
  }

  function setVisibleSelection(checked) {
    windowsToRender.value.forEach((win) => {
      getDisplayTabs(win.tabs).forEach((tab) => {
        if (checked) {
          selectedTabIds[tab.id] = true;
        } else {
          delete selectedTabIds[tab.id];
        }
      });
    });
  }

  function toggleTab(tabId, checked) {
    if (checked) {
      selectedTabIds[tabId] = true;
    } else {
      delete selectedTabIds[tabId];
    }
  }

  function toggleTabSelection(tabId) {
    const key = String(tabId);
    if (selectedTabIds[key]) {
      delete selectedTabIds[key];
    } else {
      selectedTabIds[key] = true;
    }
  }

  function clearWindowSelection() {
    Object.keys(selectedTabIds).forEach((key) => delete selectedTabIds[key]);
  }

  function getWindowTabsFlat() {
    const results = [];
    windows.value.forEach((win) => {
      (win.tabs || []).forEach((tab) => {
        results.push(tab);
      });
    });
    return results;
  }

  function getSelectedWindowTabs() {
    const selected = getSelectedTabsFrom(selectedTabIds, getWindowTabsFlat());
    if (!shouldHideDiscarded()) {
      return selected;
    }
    return selected.filter((tab) => !tab.discarded);
  }

  async function loadWindows() {
    const data = await new Promise((resolve) => {
      chrome.windows.getAll({ populate: true }, (result) => resolve(result || []));
    });
    windows.value = data;
    const existing = new Set();
    windows.value.forEach((win) => {
      (win.tabs || []).forEach((tab) => {
        if (tab && tab.id) {
          existing.add(String(tab.id));
        }
      });
    });
    Object.keys(selectedTabIds).forEach((tabId) => {
      if (!existing.has(String(tabId))) {
        delete selectedTabIds[tabId];
      }
    });
    if (
      selectedWindowId.value !== "all" &&
      !windows.value.some((win) => String(win.id) === String(selectedWindowId.value))
    ) {
      selectedWindowId.value = "all";
    }
  }

  return {
    windows,
    selectedWindowId,
    selectedTabIds,
    totalTabCount,
    windowSubItems,
    windowSubtitle,
    windowRows,
    setSelectedWindow,
    setVisibleSelection,
    toggleTab,
    toggleTabSelection,
    clearWindowSelection,
    getSelectedWindowTabs,
    loadWindows,
  };
}

export { useWindows };
