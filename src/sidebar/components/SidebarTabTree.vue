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
import { buildTrackMarkers } from "../../manager/utils/scroll_markers.js";
import TabFavicon from "../../manager/components/TabFavicon.vue";
// 外部拖放（链接/文本）判定：内部标签拖拽也会写 text/plain（写的是标签 id），
// 所以这里必须再叠加"当前没有内部拖拽进行中"，两者缺一不可。
import { isExternalDropData } from "../dropped_data.js";

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
  // 多选模式：开启后点击行不再激活标签，而是切换选中（见 SidebarApp 的「多选模式」）。
  multiSelect: {
    type: Boolean,
    default: false,
  },
  // 选中集合（键为标签 id 的字符串形式）；只在多选模式下参与样式与交互。
  selectedMap: {
    type: Object,
    default: () => ({}),
  },
});

const emit = defineEmits([
  "activate",
  // 多选模式下的选择动作：带 shiftKey，由父级按"锚点 + 区间"规则统一处理
  "select",
  "close",
  "discard",
  "toggle-collapse",
  "tree-drop",
  "context-menu",
  // 外部内容（链接/文本）落在某一行上：父级负责解析数据并发起后台请求
  "external-drop",
  // 刻度被点击：父级负责"同步当前跳转项 + 滚动"，避免这里和父级各滚一次
  "marker-click",
  // 可见行区间变化：父级据此让当前跳转项跟随可见范围
  "visible-range",
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
// 这次拖拽是不是"外部内容"（链接/文本）：行中间区在两种拖拽下语义不同
// （内部 = 成为子标签，外部 = 覆盖该标签），因此要高亮成不同样式。
const externalDrag = ref(false);

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

/**
 * 行点击：
 * - 普通模式 = 激活该标签（原有行为）；
 * - 多选模式 = 切换选中，并把 shiftKey 一并上报，由父级按"锚点 + 区间"规则处理
 *   （区间必须按父级持有的完整行顺序算，组件里只有单个 item，算不了）。
 */
function onRowClick(item, event) {
  if (props.multiSelect) {
    emit("select", { id: item.id, tab: item.tab, shiftKey: Boolean(event && event.shiftKey) });
    return;
  }
  emit("activate", item.tab);
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

/** 刻度悬停提示：合并过的刻度要说明它代表多少个，否则看起来和单个刻度没区别。 */
function markerTitle(marker) {
  const isMatch = marker.kind === "match" || marker.kind === "match-current";
  if (marker.merged) {
    return isMatch ? `跳转到这 ${marker.count} 个匹配项` : `跳转到这一带的 ${marker.count} 个刻度`;
  }
  return isMatch ? "跳转到该匹配项" : "跳转到当前标签页";
}

/** 点击轨道刻度：只上报，由父级统一处理"同步当前项 + 滚动"。 */
function onMarkerClick(marker) {
  emit("marker-click", { index: marker.index, kind: marker.kind, matchIndex: marker.matchIndex });
}

function onRangeChange(range) {
  emit("visible-range", range);
}

// 侧边栏关闭列表的自动滚动：当前项由滚动同步改写时不能再触发滚动。
// 需要滚动时由父级通过这里的 scrollToIndex 显式调用。
defineExpose({
  scrollToIndex(index) {
    if (listRef.value && listRef.value.scrollToIndex) {
      listRef.value.scrollToIndex(index);
    }
  },
  // 透传列表的真实滚动几何：父级据此判断"活动标签是否（完整）在视野里"。
  // 不能用 range-change 上报的渲染区间代替——那里面含 overscan，口径比真正的视口宽。
  getScrollState() {
    if (listRef.value && typeof listRef.value.getScrollState === "function") {
      return listRef.value.getScrollState();
    }
    return null;
  },
});

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

/** 本次拖拽是否是"外部内容"（链接 / 文本），而不是本插件内部的标签拖拽。 */
function isExternalDrag(event) {
  if (draggingId.value !== null || draggingPinned.value) {
    return false;
  }
  return isExternalDropData(event.dataTransfer);
}

function clearDropState() {
  dropTargetId.value = null;
  dropZone.value = null;
  externalDrag.value = false;
}

function onDragOver(item, event) {
  if (isExternalDrag(event)) {
    // 外部拖放允许落在任何非固定标签行上（树区域本来就没有固定标签）。
    event.preventDefault();
    externalDrag.value = true;
    dropTargetId.value = item.id;
    dropZone.value = getTreeDropZone(event);
    return;
  }
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
    // 统一走 clearDropState：只清 dropTarget/dropZone 而留着 externalDrag，
    // 会让下一次内部拖拽错误地显示成"覆盖"高亮。
    clearDropState();
  }
}

function onDrop(item, event) {
  if (isExternalDrag(event)) {
    event.preventDefault();
    const zone = dropZone.value || "child";
    clearDropState();
    // 由父级解析 dataTransfer 并发起后台请求：解析必须在 drop 的同步栈里完成，
    // Vue 的 emit 是同步调用，因此把 dataTransfer 直接传出去即可。
    emit("external-drop", {
      tab: item.tab,
      zone,
      dataTransfer: event.dataTransfer,
    });
    return;
  }
  event.preventDefault();
  const zone = dropZone.value || "child";
  clearDropState();
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
  clearDropState();
}

/**
 * 拖拽离开整个树区域时清掉落点。
 * 只在 relatedTarget 确实出了 host 时才清：行与行之间移动同样会触发 dragleave，
 * 清早了会让插入指示闪烁。
 */
function onHostDragLeave(event) {
  const next = event.relatedTarget;
  if (next && wrapperRef.value && typeof wrapperRef.value.contains === "function" && wrapperRef.value.contains(next)) {
    return;
  }
  clearDropState();
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
  <div ref="wrapperRef" class="track-host" @dragleave="onHostDragLeave">
    <VirtualList
      ref="listRef"
      class="sb-list"
      :items="items"
      :item-height="itemHeight"
      :current-match-index="currentMatchIndex"
      :auto-scroll-to-match="false"
      @range-change="onRangeChange"
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
          selected: Boolean(props.selectedMap[item.id]),
          'drop-before': dropTargetId === item.id && dropZone === 'before',
          'drop-after': dropTargetId === item.id && dropZone === 'after',
          'drop-child': dropTargetId === item.id && dropZone === 'child' && !externalDrag,
          'drop-onto': dropTargetId === item.id && dropZone === 'child' && externalDrag,
        }"
        draggable="true"
        @click="onRowClick(item, $event)"
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
    <div v-if="markers.length > 0" class="track-marks on-left">
      <button
        v-for="marker in markers"
        :key="marker.key"
        type="button"
        class="track-mark"
        :class="marker.kind"
        :style="{ top: `${marker.top}px` }"
        :title="markerTitle(marker)"
        @click.stop="onMarkerClick(marker)"
      ></button>
    </div>
  </div>
</template>
