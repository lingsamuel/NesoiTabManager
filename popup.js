const NEW_LIST_VALUE = "__new__";

// 站点没有 favicon（或图标加载失败）时回退到内置占位图，避免留下一个空白方块。
// popup.js 是普通脚本（非模块），因此这里用 data URI 而不是共享的 Vue 组件。
const FALLBACK_FAVICON = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8a8a" '
  + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>'
  + '<path d="M12 3c2.4 2.7 3.7 5.7 3.7 9s-1.3 6.3-3.7 9c-2.4-2.7-3.7-5.7-3.7-9S9.6 5.7 12 3z"/></svg>'
)}`;

// 统一创建 favicon 元素：无 url 或加载失败都回退到占位图（用标记位防止占位图自身失败时死循环）。
function createFavicon(className, url) {
  const icon = document.createElement("img");
  icon.className = className;
  icon.src = url || FALLBACK_FAVICON;
  icon.addEventListener("error", () => {
    if (icon.dataset.fallback === "1") {
      return;
    }
    icon.dataset.fallback = "1";
    icon.src = FALLBACK_FAVICON;
  });
  return icon;
}

const tabsContainer = document.getElementById("tabs");
const listSelect = document.getElementById("list-select");
const newListRow = document.getElementById("new-list-row");
const newListName = document.getElementById("new-list-name");
const closeAfter = document.getElementById("close-after");
const saveTabsButton = document.getElementById("save-tabs");
const statusEl = document.getElementById("status");
const selectAllButton = document.getElementById("select-all");
const clearAllButton = document.getElementById("clear-all");
const exportButton = document.getElementById("export-lists");
const importFile = document.getElementById("import-file");
const importReplace = document.getElementById("import-replace");
const aiGroupButton = document.getElementById("ai-group");
const aiApplyButton = document.getElementById("ai-apply");
const aiStatusEl = document.getElementById("ai-status");
const listItemsContainer = document.getElementById("list-items");
const windowSubtitle = document.getElementById("window-subtitle");
const listSubtitle = document.getElementById("list-subtitle");
const listStatusEl = document.getElementById("list-status");
const navButtons = document.querySelectorAll(".nav-item");
const subSidebar = document.getElementById("sub-sidebar");
const subTitle = document.getElementById("sub-title");
const subItems = document.getElementById("sub-items");
const viewWindows = document.getElementById("view-windows");
const viewLists = document.getElementById("view-lists");
const viewSettings = document.getElementById("view-settings");

const state = {
  view: "windows",
  windows: [],
  lists: [],
  selectedWindowId: "all",
  selectedListId: "",
  selectedTabIds: new Set(),
  tabInfoById: new Map(),
  tabTagElements: new Map(),
  aiGroups: [],
  visibleTabIds: [],
};

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status${type ? ` ${type}` : ""}`;
}

function setAiStatus(message, type) {
  aiStatusEl.textContent = message;
  aiStatusEl.className = `status${type ? ` ${type}` : ""}`;
}

function setListStatus(message, type) {
  listStatusEl.textContent = message;
  listStatusEl.className = `status${type ? ` ${type}` : ""}`;
}

function request(action, data) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...data }, (response) => {
      resolve(response || { ok: false, error: "无响应" });
    });
  });
}

function getAllWindows() {
  return new Promise((resolve) => {
    chrome.windows.getAll({ populate: true }, (windows) => resolve(windows || []));
  });
}

function clearTabsUI(message) {
  tabsContainer.innerHTML = "";
  const placeholder = document.createElement("div");
  placeholder.className = "tab-row";
  placeholder.textContent = message;
  tabsContainer.appendChild(placeholder);
}

function clearListUI(message) {
  listItemsContainer.innerHTML = "";
  const placeholder = document.createElement("div");
  placeholder.className = "empty-state";
  placeholder.textContent = message;
  listItemsContainer.appendChild(placeholder);
}

