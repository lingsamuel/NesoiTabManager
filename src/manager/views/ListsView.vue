<template>
  <section class="view view-lists">
    <div class="content-header">
      <div class="content-title">
        <div v-if="isEditingListName" class="title-edit">
          <input
            ref="listNameInput"
            class="title-input"
            type="text"
            :value="listNameDraft"
            @input="onUpdateListNameDraft($event.target.value)"
            @keydown.enter.prevent="onSaveListName"
            @keydown.esc.prevent="onCancelEditListName"
          />
          <button class="ghost btn-icon" @click="onCancelEditListName">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6l-12 12" />
              </svg>
            </span>
            取消
          </button>
          <button class="primary btn-icon" @click="onSaveListName">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
              </svg>
            </span>
            保存
          </button>
        </div>
        <h1
          v-else
          class="clickable"
          :class="{ disabled: !selectedList }"
          @click="onStartEditListName"
        >
          {{ listTitle }}
        </h1>
        <div class="content-subtitle">{{ listSubtitle }}</div>
      </div>
      <!--
        操作按钮分两行固定：列表级动作跟标题同行，选中集相关动作跟筛选框同行。
        原因见 docs 里「固定按钮位置」：同一行里既有会被撑宽的筛选框、又有近十个按钮时，
        一旦换行按钮位置就会漂移，用户每次都要重新找。
      -->
      <div class="content-actions title-actions">
        <button class="ghost danger btn-icon" @click="onDeleteList">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 7h16M9 7v10M15 7v10M6 7l1-3h10l1 3M7 20h10" />
            </svg>
          </span>
          删除列表
        </button>
        <button class="ghost btn-icon" @click="onExportLists">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 3v12M8 11l4 4 4-4M5 21h14" />
            </svg>
          </span>
          导出列表
        </button>
        <label class="ghost import-label btn-icon" for="import-file">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 21V9M8 13l4-4 4 4M5 3h14" />
            </svg>
          </span>
          导入列表
        </label>
        <input id="import-file" type="file" accept="application/json" @change="onImportLists" />
      </div>
    </div>

    <div class="filter-row">
      <FilterBar
        :model-value="filterQuery"
        :mode="filterMode"
        :match-count="matchCount"
        :current-index="currentMatchPosition"
        :has-query="Boolean(committedFilterQuery)"
        @update:model-value="onUpdateFilterQuery"
        @commit="onCommitFilterQuery"
        @mode-change="onModeChange"
        @next="goToNext"
        @prev="goToPrev"
      />
      <div class="filter-actions">
        <button class="ghost btn-icon" @click="onSelectAllListItems">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
          全选
        </button>
        <button class="ghost btn-icon" @click="onClearListSelection">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </span>
          全不选
        </button>
        <button class="ghost danger btn-icon" @click="onDeleteSelectedListItems">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 7h16M9 7v10M15 7v10M6 7l1-3h10l1 3M7 20h10" />
            </svg>
          </span>
          删除所选
        </button>
        <button class="ghost btn-icon" :disabled="!selectedList" @click="onOpenMoveModal">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
          移动所选
        </button>
      </div>
    </div>

    <section class="panel">
      <div class="panel-header">
        <h2>列表描述</h2>
        <div class="panel-actions">
          <button class="ghost btn-icon" :disabled="!selectedList" @click="onClearListDescription">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6l-12 12" />
              </svg>
            </span>
            清空描述
          </button>
          <button class="primary btn-icon" :disabled="!selectedList" @click="onSaveListDescription">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
              </svg>
            </span>
            保存描述
          </button>
        </div>
      </div>
      <div class="form-row">
        <label for="list-description">用于指导 AI 分组，可留空</label>
        <textarea
          id="list-description"
          rows="4"
          :disabled="!selectedList"
          placeholder="例如：客户调研、竞品分析"
          :value="listDescriptionDraft"
          @input="onUpdateListDescriptionDraft($event.target.value)"
        ></textarea>
      </div>
    </section>

    <ListsPanel
      ref="panelRef"
      :items="listItems"
      :item-height="64"
      :selected-map="selectedListItemKeys"
      :highlight-matches="isJumpMode"
      :current-match-index="currentMatchIndex"
      :empty-text="emptyText"
      :on-toggle-selection="onToggleListItemSelection"
      :on-toggle-item="onToggleListItem"
      :on-delete-item="onDeleteListItem"
      :on-open-item="onOpenSavedInNewWindow"
      @marker-click="onMarkerClick"
    />

    <section class="panel">
      <div class="panel-header">
        <h2>导入选项</h2>
      </div>
      <div class="form-row checkbox-row">
        <label>
          <input
            type="checkbox"
            :checked="importReplace"
            @change="onUpdateImportReplace($event.target.checked)"
          />
          导入时替换现有列表
        </label>
      </div>
      <div class="status" :class="listStatus.type">{{ listStatus.message }}</div>
    </section>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";
