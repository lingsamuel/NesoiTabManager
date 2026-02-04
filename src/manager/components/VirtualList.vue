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
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

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
});

const container = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
let resizeObserver = null;

const totalHeight = computed(() => props.items.length * props.itemHeight);

const startIndex = computed(() => {
  const raw = Math.floor(scrollTop.value / props.itemHeight) - props.overscan;
  return Math.max(0, raw);
});

const endIndex = computed(() => {
  const raw =
    Math.ceil((scrollTop.value + viewportHeight.value) / props.itemHeight) +
    props.overscan;
  return Math.min(props.items.length, raw);
});

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
  scrollTop.value = 0;
}

function scrollToBottom() {
  if (!container.value) {
    return;
  }
  const maxScroll = Math.max(0, totalHeight.value - viewportHeight.value);
  container.value.scrollTop = maxScroll;
  scrollTop.value = maxScroll;
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
      scrollTop.value = maxScroll;
    }
  }
);

defineExpose({
  scrollToTop,
  scrollToBottom,
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
