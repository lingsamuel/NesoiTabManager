<script setup>
// 侧边栏的紧凑标签树。
//
// 与页面管理页的表格化行不同，这里每个标签只占 30px：缩进用祖先层级线表达，
// 冻结/关闭按钮只在悬停时出现，把横向空间尽量让给标题。
// 拖拽落点规则沿用与管理页完全一致的三分区（上 1/4 兄弟 / 下 1/4 兄弟 / 中间子标签），
// 分区判定本身也复用同一个工具函数。

import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import VirtualList from "../../manager/components/VirtualList.vue";
import { getTreeDropZone } from "../../manager/utils/helpers.js";
import { buildTrackMarkers } from "../scroll_markers.js";
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
  // 活动标签在行序列里的位置（可能指向它最近的可见祖先，见 scroll_markers.js）
  activeRow: {
    type: Object,
    default: null,
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
const wrapperRef = ref(null);
// 轨道高度 = 滚动容器自身高度：刻度按"行序号 / 总行数"的比例落在它上面。
const trackHeight = ref(0);
let trackResizeObserver = null;
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

const markers = computed(() =>
  buildTrackMarkers({
    rows: props.items,
    activeRow: props.activeRow,
    highlightMatches: props.highlightMatches,
    currentMatchIndex: props.currentMatchIndex,
    trackHeight: trackHeight.value,
  })
);

/** 点击轨道刻度 → 把对应行滚动到可视区并居中（与原生查找的刻度一致）。 */
function onMarkerClick(marker) {
  if (!listRef.value || !listRef.value.scrollToIndex) {
    return;
  }
  listRef.value.scrollToIndex(marker.index);
}

function updateTrackHeight() {
  trackHeight.value = wrapperRef.value ? wrapperRef.value.clientHeight || 0 : 0;
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

onMounted(() => {
  updateTrackHeight();
  // 侧边栏宽度/高度都会随窗口变化，轨道高度必须跟着重新测量，否则刻度位置会偏。
  trackResizeObserver = new ResizeObserver(updateTrackHeight);
  if (wrapperRef.value) {
    trackResizeObserver.observe(wrapperRef.value);
  }
});

onBeforeUnmount(() => {
  if (trackResizeObserver) {
    trackResizeObserver.disconnect();
    trackResizeObserver = null;
  }
});
</script>

<template>
  <div ref="wrapperRef" class="sb-tree-wrap">
    <VirtualList
      ref="listRef"
      class="sb-list"
      :items="items"
      :item-height="itemHeight"
      :current-match-index="currentMatchIndex"
    >
    <template #default="{ item, index }">
      <div
        class="sb-row"
        :class="{
          current: item.tab.active,
          discarded: item.tab.discarded,
          pinned: item.tab.pinned,
          matched: highlightMatches && item.matched,
          'active-ancestor': Boolean(activeRow && activeRow.isAncestor && activeRow.index === index),
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

    <!--
      轨道标记层放在滚动容器**外面**：放进容器里会跟着内容一起滚走。
      作为容器的兄弟节点用绝对定位，因此始终停在视口对应位置。
    -->
    <div v-if="markers.length > 0" class="sb-marks">
      <button
        v-for="marker in markers"
        :key="marker.key"
        type="button"
        class="sb-mark"
        :class="marker.kind"
        :style="{ top: `${marker.top}px` }"
        :title="marker.kind === 'match' || marker.kind === 'match-current' ? '跳转到该匹配项' : '跳转到当前标签页'"
        @click.stop="onMarkerClick(marker)"
      ></button>
    </div>
  </div>
</template>
