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
  // 是否在"当前匹配项变化"时自动滚动过去。
  // 侧边栏会在滚动时同步当前匹配项（见 scroll_markers.js），那种同步绝不能再触发滚动，
  // 否则用户每滚一下都会被拉回去；因此侧边栏关闭它并改为在导航动作里显式滚动。
  autoScrollToMatch: {
    type: Boolean,
    default: true,
  },
  // 滚动位置记忆的作用域键（管理页里是 `windows:<窗口 id>`）。
  // 空字符串表示不记忆——侧边栏与列表视图不需要这个能力，保持原来的单实例行为。
  scrollKey: {
    type: String,
    default: "",
  },
});

// 可见区间变化对外广播：侧边栏据此决定"当前跳转项是否该跟着可见范围走"。
const emit = defineEmits(["range-change"]);

// 每个作用域键各记一份滚动位置，**只存内存、不落盘**。
//
// 为什么放在模块作用域而不是组件内部：TabListPanel 在行数为 0 时会用 v-if 换掉整个虚拟列表，
// 组件随之被卸载，写在组件里的记忆会一起丢；而"内存中保留"的语义应当跨过这次卸载。
const scrollMemory = new Map();

const container = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
// 当前生效的作用域键。用普通变量而非 ref：它只在事件与 watcher 里被读，不参与渲染。
let activeScrollKey = props.scrollKey;
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
 * 把响应式滚动位置与真实 DOM 对齐，并顺手记进当前作用域的滚动位置。
 * 只允许"从 DOM 读回来"，不允许"乐观地写进去"：滚动容器的内容高度变化时浏览器会自行夹取
 * scrollTop，若响应式副本仍是请求值，可见区间就会用到一个不存在的滚动位置，表现为整片空白。
 */
function syncScrollTop() {
  if (!container.value) {
    return;
  }
  scrollTop.value = container.value.scrollTop;
  if (activeScrollKey) {
    scrollMemory.set(activeScrollKey, scrollTop.value);
  }
}

/**
 * 恢复当前作用域上次的滚动位置。
 *
 * @param {number} [savedTop] 显式的目标位置。切换作用域时必须由调用方在"DOM 换成新内容之前"
 *   取好快照传进来：新内容更矮时，post 时机的夹取会先把旧窗口的 scrollTop 截断并写进新键的记忆，
 *   若这里再回头读 Map，读到的就是被截断后的值，用户的原始位置就丢了。
 *   保存值也可能超过新内容的最大高度（例如原窗口标签变少了），必须按当前高度夹取，
 *   否则浏览器会自行夹取，而响应式副本会停留在请求值上，可见区间随即失效（整片空白）。
 */
function restoreScroll(savedTop) {
  if (!container.value) {
    return;
  }
  const saved = Number.isFinite(savedTop)
    ? savedTop
    : (activeScrollKey && scrollMemory.has(activeScrollKey) ? scrollMemory.get(activeScrollKey) : 0);
  const maxScroll = Math.max(0, totalHeight.value - viewportHeight.value);
  container.value.scrollTop = Math.max(0, Math.min(saved, maxScroll));
  syncScrollTop();
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

// 区间变化用 post 时机广播：父级在回调里读取的是渲染后的真实布局。
watch(
  range,
  (value) => {
    emit("range-change", { startIndex: value.startIndex, endIndex: value.endIndex });
  },
  { flush: "post" }
);

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

/**
 * 切换作用域（管理页切窗口）时恢复该作用域上次的滚动位置。
 *
 * 时机必须用 pre：post 时机的 items.length 夹取一定发生在本 watcher 之后，
 * 那时"当前键"已经是新键，夹取触发的 scroll 事件只会写进新键的记录，
 * 不会把旧键（用户刚离开的那个窗口）的位置覆盖成被压缩后的值。
 * 恢复动作再延到 nextTick 之后：必须等新内容高度真正落到 DOM 上，夹取才算数。
 */
watch(
  () => props.scrollKey,
  async (key) => {
    // pre 时机下 DOM 还是旧内容：先把"离开时的真实位置"落一笔，
    // 再去读新作用域的快照（此刻读到的还是用户当初离开新作用域时的原始位置）。
    if (container.value && activeScrollKey) {
      scrollMemory.set(activeScrollKey, container.value.scrollTop);
    }
    const saved = scrollMemory.has(key) ? scrollMemory.get(key) : 0;
    activeScrollKey = key;
    await nextTick();
    restoreScroll(saved);
  },
  { flush: "pre" }
);

watch(
  () => props.currentMatchIndex,
  async (index) => {
    if (index < 0 || !props.autoScrollToMatch) {
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
  // 组件可能因为"上一个作用域行数为 0"被卸载过（TabListPanel 的 v-if），
  // 重新挂载时要把该作用域的位置再贴回来；模块级 Map 正是为了跨过这次卸载。
  if (activeScrollKey) {
    restoreScroll();
  }
});

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
});
</script>
