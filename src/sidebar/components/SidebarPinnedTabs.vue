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
import TabFavicon from "../../manager/components/TabFavicon.vue";

const props = defineProps({
  // groupPinnedTabs() 的结果
  groups: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits(["activate", "close", "context-menu", "reorder"]);

const draggingId = ref(null);
const draggingWindowId = ref(null);
const dropTargetId = ref(null);
const dropPosition = ref(null);

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

function onDragOver(tab, group, event) {
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
    dropTargetId.value = null;
    dropPosition.value = null;
  }
}

function onDrop(tab, group, event) {
  event.preventDefault();
  const position = dropPosition.value || "after";
  const allowed = canDrop(tab, group);
  const draggedId = draggingId.value;
  dropTargetId.value = null;
  dropPosition.value = null;
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
  dropTargetId.value = null;
  dropPosition.value = null;
}
</script>

<template>
  <div v-if="groups.length > 0" class="sb-pinned">
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
          'drop-before': dropTargetId === tab.id && dropPosition === 'before',
          'drop-after': dropTargetId === tab.id && dropPosition === 'after',
        }"
        draggable="true"
        :title="tooltipFor(tab, group)"
        @click="emit('activate', tab)"
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
