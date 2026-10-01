<script setup>
// 固定标签区：跨窗口聚合所有固定标签，按窗口分组，只显示图标。
//
// 视觉对齐 Tree Style Tab 的 pinned 容器：图标是**横向铺开的小方块**（不是整行横条），
// 容器自身有底色、当前窗口的活动标签是白底小方块。
//
// 关键行为：
// - 不参与滚动：独立容器（高度上限由 CSS 控制），不会随下方树区域滚走；
// - 只允许同窗口内的顺序重排：跨窗口拖拽等价于"把标签移动到另一个窗口"，
//   与"重排顺序但不影响窗口"的诉求相悖，因此直接不响应（连落点指示都不显示）；
// - 中键关闭，同时拦截中键 mousedown，避免 Firefox 触发中键自动滚动；
// - **刻意不做 hover 关闭按钮**：方块只有 28px，关闭按钮一旦出现就会盖住唯一的点击区域，
//   导致用户想切换标签却只能关闭。关闭改由中键或右键菜单承担。

import { ref } from "vue";
import { pinnedTabTooltip } from "../pinned_data.js";
import { isExternalDropData, resolvePinnedDropPosition } from "../dropped_data.js";
import TabFavicon from "../../manager/components/TabFavicon.vue";

const props = defineProps({
  // groupPinnedTabs() 的结果
  groups: {
    type: Array,
    default: () => [],
  },
  // 多选模式：开启后点击固定标签方块不再激活标签，而是切换选中（见 SidebarApp 的「多选模式」）。
  multiSelect: {
    type: Boolean,
    default: false,
  },
  // 选中集合（键为标签 id 的字符串形式）；与树区域共用同一份。
  selectedMap: {
    type: Object,
    default: () => ({}),
  },
});

const emit = defineEmits(["activate", "select", "close", "context-menu", "reorder", "external-drop"]);

const draggingId = ref(null);
const draggingWindowId = ref(null);
const dropTargetId = ref(null);
const dropPosition = ref(null);
// 外部拖放（链接/文本）的落点：与内部重排分开记录，因为分区规则不同。
const externalPosition = ref(null);

function tooltipFor(tab, group) {
  return pinnedTabTooltip(tab, group);
}

function onAuxClick(tab, event) {
  // 中键关闭，与浏览器原生标签栏一致。
  if (event.button === 1) {
    event.preventDefault();
    emit("close", tab);
  }
}

/**
 * 方块点击：普通模式 = 激活该标签；多选模式 = 切换选中（shiftKey 上报给父级算区间）。
 * 固定标签区是跨窗口聚合的独立序列，区间只能在同一区域内计算，因此这里只上报"被点项"。
 */
function onPinClick(tab, event) {
  if (props.multiSelect) {
    emit("select", { id: Number(tab.id), tab, shiftKey: Boolean(event && event.shiftKey) });
    return;
  }
  emit("activate", tab);
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

function onDragStart(tab, group, event) {
  draggingId.value = Number(tab.id);
  draggingWindowId.value = group.windowId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(tab.id));
  }
}

/** 只允许同窗口、且不是拖到自己身上的落点。 */
function canDrop(tab, group) {
  if (draggingId.value === null) {
    return false;
  }
  if (group.windowId !== draggingWindowId.value) {
    return false;
  }
  return Number(tab.id) !== draggingId.value;
}

/** 图标是横向铺开的，因此按左右半区决定插到前面还是后面。 */
function positionFromEvent(event) {
  const element = event.currentTarget;
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return "after";
  }
  const rect = element.getBoundingClientRect();
  if (!rect.width) {
    return "after";
  }
  return event.clientX - rect.left < rect.width / 2 ? "before" : "after";
}

/**
 * 本次拖拽是否是"外部内容"（链接 / 文本）。
 * 内部重排的 draggingId 有值，且内部拖拽也写 text/plain，因此两个条件缺一不可。
 */
function isExternalDrag(event) {
  if (draggingId.value !== null) {
    return false;
  }
  return isExternalDropData(event.dataTransfer);
}

function clearDropState() {
  dropTargetId.value = null;
  dropPosition.value = null;
  externalPosition.value = null;
}

