<template>
  <div class="panel tabs-panel">
    <div v-if="rows.length === 0" class="virtual-empty">{{ emptyText }}</div>
    <div v-else ref="wrapperRef" class="track-host">
      <VirtualList
        ref="listRef"
        class="tabs"
        :items="rows"
        :item-height="itemHeight"
        :current-match-index="currentMatchIndex"
        :auto-scroll-to-match="autoScrollToMatch"
        :scroll-key="scrollKey"
        @range-change="emit('visible-range', $event)"
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
            'active-ancestor': activeAncestorIndexes.has(index),
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
          <TabFavicon class="tab-icon" :url="item.tab.favIconUrl" />
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

      <!-- 标记层放在滚动容器外面，否则会跟着内容一起滚走；管理页滚动条在右侧 -->
      <div v-if="markers.length > 0" class="track-marks on-right">
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import VirtualList from "./VirtualList.vue";
import TabFavicon from "./TabFavicon.vue";
import { getTreeDropZone } from "../utils/helpers.js";
import { buildTrackMarkers } from "../utils/scroll_markers.js";

const emit = defineEmits(["marker-click", "visible-range"]);

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
  // 滚动条轨道上的蓝色刻度：管理页是多窗口视图，因此每个窗口各一条。
  // 由调用方用 resolveActiveRows 算好（含"活动标签被折叠/筛选隐藏时标到最近的可见祖先"）。
  activeRows: {
    type: Array,
    default: () => [],
  },
  // 见 VirtualList.autoScrollToMatch：侧边栏与标签页视图会在滚动时同步当前项，
  // 那种同步不能再触发滚动，因此它们传 false 并改为显式滚动。
  autoScrollToMatch: {
    type: Boolean,
    default: true,
  },
  // 滚动位置记忆的作用域键（透传给 VirtualList）：管理页切窗口时按窗口分别记住滚动位置。
  scrollKey: {
    type: String,
    default: "",
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
const wrapperRef = ref(null);
// 轨道高度 = 滚动容器自身高度：刻度按"行序号 / 总行数"的比例落在它上面。
const trackHeight = ref(0);
let trackResizeObserver = null;

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
 * 树状模式的落点判定交给共用工具（管理页与 Firefox 侧边栏口径一致），
 * 规则为：行上 1/4 → 前一个兄弟；行下 1/4 → 后一个兄弟；中间 1/2 → 子标签。
 */
function computeDropZone(event) {
  return getTreeDropZone(event);
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

// ---------------------------------------------------------------------------
// 滚动条轨道标记
// ---------------------------------------------------------------------------

/** 刻度只认标签行；窗口标题行、分隔行、空行都不参与。 */
const trackRows = computed(() =>
  props.rows.map((row) => ({
    id: row.type === "tab" ? row.tab.id : `${row.type}-${row.label || row.text || ""}`,
    matched: row.type === "tab" && Boolean(row.tab.matched),
  }))
);

/** 行号 → 该行是否为"活动标签被隐藏时所用祖先行"，用于给这一行加蓝边。 */
const activeAncestorIndexes = computed(() => {
  const result = new Set();
  for (const row of props.activeRows) {
    if (row && row.isAncestor && Number.isFinite(row.index)) {
      result.add(row.index);
    }
  }
  return result;
});

const markers = computed(() =>
  buildTrackMarkers({
    rows: trackRows.value,
    activeRows: props.activeRows,
    highlightMatches: props.highlightMatches,
    currentMatchIndex: props.currentMatchIndex,
    trackHeight: trackHeight.value,
  })
);

/** 合并过的刻度要说明它代表多少个，否则看起来和单个刻度没有区别。 */
function markerTitle(marker) {
  const isMatch = marker.kind === "match" || marker.kind === "match-current";
  if (marker.merged) {
    return isMatch ? `跳转到这 ${marker.count} 个匹配项` : `跳转到这一带的 ${marker.count} 个刻度`;
  }
  return isMatch ? "跳转到该匹配项" : "跳转到当前活动标签";
}

function onMarkerClick(marker) {
  emit("marker-click", { index: marker.index, kind: marker.kind, matchIndex: marker.matchIndex });
}

function updateTrackHeight() {
  trackHeight.value = wrapperRef.value ? wrapperRef.value.clientHeight || 0 : 0;
}

/** 把观察器挂到当前存在的滚动容器上（不存在就只清空，等它出现时再挂）。 */
function attachTrackObserver() {
  if (!trackResizeObserver) {
    return;
  }
  trackResizeObserver.disconnect();
  updateTrackHeight();
  if (wrapperRef.value) {
    trackResizeObserver.observe(wrapperRef.value);
  }
}

onMounted(() => {
  // 面板尺寸随窗口与布局变化，轨道高度必须重新测量，否则刻度位置会偏。
  trackResizeObserver = new ResizeObserver(updateTrackHeight);
  attachTrackObserver();
});

/*
  必须监听 wrapperRef 本身，而不能只在 onMounted 里挂一次：
  本组件是常驻的，数据到达前渲染的是"空状态"分支（没有 .track-host），
  那时 wrapperRef 还是 null、观察器无处可挂；等数据到达滚动容器才出现，
  此时如果不重新挂，trackHeight 会一直是 0——所有刻度的比例位置都算成 0，
  表现为全部叠在轨道顶端并被合并成一条。
*/
watch(wrapperRef, () => {
  attachTrackObserver();
});

onBeforeUnmount(() => {
  if (trackResizeObserver) {
    trackResizeObserver.disconnect();
    trackResizeObserver = null;
  }
});

defineExpose({
  // 关闭了自动滚动的调用方（标签页视图与侧边栏）需要显式滚动时用它。
  scrollToIndex(index) {
    if (listRef.value && listRef.value.scrollToIndex) {
      listRef.value.scrollToIndex(index);
    }
  },
});

</script>
