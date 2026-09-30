<script setup>
// 固定标签区：跨窗口聚合所有固定标签，按窗口分组，只显示图标。
//
// 三个关键行为：
// - 不参与滚动：它是独立容器（高度上限由 CSS 控制），不会随下方树区域滚走；
// - 只允许同窗口内的顺序重排：跨窗口拖拽等价于"把标签移动到另一个窗口"，
//   与"重排顺序但不影响窗口"的诉求相悖，因此直接不响应（连落点指示都不显示）；
// - 中键关闭，同时拦截中键 mousedown，避免 Firefox 触发中键自动滚动。

import { ref } from "vue";
import { pinnedTabTooltip } from "../pinned_data.js";

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

function onIconError(event) {
  event.target.classList.add("hidden");
}

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

function positionFromEvent(event) {
  const element = event.currentTarget;
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return "after";
  }
  const rect = element.getBoundingClientRect();
  if (!rect.height) {
    return "after";
  }
  // 固定标签只有 24px 高，只分上下两半（没有"成为子标签"这一档）。
  return event.clientY - rect.top < rect.height / 2 ? "before" : "after";
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
    <template v-for="(group, groupIndex) in groups" :key="group.windowId">
      <div v-if="groupIndex > 0" class="sb-pinned-sep" aria-hidden="true"></div>
      <div
        v-for="tab in group.tabs"
        :key="tab.id"
        class="sb-pin"
        :class="{
          current: Boolean(tab.active),
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
        @contextmenu.prevent="onContextMenu(tab, $event)"
        @dragstart="onDragStart(tab, group, $event)"
        @dragover="onDragOver(tab, group, $event)"
        @dragleave="onDragLeave(tab)"
        @drop="onDrop(tab, group, $event)"
        @dragend="onDragEnd"
      >
        <img
          class="sb-pin-icon"
          :class="{ hidden: !tab.favIconUrl }"
          :src="tab.favIconUrl || ''"
          alt=""
          @error="onIconError"
        />
        <button
          type="button"
          class="sb-pin-close"
          title="关闭此固定标签"
          @click.stop="emit('close', tab)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6l-12 12" />
          </svg>
        </button>
        <span v-if="tab.muted" class="sb-pin-muted" title="已静音" aria-hidden="true"></span>
      </div>
    </template>
  </div>
</template>
