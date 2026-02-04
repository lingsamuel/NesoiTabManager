<template>
  <div class="app" :class="{ 'no-sub': !hasSubSidebar }">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-title">Nesoi 标签管理器</div>
        <div class="brand-subtitle">管理海量标签页</div>
      </div>
      <nav class="nav">
        <button
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ active: view === item.key }"
          @click="setView(item.key)"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path :d="item.icon" />
            </svg>
          </span>
          {{ item.label }}
        </button>
      </nav>
    </aside>

    <aside class="sub-sidebar" :class="{ hidden: view === 'settings' || view === 'discard' }">
      <div class="sub-title">{{ view === "windows" ? "窗口" : "列表" }}</div>
      <div class="sub-items">
        <template v-if="view === 'windows'">
          <button
            class="sub-item"
            :class="{ active: selectedWindowId === 'all' }"
            @click="setSelectedWindow('all')"
          >
            <span>全部窗口</span>
            <small>{{ totalTabCount }}</small>
          </button>
          <button
            v-for="item in windowSubItems"
            :key="item.id"
            class="sub-item"
            :class="{ active: String(selectedWindowId) === String(item.id) }"
            @click="setSelectedWindow(String(item.id))"
          >
            <span>{{ item.label }}</span>
            <small>{{ item.count }}</small>
          </button>
          <div v-if="windowSubItems.length === 0" class="empty-state">暂无窗口</div>
        </template>
        <template v-else>
          <button
            v-for="item in listSubItems"
            :key="item.id"
            class="sub-item"
            :class="{ active: selectedListId === item.id }"
            :title="item.description || ''"
            @click="setSelectedList(item.id)"
          >
            <span>{{ item.label }}</span>
            <small>{{ item.count }}</small>
          </button>
          <div v-if="listSubItems.length === 0" class="empty-state">暂无列表</div>
          <button class="sub-item add" @click="openCreateListModal">
            <span class="sub-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span>新增列表</span>
          </button>
        </template>
      </div>
    </aside>

    <main class="content">
      <WindowsView
        v-show="view === 'windows'"
        :window-subtitle="windowSubtitle"
        :window-rows="windowRows"
        :selected-tab-ids="selectedTabIds"
        :ai-tags="aiTags"
        :on-select-all="() => setVisibleSelection(true)"
        :on-clear="() => setVisibleSelection(false)"
        :on-close-selected="closeSelectedTabs"
        :on-open-ai="openAiModal"
        :on-open-save="openSaveModal"
        :on-toggle-selection="toggleTabSelection"
        :on-toggle-tab="toggleTab"
        :on-activate="activateTab"
        :on-close="closeTab"
        :on-discard="discardTab"
        :on-save-ai-group="saveTabToAiGroup"
      />

      <ListsView
        v-show="view === 'lists'"
        :is-editing-list-name="isEditingListName"
        :list-name-draft="listNameDraft"
        :list-title="listTitle"
        :list-subtitle="listSubtitle"
        :selected-list="selectedList"
        :list-items="listItems"
        :selected-list-item-keys="selectedListItemKeys"
        :list-description-draft="listDescriptionDraft"
        :list-status="listStatus"
        :import-replace="importReplace"
        :on-update-list-name-draft="updateListNameDraft"
        :on-update-list-description-draft="updateListDescriptionDraft"
        :on-update-import-replace="updateImportReplace"
        :on-start-edit-list-name="startEditListName"
        :on-cancel-edit-list-name="cancelEditListName"
        :on-save-list-name="saveListName"
        :on-select-all-list-items="selectAllListItems"
        :on-clear-list-selection="clearListSelection"
        :on-delete-selected-list-items="deleteSelectedListItems"
        :on-open-move-modal="openMoveModal"
        :on-delete-list="deleteList"
        :on-export-lists="exportLists"
        :on-import-lists="importLists"
        :on-open-saved-in-new-window="openSavedInNewWindow"
        :on-toggle-list-item-selection="toggleListItemSelection"
        :on-toggle-list-item="toggleListItem"
        :on-delete-list-item="deleteListItem"
        :on-clear-list-description="clearListDescription"
        :on-save-list-description="saveListDescription"
      />

      <div v-if="showMoveModal" class="modal-backdrop" @click.self="closeMoveModal">
        <div class="modal">
          <div class="modal-header">
            <h3>移动所选标签</h3>
            <button class="ghost btn-icon" @click="closeMoveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label for="move-list-select">目标列表</label>
              <select id="move-list-select" v-model="moveTargetListId">
                <option
                  v-for="list in moveTargetLists"
                  :key="list.id"
                  :value="list.id"
                >
                  {{ list.name }}（{{ list.items ? list.items.length : 0 }}）
                </option>
                <option :value="MOVE_NEW_LIST_VALUE">新建列表</option>
              </select>
            </div>
            <div class="form-row" :class="{ hidden: moveTargetListId !== MOVE_NEW_LIST_VALUE }">
              <label for="move-new-list-name">新建列表名称</label>
              <input
                id="move-new-list-name"
                type="text"
                placeholder="例如：已归档"
                v-model="moveNewListName"
              />
            </div>
            <div class="status" :class="listStatus.type">{{ listStatus.message }}</div>
          </div>
          <div class="modal-actions">
            <button class="ghost btn-icon" @click="closeMoveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              取消
            </button>
            <button class="primary btn-icon" @click="confirmMoveSelected">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
              确认移动
            </button>
          </div>
        </div>
      </div>

      <div v-if="showAiModal" class="modal-backdrop" @click.self="closeAiModal">
        <div class="modal">
          <div class="modal-header">
            <h3>AI 分组</h3>
            <button class="ghost btn-icon" @click="closeAiModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
          </div>
          <div class="modal-body">
            <div class="hint">仅使用标题与基础域名，并结合打开顺序生成标签。</div>
            <div class="form-row ai-actions">
              <button class="ghost btn-icon" @click="runAiGrouping">
                <span class="icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M12 3l2.2 4.4L19 9l-4.8 1.6L12 15l-2.2-4.4L5 9l4.8-1.6z" />
                  </svg>
                </span>
                AI 分组
              </button>
              <button class="primary btn-icon" @click="applyAiGrouping">
                <span class="icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M4 7h10M4 12h16M4 17h12" />
                  </svg>
                </span>
                应用分组生成新列表
              </button>
            </div>
            <div class="status" :class="aiStatus.type">{{ aiStatus.message }}</div>
          </div>
        </div>
      </div>

      <div v-if="showSaveModal" class="modal-backdrop" @click.self="closeSaveModal">
        <div class="modal">
          <div class="modal-header">
            <h3>保存所选标签页</h3>
            <button class="ghost btn-icon" @click="closeSaveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label for="list-select">目标列表</label>
              <select id="list-select" v-model="selectedListTarget">
                <option v-if="lists.length === 0" :value="NEW_LIST_VALUE">新建列表</option>
                <template v-else>
                  <option v-for="list in lists" :key="list.id" :value="list.id">
                    {{ list.name }}（{{ list.items ? list.items.length : 0 }}）
                  </option>
                  <option :value="NEW_LIST_VALUE">新建列表</option>
                </template>
              </select>
            </div>
            <div class="form-row" :class="{ hidden: selectedListTarget !== NEW_LIST_VALUE }">
              <label for="new-list-name">新建列表名称</label>
              <input
                id="new-list-name"
                type="text"
                placeholder="例如：研究资料"
                v-model="newListName"
              />
            </div>
            <div class="form-row" :class="{ hidden: selectedListTarget !== NEW_LIST_VALUE }">
              <label for="new-list-description">新建列表描述（可选）</label>
              <textarea
                id="new-list-description"
                rows="3"
                placeholder="用于指导 AI 分组，例如：工作相关、学习资料"
                v-model="newListDescription"
              ></textarea>
            </div>
            <div class="form-row checkbox-row">
              <label>
                <input type="checkbox" v-model="closeAfter" />
                保存后关闭标签页
              </label>
            </div>
            <div class="status" :class="status.type">{{ status.message }}</div>
          </div>
          <div class="modal-actions">
            <button class="ghost btn-icon" @click="closeSaveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              取消
            </button>
            <button class="primary btn-icon" @click="saveSelectedTabs">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
                </svg>
              </span>
              保存
            </button>
          </div>
        </div>
      </div>

      <div v-if="showCreateListModal" class="modal-backdrop" @click.self="closeCreateListModal">
        <div class="modal">
          <div class="modal-header">
            <h3>新增列表</h3>
            <button class="ghost btn-icon" @click="closeCreateListModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label for="create-list-name">列表名称</label>
              <input
                id="create-list-name"
                type="text"
                placeholder="例如：项目资料"
                v-model="createListName"
              />
            </div>
            <div class="form-row">
              <label for="create-list-description">列表描述（可选）</label>
              <textarea
                id="create-list-description"
                rows="3"
                placeholder="用于指导 AI 分组"
                v-model="createListDescription"
              ></textarea>
            </div>
            <div class="status" :class="listStatus.type">{{ listStatus.message }}</div>
          </div>
          <div class="modal-actions">
            <button class="ghost btn-icon" @click="closeCreateListModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              取消
            </button>
            <button class="primary btn-icon" @click="confirmCreateList">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              创建列表
            </button>
          </div>
        </div>
      </div>

      <HistoryView
        v-show="view === 'discard'"
        :history-subtitle="historySubtitle"
        :history-rows="historyRows"
        :history-selected-tab-ids="historySelectedTabIds"
        :ai-tags="aiTags"
        :status="discardDebugStatus"
        :on-select-all="() => setHistorySelection(true)"
        :on-clear="clearHistorySelection"
        :on-close-selected="closeSelectedHistoryTabs"
        :on-open-ai="openAiModal"
        :on-open-save="openSaveModal"
        :on-refresh="loadDiscardHistory"
        :on-toggle-selection="toggleHistoryTabSelection"
        :on-toggle-tab="toggleHistoryTab"
        :on-activate="activateTab"
        :on-close="closeTab"
        :on-discard="discardTab"
        :on-save-ai-group="saveTabToAiGroup"
      />

      <SettingsView
        v-show="view === 'settings'"
        :ai-config="aiConfig"
        :discard-config="discardConfig"
        :settings-status="settingsStatus"
        :discard-config-status="discardConfigStatus"
        :on-save-ai-config="saveAiConfig"
        :on-save-discard-config="saveDiscardConfig"
      />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import WindowsView from "./views/WindowsView.vue";