function resetTabState() {
  state.tabInfoById = new Map();
  state.tabTagElements = new Map();
  state.aiGroups = [];
  state.visibleTabIds = [];
  setAiStatus("", "");
}

function syncSelectedTabIds() {
  const validIds = new Set();
  state.windows.forEach((win) => {
    (win.tabs || []).forEach((tab) => {
      if (tab && tab.id) {
        validIds.add(tab.id);
      }
    });
  });
  state.selectedTabIds = new Set(
    Array.from(state.selectedTabIds).filter((tabId) => validIds.has(tabId))
  );
}

function updateListSelect() {
  listSelect.innerHTML = "";
  if (state.lists.length === 0) {
    const option = document.createElement("option");
    option.value = NEW_LIST_VALUE;
    option.textContent = "新建列表";
    listSelect.appendChild(option);
  } else {
    state.lists.forEach((list) => {
      const option = document.createElement("option");
      option.value = list.id;
      option.textContent = `${list.name} (${list.items ? list.items.length : 0})`;
      listSelect.appendChild(option);
    });
    const createOption = document.createElement("option");
    createOption.value = NEW_LIST_VALUE;
    createOption.textContent = "新建列表";
    listSelect.appendChild(createOption);
  }

  updateNewListVisibility();
}

function updateNewListVisibility() {
  const isNew = listSelect.value === NEW_LIST_VALUE;
  newListRow.classList.toggle("hidden", !isNew);
}

function setView(view) {
  state.view = view;
  navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  viewWindows.classList.toggle("active", view === "windows");
  viewLists.classList.toggle("active", view === "lists");
  viewSettings.classList.toggle("active", view === "settings");
  updateSubSidebar();
  if (view === "windows") {
    renderTabs();
  }
  if (view === "lists") {
    renderListItems();
  }
}

function updateSubSidebar() {
  if (state.view === "windows") {
    subSidebar.classList.remove("hidden");
    subTitle.textContent = "窗口";
    renderWindowSubItems();
    return;
  }
  if (state.view === "lists") {
    subSidebar.classList.remove("hidden");
    subTitle.textContent = "列表";
    renderListSubItems();
    return;
  }
  subSidebar.classList.add("hidden");
  subItems.innerHTML = "";
}

function renderWindowSubItems() {
  subItems.innerHTML = "";
  if (state.windows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无窗口";
    subItems.appendChild(empty);
    return;
  }

  const totalTabs = state.windows.reduce(
    (sum, win) => sum + (win.tabs ? win.tabs.length : 0),
    0
  );

  const allItem = document.createElement("button");
  allItem.className = "sub-item";
  allItem.dataset.windowId = "all";
  allItem.innerHTML = `<span>全部窗口</span><small>${totalTabs}</small>`;
  if (state.selectedWindowId === "all") {
    allItem.classList.add("active");
  }
  allItem.addEventListener("click", () => setSelectedWindow("all"));
  subItems.appendChild(allItem);

  state.windows.forEach((win, index) => {
    const item = document.createElement("button");
    item.className = "sub-item";
    item.dataset.windowId = String(win.id);
    const count = win.tabs ? win.tabs.length : 0;
    item.innerHTML = `<span>窗口 ${index + 1}</span><small>${count}</small>`;
    if (String(state.selectedWindowId) === String(win.id)) {
      item.classList.add("active");
    }
    item.addEventListener("click", () => setSelectedWindow(String(win.id)));
    subItems.appendChild(item);
  });
}

function renderListSubItems() {
  subItems.innerHTML = "";
  if (state.lists.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无列表";
    subItems.appendChild(empty);
    return;
  }

  state.lists.forEach((list) => {
    const item = document.createElement("button");
    item.className = "sub-item";
    item.dataset.listId = list.id;
    const count = list.items ? list.items.length : 0;
    item.innerHTML = `<span>${list.name}</span><small>${count}</small>`;
    if (state.selectedListId === list.id) {
      item.classList.add("active");
    }
    item.addEventListener("click", () => setSelectedList(list.id));
    subItems.appendChild(item);
  });
}

