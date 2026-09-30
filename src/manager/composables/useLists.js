import { computed, reactive, ref } from "vue";
import { matchesTabQuery } from "../utils/helpers.js";
import {
  MOVE_NEW_LIST_VALUE as MOVE_NEW_VALUE,
  NEW_LIST_VALUE as NEW_VALUE,
  rememberListId,
  resolveRememberedListId,
} from "../utils/list_target_memory.js";

const NEW_LIST_VALUE = NEW_VALUE;
const MOVE_NEW_LIST_VALUE = MOVE_NEW_VALUE;

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

  /*
    用户是否在本会话里主动选过分组。
    为什么要这个标记：恢复记忆是异步读 storage 的，返回时用户可能已经自己选好了目标；
    若无条件写回记忆值，用户的手动选择会被悄悄改掉。只有"还没选过"时才自动恢复。
  */
  let saveTargetTouched = false;
  let moveTargetTouched = false;

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

  /**
   * 「保存所选」弹窗的目标列表变化。
   * 由 App.vue 用 @change 绑定（而不是 v-model），这样才能区分"用户主动选的"与"自动恢复的记忆值"：
   * 前者要落在内存标记上，后者要写盘——只有用户的选择才值得记住。
   */
  function setSaveListTarget(listId) {
    selectedListTarget.value = listId;
    saveTargetTouched = true;
    if (listId !== NEW_LIST_VALUE) {
      rememberListId("save", listId);
    }
  }

  /** 「移动到」弹窗的目标列表变化，语义同上。 */
  function setMoveTargetListId(listId) {
    moveTargetListId.value = listId;
    moveTargetTouched = true;
    if (listId !== MOVE_NEW_LIST_VALUE) {
      rememberListId("move", listId);
    }
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
    /*
      记住这次真正落到的目标列表：选了「新建列表」时后台会回传新建出来的 targetListId，
      用它写入记忆，下次打开弹窗就默认是那个列表（而不是又回到新建表单）。
      必须在 loadLists 之前记住——loadLists 会触发一次自动恢复，那时若内存里还没有值，
      恢复逻辑会把弹窗选择改回"新建列表"。
    */
    const movedTargetId =
      response.result && response.result.targetListId ? response.result.targetListId : targetListId;
    if (movedTargetId) {
      moveTargetTouched = true;
      await rememberListId("move", movedTargetId);
    }
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
      // 新建后立刻切到这个列表是原有行为；若当前停在列表视图，顺手把「保存所选」的目标也切过去，
      // 避免"左边显示的是新列表、保存弹窗还指着旧列表"这种不一致。
      selectedListId.value = created.id;
      if (selectedListTarget.value !== NEW_LIST_VALUE) {
        selectedListTarget.value = created.id;
        saveTargetTouched = true;
      }
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

    /*
      恢复"上次选择的分组"（两个弹窗各记各的）。
      必须在同步的存活校验**之前**读记忆：异步读盘返回时用户可能已经改过选择，
      这里只在"用户还没做过选择"时才写回，避免把用户的当前选择覆盖掉。
      被记住的列表已被删除时 resolveRememberedListId 返回 null，于是回退到"新建列表"。
    */
    await restoreRememberedTargets();
  }

  /**
   * 读取两个弹窗各自记忆的分组并校验存活。
   * 同步先做一次"当前值是否还在列表里"的兜底（列表被删时立刻回退），
   * 异步读盘回来后只在用户尚未选择过时应用记忆值。
   */
  async function restoreRememberedTargets() {
    if (
      selectedListTarget.value !== NEW_LIST_VALUE &&
      !lists.value.some((list) => list.id === selectedListTarget.value)
    ) {
      selectedListTarget.value = NEW_LIST_VALUE;
    }

    const [saveMemory, moveMemory] = await Promise.all([
      resolveRememberedListId("save", lists.value),
      resolveRememberedListId("move", lists.value, selectedListId.value),
    ]);

    // 用户已经自己选过（不是"新建列表"）就不再动，尊重当下操作。
    if (saveMemory && selectedListTarget.value === NEW_LIST_VALUE && !saveTargetTouched) {
      selectedListTarget.value = saveMemory;
    }
    if (moveMemory && moveTargetListId.value === MOVE_NEW_LIST_VALUE && !moveTargetTouched) {
      moveTargetListId.value = moveMemory;
    }
  }

  /**
   * 打开「保存所选」弹窗时调用：清掉"用户已选过"标记。
   * 为什么每次开弹窗都要清：用户可能先选了 A 又放弃（或保存失败），下次打开仍应回到记忆值，
   * 而记忆值恰恰就是上一次真正保存成功的目标，这才符合"记住上次选择的分组"。
   */
  function resetSaveTargetTouched() {
    saveTargetTouched = false;
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
    setSaveListTarget,
    setMoveTargetListId,
    resetSaveTargetTouched,
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
