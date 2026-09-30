<template>
  <div class="panel tabs-panel">
    <div v-if="rows.length === 0" class="virtual-empty">{{ emptyText }}</div>
    <VirtualList
      ref="listRef"
      v-else
      class="tabs"
      :items="rows"
      :item-height="itemHeight"
      :current-match-index="currentMatchIndex"
    >
      <template #default="{ item, index }">
        <div v-if="item.type === 'window'" class="window-title-row">
          {{ item.label }}<span v-if="item.count !== undefined">（{{ item.count }}）</span>
        </div>
        <div v-else-if="item.type === 'separator'" class="window-separator"></div>
        <div v-else-if="item.type === 'empty'" class="empty-row">
          {{ emptyRowText }}
        </div>
        <div
          v-else
          class="tab-row"
          :class="{
            draggable: enableDrag,
            tree: treeMode,
            dragging: draggingTabId === item.tab.id,
            'drag-target': !treeMode && dragOverTabId === item.tab.id,
            'drop-before': treeMode && dragOverTabId === item.tab.id && dropZone === 'before',
            'drop-after': treeMode && dragOverTabId === item.tab.id && dropZone === 'after',
            'drop-child': treeMode && dragOverTabId === item.tab.id && dropZone === 'child',
            matched: highlightMatches && Boolean(item.tab.matched),
            'match-current': index === currentMatchIndex,
          }"
          :draggable="enableDrag"
          @click="handleToggleSelection(item.tab.id, $event)"
          @dragstart="handleDragStart(item.tab, $event)"
          @dragover="handleDragOver(item.tab, $event)"
          @dragleave="handleDragLeave(item.tab)"
          @drop="handleDrop(item.tab, $event)"
          @dragend="handleDragEnd"
        >
          <template v-if="treeMode">
            <!-- 缩进层用重复渐变画出祖先层级线，行与行之间自然连成竖线 -->
            <span
              class="tree-indent"
              :style="{ width: `${(item.tab.depth || 0) * 14}px` }"
              aria-hidden="true"
            ></span>
            <button
              v-if="item.tab.hasChildren"
              class="tree-toggle"
              :class="{ collapsed: item.tab.collapsed }"
              :title="item.tab.collapsed ? '展开子树' : '折叠子树'"
              @click.stop="handleToggleCollapse(item.tab)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
            <span v-else class="tree-toggle placeholder" aria-hidden="true"></span>
          </template>
          <input
            type="checkbox"
            :checked="Boolean(selectedMap[item.tab.id])"
            @click.stop
            @change="handleToggleTab(item.tab.id, $event.target.checked)"
          />
          <img
            class="tab-icon"
            :class="{ hidden: !item.tab.favIconUrl }"
            :src="item.tab.favIconUrl || ''"
            @error="handleIconError($event)"
          />
          <div class="tab-body">
            <div class="tab-title">
              <span v-if="item.tab.active" class="active-dot" aria-hidden="true"></span>
              <span v-if="item.tab.pinned" class="pinned-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M8 4h8l-2 4v4l2 4H8l2-4V8z" />
                  <path d="M12 16v5" />
                </svg>
              </span>
              <span v-if="item.tab.discarded" class="discard-dot" aria-hidden="true"></span>
              <span class="tab-link" @click.stop="handleActivate(item.tab)">
                {{ item.tab.title || item.tab.url || "未命名" }}
              </span>
              <span
                v-if="item.tab.freezeCount && item.tab.freezeCount > 1"
                class="freeze-badge"
              >
                第{{ item.tab.freezeCount }}次冻结
              </span>
            </div>
            <div class="tab-url">
              <span class="tab-link" @click.stop="handleActivate(item.tab)">
                {{ item.tab.url || "" }}
              </span>
            </div>
          </div>
          <div class="tab-actions">
            <span
              v-if="showAiTags"
              class="tab-tag"
              :class="{ hidden: !aiTags[item.tab.id] }"
              @click.stop="handleSaveAi(item.tab, false)"
            >
              {{ aiTags[item.tab.id] || "" }}
            </span>
            <span
              v-if="showAiTags"
              class="tab-tag close"
              :class="{ hidden: !aiTags[item.tab.id] }"
              @click.stop="handleSaveAi(item.tab, true)"
            >
              保存并关闭
            </span>
            <button class="ghost tab-action danger btn-icon" @click.stop="handleClose(item.tab)">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
            <button class="ghost tab-action btn-icon" @click.stop="handleDiscard(item.tab)">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                </svg>
              </span>
              冻结
            </button>
          </div>
        </div>
      </template>
    </VirtualList>
    <div class="list-fab">
      <button class="ghost btn-icon fab-btn" @click="scrollToTop">
        <span class="icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 5l-6 6m6-6 6 6M12 5v14" />
          </svg>
        </span>
        顶部
      </button>
      <button class="ghost btn-icon fab-btn" @click="scrollToBottom">
        <span class="icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 19l6-6m-6 6-6-6M12 5v14" />
          </svg>
        </span>
        底部
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";
import VirtualList from "./VirtualList.vue";