function onDragOver(tab, group, event) {
  if (isExternalDrag(event)) {
    // 外部拖放的分区与内部重排不同：两侧 1/4 是插入、中间 1/2 是覆盖。
    event.preventDefault();
    dropTargetId.value = Number(tab.id);
    externalPosition.value = resolvePinnedDropPosition(
      event.clientX,
      event.currentTarget && typeof event.currentTarget.getBoundingClientRect === "function"
        ? event.currentTarget.getBoundingClientRect()
        : null
    );
    return;
  }
  if (!canDrop(tab, group)) {
    dropTargetId.value = null;
    dropPosition.value = null;
    return;
  }
  event.preventDefault();
  dropTargetId.value = Number(tab.id);
  dropPosition.value = positionFromEvent(event);
}

function onDragLeave(tab) {
  if (dropTargetId.value === Number(tab.id)) {
    clearDropState();
  }
}

function onDrop(tab, group, event) {
  if (isExternalDrag(event)) {
    event.preventDefault();
    const position = externalPosition.value || "overwrite";
    clearDropState();
    emit("external-drop", {
      tab,
      group,
      position,
      dataTransfer: event.dataTransfer,
    });
    return;
  }
  event.preventDefault();
  const position = dropPosition.value || "after";
  const allowed = canDrop(tab, group);
  const draggedId = draggingId.value;
  clearDropState();
  if (!allowed || draggedId === null) {
    return;
  }
  emit("reorder", {
    draggedId,
    targetId: Number(tab.id),
    position,
    windowId: group.windowId,
  });
}

function onDragEnd() {
  draggingId.value = null;
  draggingWindowId.value = null;
  clearDropState();
}

/** 拖出整个固定标签区时清掉落点，避免离开后还留着插入线。 */
function onContainerDragLeave(event) {
  const next = event.relatedTarget;
  const container = event.currentTarget;
  if (next && container && typeof container.contains === "function" && container.contains(next)) {
    return;
  }
  clearDropState();
}
</script>

<template>
  <div v-if="groups.length > 0" class="sb-pinned" @dragleave="onContainerDragLeave">
    <!-- 内层容器负责横向排列：外层为了把滚动条放到左侧用了 direction: rtl，
         若不留这一层，图标的排列与换行顺序也会跟着反过来。 -->
    <div class="sb-pinned-inner">
      <template v-for="(group, groupIndex) in groups" :key="group.windowId">
      <!-- 图标横向铺开，因此组间用竖线而不是横线 -->
      <div v-if="groupIndex > 0" class="sb-pinned-sep" aria-hidden="true"></div>
      <div
        v-for="tab in group.tabs"
        :key="tab.id"
        class="sb-pin"
        :class="{
          current: Boolean(tab.active) && group.isCurrent,
          'active-other': Boolean(tab.active) && !group.isCurrent,
          discarded: Boolean(tab.discarded),
          dragging: draggingId === tab.id,
          selected: Boolean(props.selectedMap[tab.id]),
          'drop-before': dropTargetId === tab.id && (dropPosition === 'before' || externalPosition === 'before'),
          'drop-after': dropTargetId === tab.id && (dropPosition === 'after' || externalPosition === 'after'),
          'drop-onto': dropTargetId === tab.id && externalPosition === 'overwrite',
        }"
        draggable="true"
        :title="tooltipFor(tab, group)"
        @click="onPinClick(tab, $event)"
        @auxclick="onAuxClick(tab, $event)"
        @mousedown="onMouseDown"
        @contextmenu="onContextMenu(tab, $event)"
        @dragstart="onDragStart(tab, group, $event)"
        @dragover="onDragOver(tab, group, $event)"
        @dragleave="onDragLeave(tab)"
        @drop="onDrop(tab, group, $event)"
        @dragend="onDragEnd"
      >
        <TabFavicon class="sb-pin-icon" :url="tab.favIconUrl" />
        <span v-if="tab.muted" class="sb-pin-muted" title="已静音" aria-hidden="true"></span>
      </div>
      </template>
    </div>
  </div>
</template>
