import { computed, reactive, ref } from "vue";
// 树的扁平化（DFS 顺序、折叠隐藏、被隐藏父标签的就近提升）与后台、基准测试共用同一份实现，
// 避免"基准测的是一套、线上跑的是另一套"。
import { flattenTree } from "../../../background/tree_core.js";
import { getSelectedTabsFrom, matchesTabQuery } from "../utils/helpers.js";

function useWindows(options = {}) {
  const hideDiscarded = options.hideDiscarded;
  const filterQuery = options.filterQuery;
  const filterMode = options.filterMode;
  // 树状视图的状态（可缺省：缺省时全部行为与之前的平铺模式一致）。
  const tree = options.tree || null;
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

  function isTreeMode() {
    return Boolean(tree && tree.mode && tree.mode.value);
  }

  function byIndex(left, right) {
    return (left.index || 0) - (right.index || 0);
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

  /**
   * 树状模式下的可见标签集合。
   *
   * 与平铺模式的关键差异：过滤时不能只留下匹配项，否则树会断成一片片的孤立节点，
   * 因此要把匹配项的**全部祖先**一并保留（祖先只作为路径显示，不算匹配项）。
   * 返回的 parentMap 覆盖全部可见标签（包含被隐藏的父标签），
   * 这样 flattenTree 才能在父标签不可见时把子标签就近提升。
   */
  function buildTreeRender(win) {
    const visible = getVisibleTabs(win.tabs).slice().sort(byIndex);
    const parents = tree.parentsFor(win.id);
    const keep = new Set();
    const keyword = getKeyword();
    const filtering = shouldFilterRows();

    if (filtering) {
      for (const tab of visible) {
        if (!matchesTabQuery(tab, keyword)) {
          continue;
        }
        // 沿父链向上补齐祖先，直到遇到已保留的节点或顶层。
        let cursor = String(tab.id);
        let guard = 0;
        while (guard <= visible.length) {
          if (keep.has(cursor)) {
            break;
          }
          keep.add(cursor);
          const parentId = parents[cursor];
          if (parentId === undefined || parentId === null) {
            break;
          }
          cursor = String(parentId);
          guard += 1;
        }
      }
    } else {
      for (const tab of visible) {
        keep.add(String(tab.id));
      }
    }

    const tabs = [];
    const markMatches = hasKeyword();
    for (const tab of visible) {
      if (keep.has(String(tab.id))) {
        // 与平铺模式一致：只有真正匹配的标签才标记 matched，被补齐的祖先只作为路径显示。
        tabs.push({
          ...tab,
          matched: markMatches && matchesTabQuery(tab, keyword),
        });
      }
    }

    const parentMap = new Map();
    for (const [childId, parentId] of Object.entries(parents)) {
      const child = Number(childId);
      const parent = Number(parentId);
      if (Number.isFinite(child) && Number.isFinite(parent)) {
        parentMap.set(child, parent);
      }
    }
    return { tabs, parentMap };
  }

  function makeTabRow(tab, index, treeInfo) {
    return {
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
        index,
        matched: Boolean(tab.matched),
        depth: treeInfo.depth || 0,
        hasChildren: Boolean(treeInfo.hasChildren),
        collapsed: Boolean(treeInfo.collapsed),
      },
    };
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
    const treeMode = isTreeMode();
    // 关键词存在时忽略折叠状态：否则匹配项可能被折叠的祖先藏起来，导致"搜到了却看不见"。
    const forceExpand = hasKeyword();

    windowsToRender.value.forEach((win) => {
      const actualIndex = windows.value.findIndex(
        (item) => String(item.id) === String(win.id)
      );
      const labelIndex = actualIndex >= 0 ? actualIndex + 1 : 1;
      const render = treeMode ? buildTreeRender(win) : null;
      const tabs = treeMode ? render.tabs : getDisplayTabs(win.tabs);

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

      if (!treeMode) {
        tabs.forEach((tab) => {
          rows.push(makeTabRow(tab, globalIndex, {}));
          globalIndex += 1;
        });
        return;
      }

      // 交给与后台/基准共用的 flattenTree：它负责 DFS 顺序、折叠隐藏，
      // 以及"父标签不在渲染集合内时把子标签就近提升"。
      const flatRows = flattenTree(
        tabs.map((tab) => Number(tab.id)),
        render.parentMap,
        {
          collapsedIds: tree.collapsedSetFor ? tree.collapsedSetFor(win.id) : null,
          forceExpand,
        }
      );
      const tabById = new Map(tabs.map((tab) => [Number(tab.id), tab]));
      for (const flatRow of flatRows) {
        const tab = tabById.get(flatRow.id);
        if (!tab) {
          continue;
        }
        rows.push(makeTabRow(tab, globalIndex, flatRow));
        globalIndex += 1;
      }
    });
    return rows;
  });

  function setSelectedWindow(windowId) {
    selectedWindowId.value = windowId;
    Object.keys(selectedTabIds).forEach((key) => delete selectedTabIds[key]);
  }

  /**
   * 当前窗口里"全选应当作用到"的标签。
   * 过滤模式下只包含真正匹配的标签（祖先只是路径，不参与批量操作），跳转模式包含全部。
   */
  function getSelectableTabs(win) {
    if (!isTreeMode()) {
      return getDisplayTabs(win.tabs);
    }
    const { tabs } = buildTreeRender(win);
    if (shouldFilterRows()) {
      const keyword = getKeyword();
      return tabs.filter((tab) => matchesTabQuery(tab, keyword));
    }
    return tabs;
  }

  function setVisibleSelection(checked) {
    windowsToRender.value.forEach((win) => {
      getSelectableTabs(win).forEach((tab) => {
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
    return existing;
  }

  return {
    windows,
    selectedWindowId,
    selectedTabIds,
    totalTabCount,
    windowSubItems,
    windowSubtitle,
    windowRows,
    isTreeMode,
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