function setSelectedWindow(windowId) {
  state.selectedWindowId = windowId;
  state.selectedTabIds.clear();
  resetTabState();
  renderTabs();
  renderWindowSubItems();
}

function setSelectedList(listId) {
  state.selectedListId = listId;
  renderListItems();
  renderListSubItems();
}

function getWindowsToRender() {
  if (state.selectedWindowId === "all") {
    return state.windows;
  }
  return state.windows.filter(
    (win) => String(win.id) === String(state.selectedWindowId)
  );
}

function updateWindowSubtitle(windowsToRender) {
  const tabCount = windowsToRender.reduce(
    (sum, win) => sum + (win.tabs ? win.tabs.length : 0),
    0
  );
  if (state.selectedWindowId === "all") {
    windowSubtitle.textContent = `当前：全部窗口（共 ${tabCount} 个标签页）`;
    return;
  }
  const index = state.windows.findIndex(
    (win) => String(win.id) === String(state.selectedWindowId)
  );
  const label = index >= 0 ? `窗口 ${index + 1}` : "当前窗口";
  windowSubtitle.textContent = `当前：${label}（共 ${tabCount} 个标签页）`;
}

function renderTabs() {
  if (state.view !== "windows") {
    return;
  }
  const windowsToRender = getWindowsToRender();
  tabsContainer.innerHTML = "";
  resetTabState();

  if (windowsToRender.length === 0) {
    clearTabsUI("未找到打开的标签页。");
    windowSubtitle.textContent = "暂无窗口";
    return;
  }

  updateWindowSubtitle(windowsToRender);

  let globalIndex = 0;
  windowsToRender.forEach((win) => {
    const actualIndex = state.windows.findIndex(
      (item) => String(item.id) === String(win.id)
    );
    const block = document.createElement("div");
    block.className = "window-block";

    const title = document.createElement("div");
    title.className = "window-title";
    const labelIndex = actualIndex >= 0 ? actualIndex + 1 : 1;
    title.textContent = `窗口 ${labelIndex}（${win.tabs ? win.tabs.length : 0}）`;
    block.appendChild(title);

    const tabs = Array.isArray(win.tabs) ? win.tabs : [];
    if (tabs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tab-row";
      empty.textContent = "此窗口没有标签页。";
      block.appendChild(empty);
    } else {
      tabs.forEach((tab) => {
        const tabId = tab.id;
        const tabOrderIndex = globalIndex;
        globalIndex += 1;

        const row = document.createElement("div");
        row.className = "tab-row";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.tabId = tabId;
        checkbox.checked = state.selectedTabIds.has(tabId);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            state.selectedTabIds.add(tabId);
          } else {
            state.selectedTabIds.delete(tabId);
          }
        });

        const icon = createFavicon("tab-icon", tab.favIconUrl);

        const text = document.createElement("div");
        const titleText = document.createElement("div");
        titleText.className = "tab-title";
        titleText.textContent = tab.title || tab.url || "未命名";

        const urlText = document.createElement("div");
        urlText.className = "tab-url";
        urlText.textContent = tab.url || "";

        text.appendChild(titleText);
        text.appendChild(urlText);

        const tag = document.createElement("span");
        tag.className = "tab-tag hidden";
        tag.dataset.tabId = tabId;

        row.appendChild(checkbox);
        row.appendChild(icon);
        row.appendChild(text);
        row.appendChild(tag);
        block.appendChild(row);

        if (tabId) {
          state.tabInfoById.set(tabId, {
            id: tabId,
            title: titleText.textContent,
            url: tab.url || "",
            index: tabOrderIndex,
          });
          state.tabTagElements.set(tabId, tag);
          state.visibleTabIds.push(tabId);
        }
      });
    }

    tabsContainer.appendChild(block);
  });
}

