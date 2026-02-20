<template>
  <div class="app" :class="{ 'no-sub': !hasSubSidebar, overlay: isOverlay }">
    <aside v-if="!isOverlay" class="sidebar">
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

    <aside
      v-if="!isOverlay"
      class="sub-sidebar"
      :class="{ hidden: view === 'settings' || view === 'discard' || view === 'recent' }"
    >
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
        :hide-discarded="hideDiscarded"
        :on-select-all="() => setVisibleSelection(true)"
        :on-clear="() => setVisibleSelection(false)"
        :on-close-selected="closeSelectedTabs"
        :on-discard-selected="() => discardSelectedTabsForView('windows')"
        :on-open-move-modal="openWindowMoveModal"
        :on-open-ai="openAiModal"
        :on-open-save="openSaveModal"
        :on-toggle-hide-discarded="toggleHideDiscarded"
        :on-toggle-selection="toggleTabSelection"
        :on-toggle-tab="toggleTab"
        :on-drop-tab="handleWindowDrop"
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

      <RecentView
        v-show="view === 'recent'"
        :subtitle="recentSubtitle"
        :rows="recentRows"
        :selected-tab-ids="selectedRecentTabIds"
        :ai-tags="aiTags"
        :on-select-all="() => setRecentSelection(true)"
        :on-clear="clearRecentSelection"
        :on-close-selected="() => closeSelectedTabsForView('recent')"
        :on-discard-selected="() => discardSelectedTabsForView('recent')"
        :on-open-move-modal="openWindowMoveModal"
        :on-open-ai="openAiModal"
        :on-open-save="openSaveModal"
        :on-mark-reviewed="markRecentReviewed"
        :on-toggle-selection="toggleRecentTabSelection"
        :on-toggle-tab="toggleRecentTab"
        :on-activate="activateTab"
        :on-close="closeTab"
        :on-discard="discardTab"
        :on-save-ai-group="saveTabToAiGroup"
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

      <div v-if="showWindowMoveModal" class="modal-backdrop" @click.self="closeWindowMoveModal">
        <div class="modal">
          <div class="modal-header">
            <h3>移动到窗口</h3>
            <button class="ghost btn-icon" @click="closeWindowMoveModal">
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
              <label for="move-window-select">目标窗口</label>
              <select id="move-window-select" v-model="windowMoveTargetId">
                <option v-for="win in windowMoveTargets" :key="win.id" :value="win.id">
                  {{ win.label }}（{{ win.count }}）
                </option>
                <option :value="NEW_WINDOW_VALUE">新建窗口</option>
              </select>
            </div>
            <div class="status" :class="windowMoveStatus.type">
              {{ windowMoveStatus.message }}
            </div>
          </div>
          <div class="modal-actions">
            <button class="ghost btn-icon" @click="closeWindowMoveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              取消
            </button>
            <button class="primary btn-icon" @click="confirmMoveWindowTabs">
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
        :recent-config="recentConfig"
        :settings-status="settingsStatus"
        :discard-config-status="discardConfigStatus"
        :recent-config-status="recentConfigStatus"
        :on-save-ai-config="saveAiConfig"
        :on-save-discard-config="saveDiscardConfig"
        :on-save-recent-config="saveRecentConfig"
      />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import WindowsView from "./views/WindowsView.vue";
import ListsView from "./views/ListsView.vue";
import RecentView from "./views/RecentView.vue";
import HistoryView from "./views/HistoryView.vue";
import SettingsView from "./views/SettingsView.vue";
import { useAiGrouping } from "./composables/useAiGrouping.js";
import { useDiscard } from "./composables/useDiscard.js";
import { useRecent } from "./composables/useRecent.js";
import { MOVE_NEW_LIST_VALUE, NEW_LIST_VALUE, useLists } from "./composables/useLists.js";
import { useWindows } from "./composables/useWindows.js";
import { request } from "./utils/request.js";
import { moveTabsInBatches, removeTabsInBatches } from "./utils/helpers.js";

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
    key: "recent",
    label: "近期标签页",
    icon: "M5 7h14M7 11h10M9 15h6",
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