import ListsView from "./views/ListsView.vue";
import HistoryView from "./views/HistoryView.vue";
import SettingsView from "./views/SettingsView.vue";

const NEW_LIST_VALUE = "__new__";
const MOVE_NEW_LIST_VALUE = "__move_new__";

const navItems = [
  {
    key: "windows",
    label: "打开的窗口",
    icon: "M4 5h16v4H4zM4 11h10v8H4zM16 11h4v8h-4z",
  },
  {
    key: "lists",
    label: "保存的列表",
    icon: "M4 6h16M4 12h16M4 18h16",
  },
  {
    key: "discard",
    label: "冻结历史",
    icon: "M7 5h4v14H7zM13 5h4v14h-4z",
  },
  {
    key: "settings",
    label: "插件设置",
    icon:
      "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM4 12h2m12 0h2M6.5 6.5l1.5 1.5m8-1.5-1.5 1.5M6.5 17.5l1.5-1.5m8 1.5-1.5-1.5",
  },
];

const view = ref("windows");
const hasSubSidebar = computed(() => view.value === "windows" || view.value === "lists");
const windows = ref([]);
const lists = ref([]);
const selectedWindowId = ref("all");
const selectedListId = ref("");
const selectedTabIds = reactive({});
const selectedListItemKeys = reactive({});
const aiTags = reactive({});
const aiGroups = ref([]);