function renderListItems() {
  if (state.view !== "lists") {
    return;
  }
  if (state.lists.length === 0) {
    listSubtitle.textContent = "暂无列表";
    clearListUI("暂无已保存的列表。");
    return;
  }

  if (!state.selectedListId) {
    state.selectedListId = state.lists[0].id;
  }

  const list = state.lists.find((item) => item.id === state.selectedListId);
  if (!list) {
    listSubtitle.textContent = "请选择列表";
    clearListUI("请选择一个列表查看。");
    return;
  }

  const items = list.items || [];
  listSubtitle.textContent = `${list.name}（${items.length}）`;
  listItemsContainer.innerHTML = "";

  if (items.length === 0) {
    clearListUI("该列表暂无内容。");
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "list-item";

    const header = document.createElement("div");
    header.className = "list-header";

    const icon = createFavicon("list-icon", item.favIconUrl);

    const title = document.createElement("div");
    title.className = "list-title";
    title.textContent = item.title || item.url || "未命名";

    header.appendChild(icon);
    header.appendChild(title);

    const url = document.createElement("div");
    url.className = "list-url";
    url.textContent = item.url || "";

    const meta = document.createElement("div");
    meta.className = "list-meta";
    meta.textContent = item.savedAt ? `保存时间：${item.savedAt}` : "";

    card.appendChild(header);
    card.appendChild(url);
    if (meta.textContent) {
      card.appendChild(meta);
    }
    listItemsContainer.appendChild(card);
  });
}

function getSelectedTabIds() {
  return Array.from(state.selectedTabIds);
}

function getSelectedTabs() {
  return getSelectedTabIds()
    .map((tabId) => state.tabInfoById.get(tabId))
    .filter(Boolean);
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

function buildAiItems(tabs) {
  return tabs.map((tab) => ({
    tabId: tab.id,
    title: tab.title || "",
    domain: getBaseDomain(tab.url),
    index: tab.index,
  }));
}

function applyTags(groups) {
  state.tabTagElements.forEach((tagEl) => {
    tagEl.textContent = "";
    tagEl.classList.add("hidden");
  });

  groups.forEach((group) => {
    const label = group.label || "未分组";
    (group.tabIds || []).forEach((tabId) => {
      const tagEl = state.tabTagElements.get(tabId);
      if (!tagEl) {
        return;
      }
      tagEl.textContent = label;
      tagEl.classList.remove("hidden");
    });
  });
}

async function runAiGrouping() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) {
    setAiStatus("请先选择需要分组的标签页。", "error");
    return;
  }
  const items = buildAiItems(selectedTabs);
  setAiStatus("AI 分组中...", "");
  const response = await request("aiGroupTabs", { items });
  if (!response.ok) {
    setAiStatus(response.error || "AI 分组失败。", "error");
    return;
  }
  state.aiGroups = response.result ? response.result.groups || [] : [];
  if (state.aiGroups.length === 0) {
    setAiStatus("未生成有效分组。", "error");
    return;
  }
  applyTags(state.aiGroups);
  setAiStatus(`已生成 ${state.aiGroups.length} 组标签。`, "ok");
}

async function applyAiGrouping() {
  if (state.aiGroups.length === 0) {
    setAiStatus("请先执行 AI 分组。", "error");
    return;
  }
  setAiStatus("正在生成新列表...", "");
  const response = await request("saveGroupedTabs", { groups: state.aiGroups });
  if (!response.ok) {
    setAiStatus(response.error || "生成新列表失败。", "error");
    return;
  }
  const created = response.result ? response.result.created : 0;
  setAiStatus(`已生成 ${created} 个新列表。`, "ok");
  await loadLists();
}