const NEW_WINDOW_VALUE = "__new_window__";

const appMode = (() => {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("mode") || "";
  } catch (error) {
    return "";
  }
})();
const isOverlay = computed(() => appMode === "overlay");
const view = ref(isOverlay.value ? "recent" : "windows");
const hideDiscarded = ref(false);
const hasSubSidebar = computed(
  () => !isOverlay.value && (view.value === "windows" || view.value === "lists")
);
const status = reactive({ message: "", type: "" });
const settingsStatus = reactive({ message: "", type: "" });
const windowMoveStatus = reactive({ message: "", type: "" });
const recentConfig = reactive({
  reminderIntervalMin: 15,
  startupDelaySec: 60,
  startupQuietSec: 15,
  startupMaxGraceSec: 900,
});
const recentConfigStatus = reactive({ message: "", type: "" });

const {
  windows,
  selectedWindowId,
  selectedTabIds,
  totalTabCount,
  windowSubItems,
  windowSubtitle,
  windowRows,
  setSelectedWindow: setSelectedWindowBase,
  setVisibleSelection,
  toggleTab,
  toggleTabSelection,
  clearWindowSelection,
  getSelectedWindowTabs,
  loadWindows,
} = useWindows({ hideDiscarded });

const {
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
  setSelectedList: setSelectedListBase,
  startEditListName,
  cancelEditListName,
  selectAllListItems,
  clearListSelection,
  toggleListItem,
  toggleListItemSelection,
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
} = useLists({ request, statusTarget: status });

const {
  discardConfig,
  discardConfigStatus,
  discardDebugStatus,
  historySelectedTabIds,
  historySubtitle,
  historyRows,
  setHistorySelection,
  toggleHistoryTab,
  toggleHistoryTabSelection,
  clearHistorySelection,
  getSelectedHistoryTabs,
  loadDiscardConfig,
  saveDiscardConfig,
  loadDiscardHistory,
} = useDiscard({ request, view });

const {
  recentTabs,
  selectedRecentTabIds,
  recentSubtitle,
  recentRows,
  setRecentSelection,
  toggleRecentTab,
  toggleRecentTabSelection,
  clearRecentSelection,
  getSelectedRecentTabs,
  loadRecentTabs,
  markReviewed: markRecentReviewed,
} = useRecent({ request });

const aiContextView = ref("windows");
const saveContextView = ref("windows");
const showMoveModal = ref(false);
const showWindowMoveModal = ref(false);
const showCreateListModal = ref(false);
const showAiModal = ref(false);
const showSaveModal = ref(false);
const closeAfter = ref(false);
const windowMoveTargetId = ref(NEW_WINDOW_VALUE);
const windowMoveContextView = ref("windows");
const windowMoveTargets = computed(() =>
  windows.value.map((win, index) => ({
    id: String(win.id),
    label: `窗口 ${index + 1}`,
    count: win.tabs ? win.tabs.length : 0,
  }))
);

let resetAiTags = () => {};
const refreshWindows = async () => {
  await loadWindows();
  resetAiTags();
};

const getSelectedTabsForView = (targetView) => {
  if (targetView === "discard") {
    return getSelectedHistoryTabs();
  }
  if (targetView === "recent") {
    return getSelectedRecentTabs();
  }
  return getSelectedWindowTabs();
};

function getWindowTabOrder(windowId) {
  const win = windows.value.find((item) => String(item.id) === String(windowId));
  if (!win || !Array.isArray(win.tabs)) {
    return [];
  }
  return win.tabs
    .slice()
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((tab) => tab.id);
}