const props = defineProps({
  rows: {
    type: Array,
    default: () => [],
  },
  itemHeight: {
    type: Number,
    default: 44,
  },
  selectedMap: {
    type: Object,
    default: () => ({}),
  },
  aiTags: {
    type: Object,
    default: () => ({}),
  },
  showAiTags: {
    type: Boolean,
    default: true,
  },
  enableDrag: {
    type: Boolean,
    default: false,
  },
  // 树状模式：行内显示缩进与折叠三角，拖拽改为表达"改变父子关系"。
  treeMode: {
    type: Boolean,
    default: false,
  },
  highlightMatches: {
    type: Boolean,
    default: false,
  },
  currentMatchIndex: {
    type: Number,
    default: -1,
  },
  emptyText: {
    type: String,
    default: "暂无数据。",
  },
  emptyRowText: {
    type: String,
    default: "暂无标签页。",
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
  onToggleCollapse: {
    type: Function,
    default: null,
  },
  onTreeDrop: {
    type: Function,
    default: null,
  },
  // 判断 candidateId 是否位于 ancestorId 的子树内：用于禁止把标签拖到自己的子孙上。
  isTreeDescendant: {
    type: Function,
    default: null,
  },
});

const dragOverTabId = ref(null);
const draggingTabId = ref(null);
const draggingTabPinned = ref(false);
const dragInProgress = ref(false);
// 树状模式下的落点分区：before（成为前一个兄弟）/ after（后一个兄弟）/ child（成为子标签）。
const dropZone = ref(null);
const listRef = ref(null);

function handleToggleSelection(tabId) {
  if (dragInProgress.value) {
    return;
  }
  if (props.onToggleSelection) {
    props.onToggleSelection(tabId);
  }
}

function handleToggleTab(tabId, checked) {
  if (props.onToggleTab) {
    props.onToggleTab(tabId, checked);
  }
}

function handleActivate(tab) {
  if (props.onActivate) {
    props.onActivate(tab);
  }
}

function handleClose(tab) {
  if (props.onClose) {
    props.onClose(tab);
  }
}

function handleDiscard(tab) {
  if (props.onDiscard) {
    props.onDiscard(tab);
  }
}

function handleSaveAi(tab, closeTab) {
  if (props.onSaveAiGroup) {
    props.onSaveAiGroup(tab, closeTab);
  }
}

function handleToggleCollapse(tab) {
  if (props.onToggleCollapse) {
    props.onToggleCollapse(tab);
  }
}

function isInteractiveTarget(target) {
  if (!target) {
    return false;
  }
  return Boolean(
    target.closest("button") ||
      target.closest("input") ||
      target.closest(".tab-link") ||
      target.closest(".tab-tag")
  );
}

function handleDragStart(tab, event) {
  if (!props.enableDrag) {
    return;
  }
  if (isInteractiveTarget(event.target)) {
    event.preventDefault();
    return;
  }
  draggingTabId.value = tab.id;
  draggingTabPinned.value = Boolean(tab.pinned);
  dragInProgress.value = true;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(tab.id));
  }
}

/**
 * 树状模式的落点判定，规则与 TST 一致：
 * 行上 1/4 → 插到该行之前（同级兄弟）；行下 1/4 → 插到该行之后（同级兄弟）；
 * 中间 1/2 → 成为该行的子标签。
 */
