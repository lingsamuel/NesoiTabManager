<template>
  <section class="view view-windows">
    <div class="content-header">
      <div>
        <h1>打开的窗口</h1>
        <div class="content-subtitle">{{ windowSubtitle }}</div>
      </div>
      <div class="content-actions">
        <div class="mode-switch" role="group" aria-label="展示模式">
          <button
            type="button"
            :class="{ active: treeMode }"
            @click="handleToggleTreeMode(true)"
          >
            树状
          </button>
          <button
            type="button"
            :class="{ active: !treeMode }"
            @click="handleToggleTreeMode(false)"
          >
            平铺
          </button>
        </div>
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
        <button class="ghost btn-icon" @click="onSelectAll">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
          全选
        </button>
        <button class="ghost btn-icon" @click="onClear">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </span>
          清空
        </button>
        <label class="checkbox-toggle">
          <input
            type="checkbox"
            :checked="hideDiscarded"
            @change="handleToggleHideDiscarded($event.target.checked)"
          />
          隐藏已冻结
        </label>
        <button class="ghost danger btn-icon" @click="onCloseSelected">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </span>
          关闭所选
        </button>
        <button class="ghost btn-icon" @click="onDiscardSelected">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
            </svg>
          </span>
          冻结所选
        </button>
        <button class="ghost btn-icon" @click="onOpenMoveModal">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
          移动到
        </button>
        <button class="ghost btn-icon" @click="onOpenAi">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 3l2.2 4.4L19 9l-4.8 1.6L12 15l-2.2-4.4L5 9l4.8-1.6z" />
            </svg>
          </span>
          AI 分组
        </button>
        <button class="ghost btn-icon" @click="onOpenSave">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
            </svg>
          </span>
          保存所选
        </button>
      </div>
    </div>

    <TabListPanel
      :rows="windowRows"
      :item-height="44"
      :selected-map="selectedTabIds"
      :ai-tags="aiTags"
      :enable-drag="true"
      :tree-mode="treeMode"
      :empty-text="emptyText"
      empty-row-text="此窗口没有标签页。"
      :highlight-matches="highlightMatches"
      :current-match-index="currentMatchIndex"
      :on-toggle-selection="onToggleSelection"
      :on-toggle-tab="onToggleTab"
      :on-activate="onActivate"
      :on-close="onClose"
      :on-discard="onDiscard"
      :on-save-ai-group="onSaveAiGroup"
      :on-drop-tab="onDropTab"
      :on-toggle-collapse="onToggleCollapse"
      :on-tree-drop="onTreeDrop"
      :is-tree-descendant="isTreeDescendant"
    />
  </section>
</template>

<script setup>
import { computed } from "vue";
import FilterBar from "../components/FilterBar.vue";
import TabListPanel from "../components/TabListPanel.vue";
import { useMatchNavigation } from "../composables/useMatchNavigation.js";

const props = defineProps({
  windowSubtitle: {
    type: String,
    default: "",
  },
  windowRows: {
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
  selectedTabIds: {
    type: Object,
    default: () => ({}),
  },
  aiTags: {
    type: Object,
    default: () => ({}),
  },
  hideDiscarded: {
    type: Boolean,
    default: false,
  },
  treeMode: {
    type: Boolean,
    default: false,
  },
  onToggleTreeMode: {
    type: Function,
    default: null,
  },
  onToggleCollapse: {
    type: Function,
    default: null,
  },
  onTreeDrop: {
    type: Function,
    default: null,
  },
  isTreeDescendant: {
    type: Function,
    default: null,
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
  onSelectAll: {
    type: Function,
    default: null,
  },
  onClear: {
    type: Function,
    default: null,
  },
  onCloseSelected: {
    type: Function,
    default: null,
  },
  onOpenMoveModal: {
    type: Function,
    default: null,
  },
  onDiscardSelected: {
    type: Function,
    default: null,
  },
  onOpenAi: {
    type: Function,
    default: null,
  },
  onOpenSave: {
    type: Function,
    default: null,
  },
  onToggleHideDiscarded: {
    type: Function,
    default: null,
  },
  onToggleSelection: {
    type: Function,
    default: null,
  },
  onToggleTab: {
    type: Function,
    default: null,
  },
  onActivate: {
    type: Function,
    default: null,
  },
  onClose: {
    type: Function,
    default: null,
  },
  onDiscard: {
    type: Function,
    default: null,
  },
  onSaveAiGroup: {
    type: Function,
    default: null,
  },
  onDropTab: {
    type: Function,
    default: null,
  },
});

const emptyText = computed(() =>
  props.filterQuery ? "未找到匹配的标签页。" : "未找到打开的标签页。"
);

const isJumpMode = computed(
  () => props.filterMode === "jump" && Boolean(props.committedFilterQuery)
);

/**
 * 匹配行高亮只在"列表里混有非匹配行"时才需要。
 *
 * 高亮的作用是把匹配项从非匹配项里区分出来：
 * - 树状 + 过滤：为了保住树的形状，祖先行也会被渲染，但它们是**非匹配项** → 必须高亮；
 * - 跳转模式（平铺/树状）：保留完整列表 → 必须高亮；
 * - 平铺 + 过滤：渲染出来的每一行都是匹配项，整表铺黄只是噪声 → 此时不高亮。
 */
const highlightMatches = computed(() => {
  if (!props.committedFilterQuery) {
    return false;
  }
  return props.windowRows.some(
    (row) => row.type === "tab" && row.tab && !row.tab.matched
  );
});

const {
  matchCount,
  currentMatchIndex,
  currentMatchPosition,
  goToNext,
  goToPrev,
} = useMatchNavigation({
  rows: computed(() => props.windowRows),
  isMatchRow: (item) =>
    Boolean(item && item.type === "tab" && item.tab && item.tab.matched),
  mode: computed(() => props.filterMode),
  hasQuery: computed(() => Boolean(props.committedFilterQuery)),
});

function handleToggleHideDiscarded(checked) {
  if (props.onToggleHideDiscarded) {
    props.onToggleHideDiscarded(checked);
  }
}

function handleToggleTreeMode(treeMode) {
  if (props.onToggleTreeMode) {
    props.onToggleTreeMode(treeMode);
  }
}
</script>