const {
  aiConfig,
  aiStatus,
  aiTags,
  resetAiTags: resetAiTagsFromAi,
  setAiStatus,
  loadAiConfig,
  saveAiConfig,
  runAiGrouping,
  applyAiGrouping,
  saveTabToAiGroup,
} = useAiGrouping({
  request,
  lists,
  getSelectedTabs: () => getSelectedTabsForView(aiContextView.value),
  loadLists,
  loadWindows: refreshWindows,
  settingsStatus,
});

resetAiTags = resetAiTagsFromAi;

function setStatus(target, message, type) {
  target.message = message;
  target.type = type || "";
}

function applyRecentConfig(config) {
  recentConfig.reminderIntervalMin = Number.isFinite(Number(config.reminderIntervalMin))
    ? Number(config.reminderIntervalMin)
    : 15;
  recentConfig.startupDelaySec = Number.isFinite(Number(config.startupDelaySec))
    ? Number(config.startupDelaySec)
    : 60;
  recentConfig.startupQuietSec = Number.isFinite(Number(config.startupQuietSec))
    ? Number(config.startupQuietSec)
    : 15;
  recentConfig.startupMaxGraceSec = Number.isFinite(Number(config.startupMaxGraceSec))
    ? Number(config.startupMaxGraceSec)
    : 900;
}

async function loadRecentConfig() {
  const response = await request("getRecentConfig");
  if (!response.ok) {
    setStatus(recentConfigStatus, response.error || "近期标签页配置加载失败。", "error");
    return;
  }
  applyRecentConfig(response.config || {});
}

async function saveRecentConfig() {
  const payload = {
    reminderIntervalMin: Number(recentConfig.reminderIntervalMin),
    startupDelaySec: Number(recentConfig.startupDelaySec),
    startupQuietSec: Number(recentConfig.startupQuietSec),
    startupMaxGraceSec: Number(recentConfig.startupMaxGraceSec),
  };
  const response = await request("saveRecentConfig", { config: payload });
  if (!response.ok) {
    setStatus(recentConfigStatus, response.error || "保存失败。", "error");
    return;
  }
  applyRecentConfig(response.config || payload);
  setStatus(recentConfigStatus, "近期标签页提醒已保存。", "ok");
}

function normalizeTabId(tabId) {
  const id = Number(tabId);
  return Number.isFinite(id) ? id : null;
}

function collectTabIds(tabs) {
  const ids = [];
  (Array.isArray(tabs) ? tabs : []).forEach((tab) => {
    const id = normalizeTabId(tab && tab.id);
    if (id !== null) {
      ids.push(id);
    }
  });
  return ids;
}

function setView(nextView) {
  view.value = nextView;
  showAiModal.value = false;
  showSaveModal.value = false;
  showMoveModal.value = false;
  showWindowMoveModal.value = false;
  showCreateListModal.value = false;
  if (nextView === "discard") {
    loadDiscardHistory();
  }
  if (nextView === "recent") {
    loadRecentTabs();
  }
}

function setSelectedWindow(windowId) {
  setSelectedWindowBase(windowId);
  resetAiTags();
}

function setSelectedList(listId) {
  setSelectedListBase(listId);
  showMoveModal.value = false;
  showCreateListModal.value = false;
}

function openMoveModal() {
  if (!selectedList.value) {
    setListStatus("请先选择一个列表。", "error");
    return;
  }
  setListStatus("", "");
  syncMoveTarget();
  showMoveModal.value = true;
}

function closeMoveModal() {
  showMoveModal.value = false;
}

function setWindowMoveStatus(message, type) {
  windowMoveStatus.message = message;
  windowMoveStatus.type = type || "";
}

function openWindowMoveModal() {
  setWindowMoveStatus("", "");
  windowMoveTargetId.value = NEW_WINDOW_VALUE;
  windowMoveContextView.value = view.value;
  showWindowMoveModal.value = true;
}

function closeWindowMoveModal() {
  showWindowMoveModal.value = false;
}

