<script setup>
// 侧边栏的紧凑标签树。
//
// 与页面管理页的表格化行不同，这里每个标签只占 30px：缩进用祖先层级线表达，
// 冻结/关闭按钮只在悬停时出现，把横向空间尽量让给标题。
// 拖拽落点规则沿用与管理页完全一致的三分区（上 1/4 兄弟 / 下 1/4 兄弟 / 中间子标签），
// 分区判定本身也复用同一个工具函数。

import { ref } from "vue";
import VirtualList from "../../manager/components/VirtualList.vue";
import { getTreeDropZone } from "../../manager/utils/helpers.js";
import TabFavicon from "../../manager/components/TabFavicon.vue";

const props = defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  itemHeight: {
    type: Number,
    default: 30,
  },
  // 每层缩进像素；超过 indentLimit 层后不再增加，避免深层链把标题挤没。
  indentWidth: {
    type: Number,
    default: 12,
  },
  indentLimit: {
    type: Number,
    default: 16,
  },
  highlightMatches: {
    type: Boolean,
    default: false,
  },
  currentMatchIndex: {
    type: Number,
    default: -1,
  },
  // 判断 candidateId 是否位于 ancestorId 的子树内：禁止把标签拖到自己的子孙上。
  isTreeDescendant: {
    type: Function,
    default: null,
  },
});

const emit = defineEmits([
  "activate",
  "close",
  "discard",
  "toggle-collapse",
  "tree-drop",
  "context-menu",
]);

const listRef = ref(null);
const draggingId = ref(null);
const draggingPinned = ref(false);
const dropTargetId = ref(null);
const dropZone = ref(null);

function indentStyle(depth) {
  const level = Math.min(Number(depth) || 0, props.indentLimit);
  return { width: `${level * props.indentWidth}px` };
}

function onAuxClick(tab, event) {
  // 中键关闭，与浏览器原生标签栏一致。
  if (event.button === 1) {
    event.preventDefault();
    emit("close", tab);
  }
}

function onMouseDown(event) {
  // 不清掉这一下，Firefox 会在中键按下时启动自动滚动。
  if (event.button === 1) {
    event.preventDefault();
  }
}

function onContextMenu(tab, event) {
  emit("context-menu", tab, event);
}

function onDragStart(item, event) {
  draggingId.value = item.id;
  draggingPinned.value = Boolean(item.tab && item.tab.pinned);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(item.id));
  }
}

/** 固定标签不参与父子；不能拖到自己的子孙上。 */
function isDropAllowed(targetItem) {
  if (draggingPinned.value || Boolean(targetItem.tab && targetItem.tab.pinned)) {
    return false;
  }
  if (
    props.isTreeDescendant &&
    draggingId.value !== null &&
    props.isTreeDescendant(draggingId.value, targetItem.id)
  ) {
    return false;
  }
  return true;
}

function onDragOver(item, event) {
  if (!isDropAllowed(item)) {
    dropTargetId.value = null;
    dropZone.value = null;
    return;
  }
  event.preventDefault();
  dropTargetId.value = item.id;
  dropZone.value = getTreeDropZone(event);
}

function onDragLeave(item) {
  if (dropTargetId.value === item.id) {
    dropTargetId.value = null;
    dropZone.value = null;
  }
}

function onDrop(item, event) {
  event.preventDefault();
  const zone = dropZone.value || "child";
  dropTargetId.value = null;
  dropZone.value = null;
  if (!isDropAllowed(item) || draggingId.value === null) {
    return;
  }
  const dragged = props.items.find((entry) => entry.id === draggingId.value);
  if (!dragged) {
    return;
  }
  // 树状模式下每次只改变一个标签的父级（其子树由后台整体移动），不做多选拖拽。
  emit("tree-drop", dragged.tab, item.tab, zone);
}

function onDragEnd() {
  draggingId.value = null;
  draggingPinned.value = false;
  dropTargetId.value = null;
  dropZone.value = null;
}

defineExpose({
  scrollToIndex(index) {
    if (listRef.value && listRef.value.scrollToIndex) {
      listRef.value.scrollToIndex(index);
    }
  },
  // 底部 New Tab 会把新标签放在窗口末尾，创建后需要滚到底部让用户看得到。
  scrollToBottom() {
    if (listRef.value && listRef.value.scrollToBottom) {
      listRef.value.scrollToBottom();
    }
  },
});
</script>

<template>
  <VirtualList
    ref="listRef"
    class="sb-list"
    :items="items"
    :item-height="itemHeight"
    :current-match-index="currentMatchIndex"
  >
    <template #default="{ item }">
      <div
        class="sb-row"
        :class="{
          current: item.tab.active,
          discarded: item.tab.discarded,
          pinned: item.tab.pinned,
          matched: highlightMatches && item.matched,
          dragging: draggingId === item.id,
          'drop-before': dropTargetId === item.id && dropZone === 'before',
          'drop-after': dropTargetId === item.id && dropZone === 'after',
          'drop-child': dropTargetId === item.id && dropZone === 'child',
        }"
        draggable="true"
        @click="emit('activate', item.tab)"
        @auxclick="onAuxClick(item.tab, $event)"
        @mousedown="onMouseDown"
        @contextmenu="onContextMenu(item.tab, $event)"
        @dragstart="onDragStart(item, $event)"
        @dragover="onDragOver(item, $event)"
        @dragleave="onDragLeave(item)"
        @drop="onDrop(item, $event)"
        @dragend="onDragEnd"
      >
        <!-- 缩进层用重复渐变画出每层一条的竖线，与管理页树状视图观感一致 -->
        <span class="sb-indent" :style="indentStyle(item.depth)" aria-hidden="true"></span>
        <button
          v-if="item.hasChildren"
          type="button"
          class="sb-twisty"
          :class="{ collapsed: item.collapsed }"
          :title="item.collapsed ? '展开子树' : '折叠子树'"
          @click.stop="emit('toggle-collapse', item)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
        <span v-else class="sb-twisty placeholder" aria-hidden="true"></span>
        <TabFavicon class="sb-favicon" :url="item.tab.favIconUrl" />
        <span class="sb-title" :title="item.tab.title || item.tab.url || ''">
          {{ item.tab.title || item.tab.url || "未命名" }}
        </span>
        <span class="sb-actions">
          <button
            type="button"
            class="sb-action"
            title="冻结此标签"
            @click.stop="emit('discard', item.tab)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
            </svg>
          </button>
          <button
            type="button"
            class="sb-action danger"
            title="关闭此标签"
            @click.stop="emit('close', item.tab)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </span>
      </div>
    </template>
  </VirtualList>
</template>
