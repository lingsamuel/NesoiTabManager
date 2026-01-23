const NEW_LIST_VALUE = "__new__";

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

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status${type ? ` ${type}` : ""}`;
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

async function loadTabs() {
  const windows = await getAllWindows();
  tabsContainer.innerHTML = "";

  if (windows.length === 0) {
    clearTabsUI("未找到打开的标签页。");
    return;
  }

  windows.forEach((win, index) => {
    const block = document.createElement("div");
    block.className = "window-block";

    const title = document.createElement("div");
    title.className = "window-title";
    title.textContent = `窗口 ${index + 1}（${win.tabs ? win.tabs.length : 0}）`;
    block.appendChild(title);

    const tabs = Array.isArray(win.tabs) ? win.tabs : [];
    if (tabs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tab-row";
      empty.textContent = "此窗口没有标签页。";
      block.appendChild(empty);
    } else {
      tabs.forEach((tab) => {
        const row = document.createElement("div");
        row.className = "tab-row";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.tabId = tab.id;

        const text = document.createElement("div");
        const titleText = document.createElement("div");
        titleText.className = "tab-title";
        titleText.textContent = tab.title || tab.url || "未命名";

        const urlText = document.createElement("div");
        urlText.className = "tab-url";
        urlText.textContent = tab.url || "";

        text.appendChild(titleText);
        text.appendChild(urlText);

        row.appendChild(checkbox);
        row.appendChild(text);
        block.appendChild(row);
      });
    }

    tabsContainer.appendChild(block);
  });
}

async function loadLists() {
  const response = await request("getLists");
  if (!response.ok) {
    setStatus(response.error || "列表加载失败。", "error");
    return;
  }
  const lists = response.lists || [];
  listSelect.innerHTML = "";

  if (lists.length === 0) {
    const option = document.createElement("option");
    option.value = NEW_LIST_VALUE;
    option.textContent = "新建列表";
    listSelect.appendChild(option);
  } else {
    lists.forEach((list) => {
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

function getSelectedTabIds() {
  return Array.from(
    tabsContainer.querySelectorAll("input[type=checkbox][data-tab-id]")
  )
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => Number(checkbox.dataset.tabId))
    .filter((id) => Number.isFinite(id));
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
    await loadTabs();
  }
}

async function exportLists() {
  const response = await request("getLists");
  if (!response.ok) {
    setStatus(response.error || "导出失败。", "error");
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
      setStatus(response.error || "导入失败。", "error");
      return;
    }
    setStatus(`已导入 ${response.result.imported} 个列表。`, "ok");
    await loadLists();
  } catch (error) {
    setStatus("JSON 文件无效。", "error");
  } finally {
    importFile.value = "";
  }
}

selectAllButton.addEventListener("click", () => {
  tabsContainer
    .querySelectorAll("input[type=checkbox][data-tab-id]")
    .forEach((checkbox) => {
      checkbox.checked = true;
    });
});

clearAllButton.addEventListener("click", () => {
  tabsContainer
    .querySelectorAll("input[type=checkbox][data-tab-id]")
    .forEach((checkbox) => {
      checkbox.checked = false;
    });
});

listSelect.addEventListener("change", updateNewListVisibility);

saveTabsButton.addEventListener("click", saveSelectedTabs);

exportButton.addEventListener("click", exportLists);

importFile.addEventListener("change", importLists);

(async () => {
  await loadTabs();
  await loadLists();
})();