function openAiModal() {
  setAiStatus("", "");
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

function toggleHideDiscarded(checked) {
  hideDiscarded.value = checked;
}

function closeSaveModal() {
  showSaveModal.value = false;
}

function openCreateListModal() {
  createListName.value = "";
  createListDescription.value = "";
  setListStatus("", "");
  showCreateListModal.value = true;
}

function closeCreateListModal() {
  showCreateListModal.value = false;
}

async function confirmMoveSelected() {
  await moveSelectedListItems();
  if (listStatus.type !== "error") {
    closeMoveModal();
  }
}

async function handleWindowDrop(targetTab, selectedTabs) {
  if (!targetTab || !targetTab.id) {
    return;
  }
  const selectionList = Array.isArray(selectedTabs) ? selectedTabs : [];
  let tabsToMove = selectionList;
  if (selectionList.length === 1 && selectionList[0] && selectionList[0].id) {
    const draggedId = String(selectionList[0].id);
    const allSelected = getSelectedWindowTabs();
    const draggedIsSelected = allSelected.some(
      (tab) => String(tab.id) === draggedId
    );
    if (draggedIsSelected && allSelected.length > 1) {
      tabsToMove = allSelected;
    }
  }
  const tabIdsRaw = tabsToMove.map((tab) => tab.id).filter(Boolean);
  if (tabIdsRaw.length === 0) {
    return;
  }
  const targetId = String(targetTab.id);
  if (selectedWindowId.value !== "all") {
    if (String(targetTab.windowId) !== String(selectedWindowId.value)) {
      return;
    }
  }
  const targetWindowId = targetTab.windowId;
  if (targetWindowId === undefined || targetWindowId === null) {
    return;
  }
  const order = getWindowTabOrder(targetWindowId);
  if (order.length === 0) {
    return;
  }
  const tabIdsSet = new Set(tabIdsRaw.map((id) => String(id)));
  const sameWindowOnly = tabsToMove.every(
    (tab) => String(tab.windowId) === String(targetWindowId)
  );
  const tabIds = sameWindowOnly
    ? order.filter((id) => tabIdsSet.has(String(id)))
    : tabIdsRaw;
  if (tabIds.length === 0) {
    return;
  }
  const dragSet = new Set(tabIds.map((id) => String(id)));
  if (dragSet.has(targetId)) {
    return;
  }
  const remaining = order.filter((id) => !dragSet.has(String(id)));
  const targetPos = remaining.findIndex((id) => String(id) === targetId);
  if (targetPos === -1) {
    return;
  }
  const insertIndex = targetPos + 1;
  setStatus(status, "正在移动标签页...", "");
  try {
    await moveTabsInBatches(tabIds, targetWindowId, { index: insertIndex });
    setStatus(status, `已移动 ${tabIds.length} 个标签页。`, "ok");
    clearWindowSelection();
    await refreshWindows();
  } catch (error) {
    setStatus(status, error.message || "移动失败。", "error");
  }
}

async function createWindowWithTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.windows.create({ tabId }, (win) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "创建窗口失败"));
        return;
      }
      if (!win || win.id === undefined) {
        reject(new Error("创建窗口失败"));
        return;
      }
      resolve(win);
    });
  });
}

async function moveSelectedTabsToWindow() {
  const selectedTabs = getSelectedTabsForView(windowMoveContextView.value);
  if (selectedTabs.length === 0) {
    setWindowMoveStatus("请先选择要移动的标签页。", "error");
    return false;
  }
  const tabIds = selectedTabs.map((tab) => tab.id).filter(Boolean);
  if (tabIds.length === 0) {
    setWindowMoveStatus("未找到可移动的标签页。", "error");
    return false;
  }
  setWindowMoveStatus("正在移动标签页...", "");
  try {
    if (windowMoveTargetId.value === NEW_WINDOW_VALUE) {
      const firstTabId = tabIds[0];
      const targetWindow = await createWindowWithTab(firstTabId);
      const rest = tabIds.slice(1);
      if (rest.length > 0) {
        await moveTabsInBatches(rest, targetWindow.id);
      }
    } else {
      const targetWindowId = Number(windowMoveTargetId.value);
      if (!Number.isFinite(targetWindowId)) {
        setWindowMoveStatus("目标窗口无效。", "error");
        return false;
      }
      await moveTabsInBatches(tabIds, targetWindowId);
    }
    setWindowMoveStatus(`已移动 ${tabIds.length} 个标签页。`, "ok");
    if (windowMoveContextView.value === "recent") {
      clearRecentSelection();
      await loadRecentTabs();
    } else {
      clearWindowSelection();
    }
    await refreshWindows();
    return true;
  } catch (error) {
    setWindowMoveStatus(error.message || "移动失败。", "error");
    return false;
  }
}

