import { computed, reactive, ref } from "vue";
import { matchesTabQuery } from "../utils/helpers.js";

const NEW_LIST_VALUE = "__new__";
const MOVE_NEW_LIST_VALUE = "__move_new__";

function useLists({ request, statusTarget, filterQuery, filterMode }) {
  const lists = ref([]);
  const selectedListId = ref("");
  const selectedListItemKeys = reactive({});
  const listStatus = reactive({ message: "", type: "" });

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

  const selectedListTarget = ref(NEW_LIST_VALUE);
  const newListName = ref("");
  const newListDescription = ref("");
  const listNameDraft = ref("");
  const listDescriptionDraft = ref("");
  const isEditingListName = ref(false);
  const moveTargetListId = ref(MOVE_NEW_LIST_VALUE);
  const moveNewListName = ref("");
  const importReplace = ref(false);
  const createListName = ref("");
  const createListDescription = ref("");

  const selectedList = computed(() =>
    lists.value.find((item) => item.id === selectedListId.value) || null
  );

  const listTitle = computed(() => {
    if (lists.value.length === 0) {
      return "保存的列表";
    }
    return selectedList.value ? selectedList.value.name : "请选择列表";
  });

  const listSubtitle = computed(() => {
    if (lists.value.length === 0) {
      return "暂无列表";
    }
    const list = selectedList.value;
    if (!list) {
      return "请选择列表";
    }
    const count = list.items ? list.items.length : 0;
    const selectedCount = Object.keys(selectedListItemKeys).length;
    const suffix = selectedCount > 0 ? `，已选 ${selectedCount}` : "";
    return `共 ${count} 个标签页${suffix}`;
  });

  const listItems = computed(() => {
    if (lists.value.length === 0) {
      return [];
    }
    const list = lists.value.find((item) => item.id === selectedListId.value);
    if (!list || !Array.isArray(list.items)) {
      return [];
    }
    const keyword = getKeyword();
    // 先保留原始 index，过滤后再按需展示，保证删除/移动仍指向原始条目。
    const items = list.items.map((item, index) => ({
      ...item,
      key: `list-${list.id}-${index}`,
      index,
      matched: hasKeyword() && matchesTabQuery(item, keyword),
    }));
    return shouldFilterRows()
      ? items.filter((item) => matchesTabQuery(item, keyword))
      : items;
  });

  const listSubItems = computed(() =>
    lists.value.map((list) => ({
      id: list.id,
      label: list.name,
      count: list.items ? list.items.length : 0,
      description: list.description || "",
    }))
  );

  const moveTargetLists = computed(() =>
    lists.value.filter((list) => list.id !== selectedListId.value)
  );

  function setListStatus(message, type) {
    listStatus.message = message;
    listStatus.type = type || "";
  }

  function setGlobalStatus(message, type) {
    if (!statusTarget) {
      return;
    }
    statusTarget.message = message;
    statusTarget.type = type || "";
  }

  function updateListNameDraft(value) {
    listNameDraft.value = value;
  }

  function updateListDescriptionDraft(value) {
    listDescriptionDraft.value = value;
  }

  function updateImportReplace(value) {
    importReplace.value = value;
  }

  function syncListDescription() {
    listDescriptionDraft.value = selectedList.value
      ? selectedList.value.description || ""
      : "";
  }

  function syncListName() {
    listNameDraft.value = selectedList.value ? selectedList.value.name || "" : "";
  }

  function syncMoveTarget() {
    if (!selectedList.value) {
      moveTargetListId.value = MOVE_NEW_LIST_VALUE;
      return;
    }
    const available = moveTargetLists.value;
    const current = moveTargetListId.value;
    if (current === MOVE_NEW_LIST_VALUE) {
      return;
    }
    if (!available.some((list) => list.id === current)) {
      moveTargetListId.value =
        available.length > 0 ? available[0].id : MOVE_NEW_LIST_VALUE;
    }
  }

  function clearListDescription() {
    listDescriptionDraft.value = "";
  }

  function setSelectedList(listId) {
    selectedListId.value = listId;
    clearListSelection();
    isEditingListName.value = false;
    syncListName();
    syncListDescription();
    syncMoveTarget();
  }

  function startEditListName() {
    if (!selectedList.value) {
      return;
    }
    isEditingListName.value = true;
    syncListName();
  }

  function cancelEditListName() {
    isEditingListName.value = false;
    syncListName();
  }

  function selectAllListItems() {
    listItems.value.forEach((item) => {
      selectedListItemKeys[item.key] = true;
    });
  }

  function clearListSelection() {
    Object.keys(selectedListItemKeys).forEach((key) => delete selectedListItemKeys[key]);
  }

  function toggleListItem(key, checked) {
    if (checked) {
      selectedListItemKeys[key] = true;
    } else {
      delete selectedListItemKeys[key];
    }
  }

  function toggleListItemSelection(key) {
    if (selectedListItemKeys[key]) {
      delete selectedListItemKeys[key];
    } else {
      selectedListItemKeys[key] = true;
    }
  }

  function getSelectedListIndices() {
    const indices = [];
    listItems.value.forEach((item) => {
      if (selectedListItemKeys[item.key]) {
        indices.push(item.index);
      }
    });
    return indices;
  }

  async function saveListName() {
    if (!selectedList.value) {
      return;
    }
    const nextName = listNameDraft.value.trim();
    if (!nextName) {
      setListStatus("列表名称不能为空。", "error");
      return;
    }
    const response = await request("renameList", {
      listId: selectedList.value.id,
      name: nextName,
    });
    if (!response.ok) {
      setListStatus(response.error || "重命名失败。", "error");
      return;
    }
    isEditingListName.value = false;
    setListStatus("列表已重命名。", "ok");
    await loadLists();
  }

  async function moveSelectedListItems() {
    if (!selectedList.value) {
      setListStatus("请先选择一个列表。", "error");
      return;
    }
    const indices = getSelectedListIndices();
    if (indices.length === 0) {
      setListStatus("请先选择要移动的标签。", "error");
      return;
    }
    const isNewTarget = moveTargetListId.value === MOVE_NEW_LIST_VALUE;
    const targetListId = isNewTarget ? "" : moveTargetListId.value;
    const newListName = isNewTarget ? moveNewListName.value.trim() : "";
    if (isNewTarget && !newListName) {
      setListStatus("请输入新建列表名称。", "error");
      return;
    }
    setListStatus("正在移动标签...", "");
    const response = await request("moveListItems", {
      listId: selectedList.value.id,
      indices,
      targetListId,
      newListName,
    });
    if (!response.ok) {
      setListStatus(response.error || "移动失败。", "error");
      return;
    }
    const moved = response.result ? response.result.moved : 0;
    setListStatus(`已移动 ${moved} 个标签。`, "ok");
    moveNewListName.value = "";
    clearListSelection();
    await loadLists();
  }

  async function createList() {
    const name = createListName.value.trim();
    if (!name) {
      setListStatus("请输入列表名称。", "error");
      return null;
    }
    const response = await request("createList", {
      name,
      description: createListDescription.value.trim(),
    });
    if (!response.ok) {
      setListStatus(response.error || "创建列表失败。", "error");
      return null;
    }
    const created = response.result ? response.result.list : null;
    setListStatus("列表已创建。", "ok");
    createListName.value = "";
    createListDescription.value = "";
    if (created && created.id) {
      selectedListId.value = created.id;
    }
    await loadLists();
    return created;
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
      const mode = importReplace.value ? "replace" : "merge";
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
      event.target.value = "";
    }
  }

  async function deleteList() {
    if (!selectedListId.value) {
      setListStatus("请先选择一个列表。", "error");
      return;
    }
    const confirmed = window.confirm("确定要删除该列表吗？此操作不可撤销。");
    if (!confirmed) {
      return;
    }
    const response = await request("deleteList", { listId: selectedListId.value });
    if (!response.ok) {
      setListStatus(response.error || "删除列表失败。", "error");
      return;
    }
    setListStatus("列表已删除。", "ok");
    clearListSelection();
    await loadLists();
  }

  async function deleteListItem(item) {
    if (!item || item.index === undefined) {
      return;
    }
    const response = await request("deleteListItems", {
      listId: selectedListId.value,
      indices: [item.index],
    });
    if (!response.ok) {
      setListStatus(response.error || "删除失败。", "error");
      return;
    }
    setListStatus("已删除标签。", "ok");
    await loadLists();
  }

  async function deleteSelectedListItems() {
    if (!selectedListId.value) {
      setListStatus("请先选择一个列表。", "error");
      return;
    }
    const indices = listItems.value
      .filter((item) => selectedListItemKeys[item.key])
      .map((item) => item.index);
    if (indices.length === 0) {
      setListStatus("请先选择要删除的标签。", "error");
      return;
    }
    const confirmed = window.confirm(`确定删除选中的 ${indices.length} 个标签吗？`);
    if (!confirmed) {
      return;
    }
    const response = await request("deleteListItems", {
      listId: selectedListId.value,
      indices,
    });
    if (!response.ok) {
      setListStatus(response.error || "删除失败。", "error");
      return;
    }
    setListStatus(`已删除 ${indices.length} 个标签。`, "ok");
    clearListSelection();
    await loadLists();
  }

  async function saveListDescription() {
    if (!selectedList.value) {
      setListStatus("请先选择列表。", "error");
      return;
    }
    const response = await request("updateListDescription", {
      listId: selectedList.value.id,
      description: listDescriptionDraft.value,
    });
    if (!response.ok) {
      setListStatus(response.error || "保存描述失败。", "error");
      return;
    }
    setListStatus("列表描述已更新。", "ok");
    await loadLists();
  }

  async function loadLists() {
    const response = await request("getLists");
    if (!response.ok) {
      setListStatus(response.error || "列表加载失败。", "error");
      setGlobalStatus(response.error || "列表加载失败。", "error");
      return;
    }
    lists.value = response.lists || [];
    if (lists.value.length === 0) {
      selectedListId.value = "";
    } else if (!selectedListId.value) {
      selectedListId.value = lists.value[0].id;
    } else if (!lists.value.some((list) => list.id === selectedListId.value)) {
      selectedListId.value = lists.value[0].id;
    }
    clearListSelection();
    isEditingListName.value = false;
    syncListName();
    syncListDescription();
    syncMoveTarget();

    if (selectedListTarget.value !== NEW_LIST_VALUE) {
      const exists = lists.value.some((list) => list.id === selectedListTarget.value);
      if (!exists) {
        selectedListTarget.value = NEW_LIST_VALUE;
      }
    }
  }

  return {
    lists,
    selectedListId,
    selectedListItemKeys,
    listStatus,
    selectedListTarget,
    newListName,
    newListDescription,
    listNameDraft,
    listDescriptionDraft,
    isEditingListName,
    moveTargetListId,
    moveNewListName,
    importReplace,
    createListName,
    createListDescription,
    selectedList,
    listTitle,
    listSubtitle,
    listItems,
    listSubItems,
    moveTargetLists,
    setListStatus,
    updateListNameDraft,
    updateListDescriptionDraft,
    updateImportReplace,
    syncMoveTarget,
    clearListDescription,
    setSelectedList,
    startEditListName,
    cancelEditListName,
    selectAllListItems,
    clearListSelection,
    toggleListItem,
    toggleListItemSelection,
    getSelectedListIndices,
    saveListName,
    saveListDescription,
    moveSelectedListItems,
    createList,
    exportLists,
    importLists,
    deleteList,
    deleteListItem,
    deleteSelectedListItems,
    loadLists,
  };
}

export { MOVE_NEW_LIST_VALUE, NEW_LIST_VALUE, useLists };