import FilterBar from "../components/FilterBar.vue";
import ListsPanel from "../components/ListsPanel.vue";
import { useMatchNavigation } from "../composables/useMatchNavigation.js";

const props = defineProps({
  isEditingListName: {
    type: Boolean,
    default: false,
  },
  listNameDraft: {
    type: String,
    default: "",
  },
  listTitle: {
    type: String,
    default: "",
  },
  listSubtitle: {
    type: String,
    default: "",
  },
  selectedList: {
    type: Object,
    default: null,
  },
  listItems: {
    type: Array,
    default: () => [],
  },
  filterQuery: {
    type: String,
    default: "",
  },
  committedFilterQuery: {
    type: String,
    default: "",
  },
  filterMode: {
    type: String,
    default: "filter",
  },
  selectedListItemKeys: {
    type: Object,
    default: () => ({}),
  },
  listDescriptionDraft: {
    type: String,
    default: "",
  },
  listStatus: {
    type: Object,
    default: () => ({ message: "", type: "" }),
  },
  importReplace: {
    type: Boolean,
    default: false,
  },
  onUpdateFilterQuery: {
    type: Function,
    default: null,
  },
  onCommitFilterQuery: {
    type: Function,
    default: null,
  },
  onModeChange: {
    type: Function,
    default: null,
  },
  onUpdateListNameDraft: {
    type: Function,
    default: null,
  },
  onUpdateListDescriptionDraft: {
    type: Function,
    default: null,
  },
  onUpdateImportReplace: {
    type: Function,
    default: null,
  },
  onStartEditListName: {
    type: Function,
    default: null,
  },
  onCancelEditListName: {
    type: Function,
    default: null,
  },
  onSaveListName: {
    type: Function,
    default: null,
  },
  onSelectAllListItems: {
    type: Function,
    default: null,
  },
  onClearListSelection: {
    type: Function,
    default: null,
  },
  onDeleteSelectedListItems: {
    type: Function,
    default: null,
  },
  onOpenMoveModal: {
    type: Function,
    default: null,
  },
  onDeleteList: {
    type: Function,
    default: null,
  },
  onExportLists: {
    type: Function,
    default: null,
  },
  onImportLists: {
    type: Function,
    default: null,
  },
  onOpenSavedInNewWindow: {
    type: Function,
    default: null,
  },
  onToggleListItemSelection: {
    type: Function,
    default: null,
  },
  onToggleListItem: {
    type: Function,
    default: null,
  },
  onDeleteListItem: {
    type: Function,
    default: null,
  },
  onClearListDescription: {
    type: Function,
    default: null,
  },
  onSaveListDescription: {
    type: Function,
    default: null,
  },
});

/**
 * 空状态文案分三种情况，避免"列表里就是空的"被误报成"没有列表"：
 * 有关键词 → 搜索无结果；完全没有列表 → 提示去新建；选了列表但内容为空 → 说明该列表为空。
 */
const emptyText = computed(() => {
  if (props.filterQuery) {
    return "未找到匹配的标签页。";
  }
  if (!props.selectedList) {
    return "暂无已保存的列表。";
  }
  return "该列表暂无保存的标签页。";
});

const isJumpMode = computed(
  () => props.filterMode === "jump" && Boolean(props.committedFilterQuery)
);

const {
  matchCount,
  currentMatchIndex,
  currentMatchPosition,
  goToNext,
  goToPrev,
  setCurrentMatchByRowIndex,
} = useMatchNavigation({
  rows: computed(() => props.listItems),
  isMatchRow: (item) => Boolean(item && item.matched),
  mode: computed(() => props.filterMode),
  hasQuery: computed(() => Boolean(props.committedFilterQuery)),
});

const panelRef = ref(null);

/** 把某一行滚到可视区并居中（列表自身仍是"当前项变化即自动滚动"）。 */
function scrollToRow(index) {
  if (index < 0 || !panelRef.value || typeof panelRef.value.scrollToIndex !== "function") {
    return;
  }
  panelRef.value.scrollToIndex(index);
}

/**
 * 点击滚动条刻度：滚到对应行。
 * 点到的是匹配刻度时同步"当前跳转项"，这样 ↑/↓ 会从用户点的那一项继续——
 * 与「打开的窗口」视图同一条规则。
 */
function onMarkerClick(marker) {
  if (!marker) {
    return;
  }
  if (props.filterMode === "jump" && Number.isFinite(marker.matchIndex)) {
    setCurrentMatchByRowIndex(marker.matchIndex);
  }
  scrollToRow(marker.index);
}

const listNameInput = ref(null);

watch(
  () => props.isEditingListName,
  (active) => {
    if (!active) {
      return;
    }
    nextTick(() => {
      if (listNameInput.value) {
        listNameInput.value.focus();
        listNameInput.value.select();
      }
    });
  }
);

</script>