async function confirmMoveWindowTabs() {
  const ok = await moveSelectedTabsToWindow();
  if (ok) {
    closeWindowMoveModal();
  }
}

async function confirmCreateList() {
  const created = await createList();
  if (created) {
    closeCreateListModal();
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
  await refreshWindows();
  if (view.value === "discard") {
    await loadDiscardHistory();
  }
  if (view.value === "recent") {
    await loadRecentTabs();
  }
}

async function closeTab(tab) {
  const tabId = normalizeTabId(tab && tab.id);
  if (tabId === null) {
    return;
  }
  const result = await removeTabsInBatches([tabId]);
  if (view.value === "discard") {
    if (!result || result.removed === 0) {
      setStatus(discardDebugStatus, "标签页已关闭或不存在。", "error");
    } else {
      setStatus(discardDebugStatus, "已关闭标签页。", "ok");
    }
  }
  await refreshWindows();
  if (view.value === "recent") {
    await loadRecentTabs();
  }
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
  const ids = collectTabIds(selectedTabs);
  if (ids.length === 0) {
    setStatus(statusTarget, "没有可关闭的标签页。", "error");
    return;
  }
  setStatus(statusTarget, "正在关闭标签页...", "");
  const result = await removeTabsInBatches(ids);
  const removed = result && Number.isFinite(result.removed) ? result.removed : ids.length;
  const skipped = result && Number.isFinite(result.skipped) ? result.skipped : 0;
  const skippedText = skipped > 0 ? `，跳过 ${skipped} 个` : "";
  setStatus(statusTarget, `已关闭 ${removed} 个标签页${skippedText}。`, "ok");
  if (targetView === "discard") {
    clearHistorySelection();
    await loadDiscardHistory();
  }
  if (targetView === "recent") {
    clearRecentSelection();
    await loadRecentTabs();
  }
  await refreshWindows();
}

async function discardSelectedTabsForView(targetView) {
  const selectedTabs = getSelectedTabsForView(targetView);
  if (selectedTabs.length === 0) {
    setStatus(status, "请先选择要冻结的标签页。", "error");
    return;
  }
  const ids = selectedTabs.map((tab) => tab.id).filter(Boolean);
  setStatus(status, "正在冻结标签页...", "");
  const response = await request("manualDiscardTabs", { tabIds: ids });
  if (!response.ok) {
    setStatus(status, response.error || "冻结失败。", "error");
    return;
  }
  const discarded = response.discarded || 0;
  const skipped = response.skipped || 0;
  const skippedText = skipped > 0 ? `，跳过 ${skipped} 个` : "";
  setStatus(status, `已冻结 ${discarded} 个标签页${skippedText}。`, "ok");
  if (targetView === "windows") {
    clearWindowSelection();
  }
  if (targetView === "recent") {
    clearRecentSelection();
    await loadRecentTabs();
  }
  await refreshWindows();
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
    await refreshWindows();
    if (saveContextView.value === "recent") {
      clearRecentSelection();
      await loadRecentTabs();
    }
  }
}

onMounted(async () => {
  await refreshWindows();
  await loadLists();
  await loadAiConfig();
  await loadDiscardConfig();
  await loadRecentConfig();
  await loadRecentTabs();
});
</script>
