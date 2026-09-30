import { computed, reactive, ref } from "vue";
// 树的扁平化（DFS 顺序、折叠隐藏、被隐藏父标签的就近提升、筛选补祖先）与后台、基准测试、
// Firefox 侧边栏共用同一份实现，避免"基准测的是一套、线上跑的是另一套"。
import { buildTreeRows } from "../../../background/tree_core.js";
import { getSelectedTabsFrom, matchesTabQuery } from "../utils/helpers.js";
import { resolveActiveRows } from "../utils/scroll_markers.js";

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
   * 树状模式下的渲染输入：可见标签（按 index 升序）与父映射。
   *
   * 筛选、祖先补齐、DFS 顺序、父标签不可见时的就近提升都交给 buildTreeRows/flattenTree 统一处理，
   * 这里只负责把"窗口数据 + 父子映射"整理成它们需要的形状。
   * parentMap 覆盖全部可见标签（包含被隐藏的父标签），否则无法把子标签提升到正确的可见祖先下。
   */
  function buildTreeRender(win) {
    const tabs = getVisibleTabs(win.tabs).slice().sort(byIndex);
    const parents = tree.parentsFor(win.id);
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
        matched: Boolean(treeInfo.matched),
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
        windowId: Number(win.id),
        // 只挂引用，不额外计算：activeRows 需要它做"活动标签被隐藏时上溯到可见祖先"
        parents: render ? render.parentMap : null,
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
          rows.push(makeTabRow(tab, globalIndex, { matched: Boolean(tab.matched) }));
          globalIndex += 1;
        });
        return;
      }

      // 交给与后台/基准/侧边栏共用的 buildTreeRows：它负责筛选补祖先、DFS 顺序、折叠隐藏，
      // 以及"父标签不在渲染集合内时把子标签就近提升"。
      const tabById = new Map(tabs.map((tab) => [Number(tab.id), tab]));
      const keyword = getKeyword();
      // 只要有关键词就标记匹配项：跳转模式要靠它高亮并支持上下跳转。
      // 若像以前那样只在过滤模式传 matchId，跳转模式下所有行的 matched 都是 false，
      // 匹配数恒为 0，界面会一直显示"无匹配"。
      const matchId = hasKeyword()
        ? (id) => {
            const tab = tabById.get(Number(id));
            return Boolean(tab && matchesTabQuery(tab, keyword));
          }
        : null;
      const flatRows = buildTreeRows(tabs, render.parentMap, {
        collapsedIds: tree.collapsedSetFor ? tree.collapsedSetFor(win.id) : null,
        forceExpand,
        matchId,
        // 是否把非匹配行裁掉：只有过滤模式才裁，跳转模式保留完整树。
        pruneToMatches: shouldFilterRows(),
      });
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

  /**
   * 滚动条轨道上的蓝色刻度：管理页是多窗口视图，因此**每个窗口各一条**。
   * 复用与侧边栏相同的规则：活动标签被折叠或被筛选隐藏时，标到它最近的可见祖先行。
   */
  const activeRows = computed(() => {
    const rowIndexById = new Map();
    const parentsByWindowId = new Map();
    windowRows.value.forEach((row, index) => {
      if (row.type === "tab") {
        rowIndexById.set(Number(row.tab.id), index);
      } else if (row.type === "window") {
        parentsByWindowId.set(Number(row.windowId), row.parents || null);
      }
    });
    if (rowIndexById.size === 0) {
      return [];
    }
    const entries = [];
    for (const win of windowsToRender.value) {
      const active = (win.tabs || []).find((tab) => tab.active);
      if (!active) {
        continue;
      }
      entries.push({
        tabId: Number(active.id),
        parents: parentsByWindowId.get(Number(win.id)) || null,
      });
    }
    return resolveActiveRows(entries, rowIndexById);
  });

  return {
    windows,
    activeRows,
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