function computeDropZone(event) {
  const element = event.currentTarget;
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return "child";
  }
  const rect = element.getBoundingClientRect();
  if (!rect.height) {
    return "child";
  }
  const ratio = (event.clientY - rect.top) / rect.height;
  if (ratio < 0.25) {
    return "before";
  }
  if (ratio > 0.75) {
    return "after";
  }
  return "child";
}

/** 判断一个树状落点是否合法（固定标签不参与父子；不能拖到自己的子孙上）。 */
function isTreeDropAllowed(targetTab) {
  if (draggingTabPinned.value || Boolean(targetTab.pinned)) {
    return false;
  }
  if (
    props.isTreeDescendant &&
    draggingTabId.value &&
    props.isTreeDescendant(draggingTabId.value, targetTab.id, targetTab.windowId)
  ) {
    return false;
  }
  return true;
}

function handleDragOver(tab, event) {
  if (!props.enableDrag) {
    return;
  }
  if (props.treeMode && !isTreeDropAllowed(tab)) {
    dragOverTabId.value = null;
    dropZone.value = null;
    return;
  }
  event.preventDefault();
  dragOverTabId.value = tab.id;
  if (props.treeMode) {
    dropZone.value = computeDropZone(event);
  }
}

function handleDragLeave(tab) {
  if (!props.enableDrag) {
    return;
  }
  if (dragOverTabId.value === tab.id) {
    dragOverTabId.value = null;
    dropZone.value = null;
  }
}

/** 从行数据里解析出"实际要移动的标签集合"：拖拽的是已选标签时整体移动，否则只移动被拖的那个。 */
function resolveDraggedTabs(event, draggedId) {
  const orderedTabs = props.rows
    .filter((row) => row.type === "tab" && row.tab && row.tab.id)
    .map((row) => row.tab);
  const draggedTab = orderedTabs.find((rowTab) => String(rowTab.id) === draggedId);
  if (!draggedTab) {
    return [];
  }
  const selectedTabs = orderedTabs.filter((rowTab) =>
    Boolean(props.selectedMap[String(rowTab.id)])
  );
  const isDraggedSelected = selectedTabs.some(
    (rowTab) => String(rowTab.id) === draggedId
  );
  return isDraggedSelected ? selectedTabs : [draggedTab];
}

function handleDrop(tab, event) {
  if (!props.enableDrag) {
    return;
  }
  event.preventDefault();
  const zone = props.treeMode ? dropZone.value || "child" : null;
  dragOverTabId.value = null;
  dropZone.value = null;
  if (props.treeMode && !isTreeDropAllowed(tab)) {
    return;
  }
  const draggedId = draggingTabId.value
    ? String(draggingTabId.value)
    : event.dataTransfer
      ? String(event.dataTransfer.getData("text/plain") || "")
      : "";
  if (props.treeMode) {
    if (!props.onTreeDrop) {
      return;
    }
    // 树状模式下每次只改变一个标签的父级（其子树由后台整体移动），
    // 因此拖拽多选时也只取被拖的那一个，避免语义不清。
    const draggedTab = props.rows
      .filter((row) => row.type === "tab" && row.tab && row.tab.id)
      .map((row) => row.tab)
      .find((rowTab) => String(rowTab.id) === draggedId);
    if (!draggedTab) {
      return;
    }
    props.onTreeDrop(draggedTab, tab, zone);
    return;
  }
  if (props.onDropTab) {
    if (!draggedId) {
      props.onDropTab(tab, []);
      return;
    }
    const selection = resolveDraggedTabs(event, draggedId);
    if (selection.length === 0) {
      props.onDropTab(tab, []);
      return;
    }
    props.onDropTab(tab, selection);
  }
}

function handleDragEnd() {
  draggingTabId.value = null;
  draggingTabPinned.value = false;
  dragOverTabId.value = null;
  dropZone.value = null;
  setTimeout(() => {
    dragInProgress.value = false;
  }, 0);
}

function scrollToTop() {
  if (listRef.value && listRef.value.scrollToTop) {
    listRef.value.scrollToTop();
  }
}

function scrollToBottom() {
  if (listRef.value && listRef.value.scrollToBottom) {
    listRef.value.scrollToBottom();
  }
}

function handleIconError(event) {
  event.target.classList.add("hidden");
}
</script>