async function saveSelectedTabs() {
  const selectedTabIds = getSelectedTabIds();
  if (selectedTabIds.length === 0) {
    setStatus("请至少选择一个标签页。", "error");
    return;
  }

  const targetValue = listSelect.value;
  const isNewList = targetValue === NEW_LIST_VALUE;
  const listId = isNewList ? "" : targetValue;
  const listName = isNewList ? newListName.value.trim() : "";

  if (isNewList && !listName) {
    setStatus("请输入新列表名称。", "error");
    return;
  }

  setStatus("保存中...", "");
  const response = await request("saveTabs", {
    tabIds: selectedTabIds,
    listId,
    newListName: listName,
    closeTabs: closeAfter.checked,
  });

  if (!response.ok) {
    setStatus(response.error || "保存失败。", "error");
    return;
  }

  const savedCount = response.result ? response.result.savedCount : 0;
  setStatus(`已保存 ${savedCount} 个标签页。`, "ok");
  newListName.value = "";
  await loadLists();

  if (closeAfter.checked) {
    await loadWindows();
  }
}

async function exportLists() {
  const response = await request("getLists");
  if (!response.ok) {
    setListStatus(response.error || "导出失败。", "error");
    return;
  }
  const payload = JSON.stringify({ lists: response.lists || [] }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nesoi-标签列表-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setListStatus("已导出列表文件。", "ok");
}

async function importLists(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) {
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const lists = Array.isArray(data) ? data : data.lists;
    const mode = importReplace.checked ? "replace" : "merge";
    const response = await request("importLists", { lists, mode });
    if (!response.ok) {
      setListStatus(response.error || "导入失败。", "error");
      return;
    }
    setListStatus(`已导入 ${response.result.imported} 个列表。`, "ok");
    await loadLists();
  } catch (error) {
    setListStatus("JSON 文件无效。", "error");
  } finally {
    importFile.value = "";
  }
}

function setVisibleSelection(checked) {
  state.visibleTabIds.forEach((tabId) => {
    if (checked) {
      state.selectedTabIds.add(tabId);
    } else {
      state.selectedTabIds.delete(tabId);
    }
  });
  tabsContainer
    .querySelectorAll("input[type=checkbox][data-tab-id]")
    .forEach((checkbox) => {
      const tabId = Number(checkbox.dataset.tabId);
      checkbox.checked = state.selectedTabIds.has(tabId);
    });
}

async function loadWindows() {
  state.windows = await getAllWindows();
  syncSelectedTabIds();
  if (
    state.selectedWindowId !== "all" &&
    !state.windows.some((win) => String(win.id) === String(state.selectedWindowId))
  ) {
    state.selectedWindowId = "all";
  }
  updateSubSidebar();
  if (state.view === "windows") {
    renderTabs();
  }
}

async function loadLists() {
  const response = await request("getLists");
  if (!response.ok) {
    setStatus(response.error || "列表加载失败。", "error");
    setListStatus(response.error || "列表加载失败。", "error");
    return;
  }
  state.lists = response.lists || [];
  if (state.lists.length === 0) {
    state.selectedListId = "";
  } else if (!state.selectedListId) {
    state.selectedListId = state.lists[0].id;
  } else if (!state.lists.some((list) => list.id === state.selectedListId)) {
    state.selectedListId = state.lists[0].id;
  }
  updateListSelect();
  updateSubSidebar();
  if (state.view === "lists") {
    renderListItems();
  }
}

selectAllButton.addEventListener("click", () => setVisibleSelection(true));

clearAllButton.addEventListener("click", () => setVisibleSelection(false));

listSelect.addEventListener("change", updateNewListVisibility);

saveTabsButton.addEventListener("click", saveSelectedTabs);

aiGroupButton.addEventListener("click", runAiGrouping);

aiApplyButton.addEventListener("click", applyAiGrouping);

exportButton.addEventListener("click", exportLists);

importFile.addEventListener("change", importLists);

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (view) {
      setView(view);
    }
  });
});

(async () => {
  await loadWindows();
  await loadLists();
  setView("windows");
})();
