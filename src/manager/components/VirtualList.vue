<template>
  <div class="virtual-scroller" ref="container" @scroll="onScroll">
    <div class="virtual-content" :style="{ height: `${totalHeight}px` }">
      <div
        v-for="entry in visibleEntries"
        :key="entry.key"
        class="virtual-row"
        :style="{ transform: `translateY(${entry.top}px)`, height: `${itemHeight}px` }"
      >
        <slot :item="entry.item" :index="entry.index" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { computeVisibleRange } from "../utils/virtual_range.js";

const props = defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  itemHeight: {
    type: Number,
    required: true,
  },
  overscan: {
    type: Number,
    default: 6,
  },
  currentMatchIndex: {
    type: Number,
    default: -1,
  },
});

const container = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
let resizeObserver = null;

const totalHeight = computed(() => props.items.length * props.itemHeight);

// 可见区间交给纯函数：它会夹取滚动位置并保证区间非空（详见 virtual_range.js 的说明）。
const range = computed(() =>
  computeVisibleRange({
    itemCount: props.items.length,
    itemHeight: props.itemHeight,
    scrollTop: scrollTop.value,
    viewportHeight: viewportHeight.value,
    overscan: props.overscan,
  })
);
const startIndex = computed(() => range.value.startIndex);
const endIndex = computed(() => range.value.endIndex);

const visibleEntries = computed(() => {
  const entries = [];
  for (let i = startIndex.value; i < endIndex.value; i += 1) {
    const item = props.items[i];
    entries.push({
      item,
      index: i,
      top: i * props.itemHeight,
      key: item && item.key ? item.key : `row-${i}`,
    });
  }
  return entries;
});

function onScroll() {
  syncScrollTop();
}

/**
 * 把响应式滚动位置与真实 DOM 对齐。
 * 只允许"从 DOM 读回来"，不允许"乐观地写进去"：滚动容器的内容高度变化时浏览器会自行夹取
 * scrollTop，若响应式副本仍是请求值，可见区间就会用到一个不存在的滚动位置，表现为整片空白。
 */
function syncScrollTop() {
  if (!container.value) {
    return;
  }
  scrollTop.value = container.value.scrollTop;
}

function updateViewportHeight() {
  if (!container.value) {
    return;
  }
  viewportHeight.value = container.value.clientHeight || 0;
}

function scrollToTop() {
  if (!container.value) {
    return;
  }
  container.value.scrollTop = 0;
  syncScrollTop();
}

function scrollToBottom() {
  if (!container.value) {
    return;
  }
  const maxScroll = Math.max(0, totalHeight.value - viewportHeight.value);
  container.value.scrollTop = maxScroll;
  syncScrollTop();
}

// 滚动到指定行并尽量居中显示，用于“跳转模式”下在匹配项之间导航。
function scrollToIndex(index) {
  if (!container.value || !Number.isFinite(index) || props.items.length === 0) {
    return;
  }
  const target = Math.max(0, Math.min(index, props.items.length - 1));
  const maxScroll = Math.max(0, totalHeight.value - viewportHeight.value);
  const top = Math.max(
    0,
    Math.min(
      target * props.itemHeight + props.itemHeight / 2 - viewportHeight.value / 2,
      maxScroll
    )
  );
  container.value.scrollTop = top;
  // 必须读回真实值：目标行可能在内容尚未铺开时被浏览器夹住，
  // 此时若把 scrollTop 记成请求值，可见区间就会失效（列表空白）。
  syncScrollTop();
}

watch(
  () => props.items.length,
  () => {
    if (!container.value) {
      return;
    }
    const maxScroll = Math.max(0, totalHeight.value - viewportHeight.value);
    if (container.value.scrollTop > maxScroll) {
      container.value.scrollTop = maxScroll;
    }
    syncScrollTop();
  },
  // 等 DOM 高度更新完再夹取，否则读到的是旧内容高度下的滚动位置。
  { flush: "post" }
);

watch(
  () => props.currentMatchIndex,
  async (index) => {
    if (index < 0) {
      return;
    }
    // post + nextTick：行数变化与匹配变化往往在同一轮里发生，
    // 必须等内容高度真正更新后再滚，否则会被按旧高度夹住，表现为"没有跳到第一个匹配项"。
    await nextTick();
    scrollToIndex(index);
  },
  { flush: "post" }
);

defineExpose({
  scrollToTop,
  scrollToBottom,
  scrollToIndex,
});

onMounted(() => {
  updateViewportHeight();
  resizeObserver = new ResizeObserver(updateViewportHeight);
  if (container.value) {
    resizeObserver.observe(container.value);
  }
});

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
});
</script>