const status = reactive({ message: "", type: "" });
const aiStatus = reactive({ message: "", type: "" });
const listStatus = reactive({ message: "", type: "" });
const settingsStatus = reactive({ message: "", type: "" });
const discardConfigStatus = reactive({ message: "", type: "" });
const discardDebugStatus = reactive({ message: "", type: "" });

const aiConfig = reactive({
  endpoint: "",
  apiKey: "",
  model: "gpt-4.1-mini",
  apiMode: "responses",
  maxTabs: 120,
  includeListTitles: true,
});

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

const discardHistoryBatches = ref([]);
const discardHistorySummary = reactive({ total: 0, batches: 0, limit: 0 });
const historySelectedTabIds = reactive({});

const selectedListTarget = ref(NEW_LIST_VALUE);
const newListName = ref("");
const newListDescription = ref("");
const closeAfter = ref(false);
const importReplace = ref(false);
const listDescriptionDraft = ref("");
const isEditingListName = ref(false);
const listNameDraft = ref("");
const moveTargetListId = ref(MOVE_NEW_LIST_VALUE);
const moveNewListName = ref("");
const showMoveModal = ref(false);
const showCreateListModal = ref(false);
const createListName = ref("");
const createListDescription = ref("");
const showAiModal = ref(false);
const showSaveModal = ref(false);
const aiContextView = ref("windows");
const saveContextView = ref("windows");

const totalTabCount = computed(() =>
  windows.value.reduce((sum, win) => sum + (win.tabs ? win.tabs.length : 0), 0)
);

const windowSubItems = computed(() =>
  windows.value.map((win, index) => ({
    id: win.id,
    label: `窗口 ${index + 1}`,
    count: win.tabs ? win.tabs.length : 0,
  }))
);

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
    (sum, win) => sum + (win.tabs ? win.tabs.length : 0),
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
    rows.push({
      type: "window",
      key: `window-${win.id}`,
      label: `窗口 ${labelIndex}`,
      count: win.tabs ? win.tabs.length : 0,
    });

    const tabs = Array.isArray(win.tabs) ? win.tabs : [];
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
          index: globalIndex,
        },
      });
      globalIndex += 1;
    });
  });
  return rows;
});

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
  return list.items.map((item, index) => ({
    ...item,
    key: `list-${list.id}-${index}`,
    index,
  }));
});

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

function updateListNameDraft(value) {
  listNameDraft.value = value;
}

function updateListDescriptionDraft(value) {
  listDescriptionDraft.value = value;
}

function updateImportReplace(value) {
  importReplace.value = value;
}

function resetAiTags() {
  clearAiTags();
  aiGroups.value = [];
  setStatus(aiStatus, "", "");
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

function openMoveModal() {
  if (!selectedList.value) {
    setStatus(listStatus, "请先选择一个列表。", "error");
    return;
  }
  setStatus(listStatus, "", "");
  syncMoveTarget();
  showMoveModal.value = true;
}

function closeMoveModal() {
  showMoveModal.value = false;
}

function openAiModal() {
  setStatus(aiStatus, "", "");
  aiContextView.value = view.value;
  showAiModal.value = true;
}

function closeAiModal() {
  showAiModal.value = false;
}

function openSaveModal() {
  setStatus(status, "", "");
  saveContextView.value = view.value;
  showSaveModal.value = true;
}

function closeSaveModal() {
  showSaveModal.value = false;
}

function openCreateListModal() {
  createListName.value = "";
  createListDescription.value = "";
  setStatus(listStatus, "", "");
  showCreateListModal.value = true;
}

function closeCreateListModal() {
  showCreateListModal.value = false;
}

function clearAiTags() {
  Object.keys(aiTags).forEach((key) => delete aiTags[key]);
}

function setView(nextView) {
  view.value = nextView;
  showAiModal.value = false;
  showSaveModal.value = false;
  showMoveModal.value = false;
  showCreateListModal.value = false;
  if (nextView === "discard") {
    loadDiscardHistory();
  }
}

function setSelectedWindow(windowId) {
  selectedWindowId.value = windowId;
  Object.keys(selectedTabIds).forEach((key) => delete selectedTabIds[key]);
  resetAiTags();
}

function setSelectedList(listId) {
  selectedListId.value = listId;
  clearListSelection();
  isEditingListName.value = false;
  syncListName();
  syncListDescription();
  syncMoveTarget();
  showMoveModal.value = false;
  showCreateListModal.value = false;
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

async function saveListName() {
  if (!selectedList.value) {
    return;
  }
  const nextName = listNameDraft.value.trim();
  if (!nextName) {
    setStatus(listStatus, "列表名称不能为空。", "error");
    return;
  }
  const response = await request("renameList", {
    listId: selectedList.value.id,
    name: nextName,
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "重命名失败。", "error");
    return;
  }
  isEditingListName.value = false;
  setStatus(listStatus, "列表已重命名。", "ok");
  await loadLists();
}

async function moveSelectedListItems() {
  if (!selectedList.value) {
    setStatus(listStatus, "请先选择一个列表。", "error");
    return;
  }
  const indices = getSelectedListIndices();
  if (indices.length === 0) {
    setStatus(listStatus, "请先选择要移动的标签。", "error");
    return;
  }
  const isNewTarget = moveTargetListId.value === MOVE_NEW_LIST_VALUE;
  const targetListId = isNewTarget ? "" : moveTargetListId.value;
  const newListName = isNewTarget ? moveNewListName.value.trim() : "";
  if (isNewTarget && !newListName) {
    setStatus(listStatus, "请输入新建列表名称。", "error");
    return;
  }
  setStatus(listStatus, "正在移动标签...", "");
  const response = await request("moveListItems", {
    listId: selectedList.value.id,
    indices,
    targetListId,
    newListName,
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "移动失败。", "error");
    return;
  }
  const moved = response.result ? response.result.moved : 0;
  setStatus(listStatus, `已移动 ${moved} 个标签。`, "ok");
  moveNewListName.value = "";
  clearListSelection();
  await loadLists();
}

async function confirmMoveSelected() {
  await moveSelectedListItems();
  if (listStatus.type !== "error") {
    closeMoveModal();
  }
}

async function confirmCreateList() {
  const name = createListName.value.trim();
  if (!name) {
    setStatus(listStatus, "请输入列表名称。", "error");
    return;
  }
  const response = await request("createList", {
    name,
    description: createListDescription.value.trim(),
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "创建列表失败。", "error");
    return;
  }
  const created = response.result ? response.result.list : null;
  setStatus(listStatus, "列表已创建。", "ok");
  createListName.value = "";
  createListDescription.value = "";
  if (created && created.id) {
    selectedListId.value = created.id;
  }
  await loadLists();
  closeCreateListModal();
}


function setVisibleSelection(checked) {
  windowsToRender.value.forEach((win) => {
    (win.tabs || []).forEach((tab) => {
      if (checked) {
        selectedTabIds[tab.id] = true;
      } else {
        delete selectedTabIds[tab.id];
      }
    });
  });
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

function selectAllListItems() {
  listItems.value.forEach((item) => {
    selectedListItemKeys[item.key] = true;
  });
}

function clearHistorySelection() {
  Object.keys(historySelectedTabIds).forEach((key) => delete historySelectedTabIds[key]);
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

function getSelectedListIndices() {
  const indices = [];
  listItems.value.forEach((item) => {
    if (selectedListItemKeys[item.key]) {
      indices.push(item.index);
    }
  });
  return indices;
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

function normalizeName(name) {
  return String(name || "").trim();
}

function findListByName(name) {
  const target = normalizeName(name);
  if (!target) {
    return null;
  }
  return lists.value.find((list) => normalizeName(list.name) === target) || null;
}

async function saveTabToAiGroup(tab, closeTab) {
  if (!tab || !tab.id) {
    return;
  }
  const label = normalizeName(aiTags[tab.id]);
  if (!label) {
    return;
  }
  const existing = findListByName(label);
  const response = await request("saveTabs", {
    tabIds: [tab.id],
    listId: existing ? existing.id : "",
    newListName: existing ? "" : label,
    closeTabs: Boolean(closeTab),
  });
  if (!response.ok) {
    setStatus(aiStatus, response.error || "保存到分组失败。", "error");
    return;
  }
  const actionText = closeTab ? "保存并关闭" : "保存";
  setStatus(aiStatus, `已${actionText}到列表：${label}`, "ok");
  await loadLists();
  if (closeTab) {
    await loadWindows();
  }
}

function activateTab(tab) {
  if (!tab || !tab.id) {
    return;
  }
  if (tab.windowId) {
    chrome.windows.update(tab.windowId, { focused: true });
  }
  chrome.tabs.update(tab.id, { active: true });
}

function openSavedInNewWindow(item) {
  const url = item && item.url ? String(item.url) : "";
  if (!url) {
    return;
  }
  chrome.windows.create({ url });
}

function getSelectedTabsFrom(selectionMap, sourceTabs) {
  const selected = new Set(Object.keys(selectionMap));
  const results = [];
  const seen = new Set();
  sourceTabs.forEach((tab) => {
    const key = String(tab.id);
    if (!selected.has(key) || seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(tab);
  });
  return results;
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
  return getSelectedTabsFrom(selectedTabIds, getWindowTabsFlat());
}

function getSelectedHistoryTabs() {
  return getSelectedTabsFrom(historySelectedTabIds, historyTabsFlat.value);
}

function getSelectedTabsForView(targetView) {
  if (targetView === "discard") {
    return getSelectedHistoryTabs();
  }
  return getSelectedWindowTabs();
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
  let index = 0;
  return tabs.map((tab) => {
    const item = {
      tabId: tab.id,
      title: tab.title || "",
      domain: getBaseDomain(tab.url),
      index,
    };
    index += 1;
    return item;
  });
}

function applyTags(groups) {
  clearAiTags();
  groups.forEach((group) => {
    const label = group.label || "未分组";
    (group.tabIds || []).forEach((tabId) => {
      aiTags[tabId] = label;
    });
  });
}

async function request(action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      resolve(response || { ok: false, error: "无响应" });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTabsInBatches(ids) {
  const batchSize = 100;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await new Promise((resolve) => {
      chrome.tabs.remove(batch, () => resolve());
    });
    if (i + batchSize < ids.length) {
      await delay(150);
    }
  }
}

async function discardTab(tab) {
  if (!tab || !tab.id) {
    return;
  }
  const response = await request("manualDiscard", { tabId: tab.id });
  const statusTarget = view.value === "discard" ? discardDebugStatus : status;
  if (!response.ok) {
    setStatus(statusTarget, response.error || "冻结失败。", "error");
    return;
  }
  if (response.skipped) {
    setStatus(statusTarget, "该标签已冻结。", "ok");
  } else {
    setStatus(statusTarget, "已冻结标签页。", "ok");
  }
  await loadWindows();
  if (view.value === "discard") {
    await loadDiscardHistory();
  }
}

async function closeTab(tab) {
  if (!tab || !tab.id) {
    return;
  }
  chrome.tabs.remove(tab.id, () => {
    loadWindows();
  });
}

async function closeSelectedTabs() {
  await closeSelectedTabsForView("windows");
}

async function closeSelectedHistoryTabs() {
  await closeSelectedTabsForView("discard");
}

async function closeSelectedTabsForView(targetView) {
  const selectedTabs = getSelectedTabsForView(targetView);
  const statusTarget = targetView === "discard" ? discardDebugStatus : status;
  if (selectedTabs.length === 0) {
    setStatus(statusTarget, "请先选择要关闭的标签页。", "error");
    return;
  }
  const ids = selectedTabs.map((tab) => tab.id).filter(Boolean);
  setStatus(statusTarget, "正在关闭标签页...", "");
  await removeTabsInBatches(ids);
  setStatus(statusTarget, `已关闭 ${ids.length} 个标签页。`, "ok");
  if (targetView === "discard") {
    clearHistorySelection();
    await loadDiscardHistory();
  }
  await loadWindows();
}

async function runAiGrouping() {
  const selectedTabs = getSelectedTabsForView(aiContextView.value);
  if (selectedTabs.length === 0) {
    setStatus(aiStatus, "请先选择需要分组的标签页。", "error");
    return;
  }
  if (!aiConfig.endpoint || !aiConfig.apiKey || !aiConfig.model) {
    setStatus(aiStatus, "请先在设置中配置 AI 端点、Key 和模型。", "error");
    return;
  }
  const items = buildAiItems(selectedTabs);
  setStatus(aiStatus, "AI 分组中...", "");
  const response = await request("aiGroupTabs", { items });
  if (!response.ok) {
    setStatus(aiStatus, response.error || "AI 分组失败。", "error");
    return;
  }
  aiGroups.value = response.result ? response.result.groups || [] : [];
  if (aiGroups.value.length === 0) {
    setStatus(aiStatus, "未生成有效分组。", "error");
    return;
  }
  applyTags(aiGroups.value);
  const truncated = response.result && response.result.truncated ? response.result.truncated : 0;
  const suffix = truncated > 0 ? `（已截断 ${truncated} 个标签页）` : "";
  setStatus(aiStatus, `已生成 ${aiGroups.value.length} 组标签。${suffix}`, "ok");
}

async function applyAiGrouping() {
  if (aiGroups.value.length === 0) {
    setStatus(aiStatus, "请先执行 AI 分组。", "error");
    return;
  }
  setStatus(aiStatus, "正在生成新列表...", "");
  const response = await request("saveGroupedTabs", { groups: aiGroups.value });
  if (!response.ok) {
    setStatus(aiStatus, response.error || "生成新列表失败。", "error");
    return;
  }
  const created = response.result ? response.result.created : 0;
  setStatus(aiStatus, `已生成 ${created} 个新列表。`, "ok");
  await loadLists();
}

async function saveSelectedTabs() {
  const selectedTabs = getSelectedTabsForView(saveContextView.value);
  if (selectedTabs.length === 0) {
    setStatus(status, "请至少选择一个标签页。", "error");
    return;
  }

  const isNewList = selectedListTarget.value === NEW_LIST_VALUE;
  const listId = isNewList ? "" : selectedListTarget.value;
  const listName = isNewList ? newListName.value.trim() : "";
  const listDescription = isNewList ? newListDescription.value.trim() : "";

  if (isNewList && !listName) {
    setStatus(status, "请输入新列表名称。", "error");
    return;
  }

  setStatus(status, "保存中...", "");
  const response = await request("saveTabs", {
    tabIds: selectedTabs.map((tab) => tab.id),
    listId,
    newListName: listName,
    newListDescription: listDescription,
    closeTabs: closeAfter.value,
  });

  if (!response.ok) {
    setStatus(status, response.error || "保存失败。", "error");
    return;
  }

  const savedCount = response.result ? response.result.savedCount : 0;
  setStatus(status, `已保存 ${savedCount} 个标签页。`, "ok");
  newListName.value = "";
  newListDescription.value = "";
  await loadLists();

  if (closeAfter.value) {
    await loadWindows();
  }
}

async function exportLists() {
  const response = await request("getLists");
  if (!response.ok) {
    setStatus(listStatus, response.error || "导出失败。", "error");
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
  setStatus(listStatus, "已导出列表文件。", "ok");
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
      setStatus(listStatus, response.error || "导入失败。", "error");
      return;
    }
    setStatus(listStatus, `已导入 ${response.result.imported} 个列表。`, "ok");
    await loadLists();
  } catch (error) {
    setStatus(listStatus, "JSON 文件无效。", "error");
  } finally {
    event.target.value = "";
  }
}

async function deleteList() {
  if (!selectedListId.value) {
    setStatus(listStatus, "请先选择一个列表。", "error");
    return;
  }
  const confirmed = window.confirm("确定要删除该列表吗？此操作不可撤销。");
  if (!confirmed) {
    return;
  }
  const response = await request("deleteList", { listId: selectedListId.value });
  if (!response.ok) {
    setStatus(listStatus, response.error || "删除列表失败。", "error");
    return;
  }
  setStatus(listStatus, "列表已删除。", "ok");
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
    setStatus(listStatus, response.error || "删除失败。", "error");
    return;
  }
  setStatus(listStatus, "已删除标签。", "ok");
  await loadLists();
}

async function deleteSelectedListItems() {
  if (!selectedListId.value) {
    setStatus(listStatus, "请先选择一个列表。", "error");
    return;
  }
  const indices = listItems.value
    .filter((item) => selectedListItemKeys[item.key])
    .map((item) => item.index);
  if (indices.length === 0) {
    setStatus(listStatus, "请先选择要删除的标签。", "error");
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
    setStatus(listStatus, response.error || "删除失败。", "error");
    return;
  }
  setStatus(listStatus, `已删除 ${indices.length} 个标签。`, "ok");
  clearListSelection();
  await loadLists();
}

async function saveListDescription() {
  if (!selectedList.value) {
    setStatus(listStatus, "请先选择列表。", "error");
    return;
  }
  const response = await request("updateListDescription", {
    listId: selectedList.value.id,
    description: listDescriptionDraft.value,
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "保存描述失败。", "error");
    return;
  }
  setStatus(listStatus, "列表描述已更新。", "ok");
  await loadLists();
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
  resetAiTags();
}

async function loadLists() {
  const response = await request("getLists");
  if (!response.ok) {
    setStatus(status, response.error || "列表加载失败。", "error");
    setStatus(listStatus, response.error || "列表加载失败。", "error");
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

async function loadAiConfig() {
  const response = await request("getAiConfig");
  if (!response.ok) {
    setStatus(settingsStatus, response.error || "AI 配置加载失败。", "error");
    return;
  }
  const config = response.config || {};
  aiConfig.endpoint = config.endpoint || "https://api.openai.com/v1/responses";
  aiConfig.apiKey = config.apiKey || "";
  aiConfig.model = config.model || "gpt-4.1-mini";
  aiConfig.apiMode =
    config.apiMode === "chat" || config.apiMode === "codex" ? config.apiMode : "responses";
  aiConfig.maxTabs = Number.isFinite(config.maxTabs) ? config.maxTabs : 120;
  aiConfig.includeListTitles =
    config.includeListTitles === undefined ? true : Boolean(config.includeListTitles);
}

async function saveAiConfig() {
  if (!aiConfig.endpoint || !aiConfig.apiKey) {
    setStatus(settingsStatus, "请填写 API 端点与 Key。", "error");
    return;
  }
  const response = await request("saveAiConfig", { config: aiConfig });
  if (!response.ok) {
    setStatus(settingsStatus, response.error || "保存失败。", "error");
    return;
  }
  setStatus(settingsStatus, "AI 配置已保存。", "ok");
}

function normalizeWhitelistInput(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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

function formatLocalTime(timestamp) {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
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

onMounted(async () => {
  await loadWindows();
  await loadLists();
  await loadAiConfig();
  await loadDiscardConfig();
});
</script>
