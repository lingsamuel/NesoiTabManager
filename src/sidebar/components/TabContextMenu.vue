<script setup>
// 侧边栏自建的标签右键菜单。
//
// 为什么不用浏览器菜单：没有任何 API 能让扩展弹出「原生标签栏菜单」。
// Tree Style Tab 的做法是 Firefox 专有的 menus.overrideContext 加上一套自实现的仿真菜单，
// 这里同样自建，并把交互细节（位置自适应、Esc / 点击外部 / 滚动关闭、键盘上下选择）向原生看齐。
//
// 使用方式：父级用 v-if 控制显隐，传入鼠标坐标与菜单项；位置会在挂载后按实际尺寸收拢进视口。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  // [{ key, label, danger?, disabled?, separatorBefore? }]
  items: {
    type: Array,
    default: () => [],
  },
  x: {
    type: Number,
    default: 0,
  },
  y: {
    type: Number,
    default: 0,
  },
});

const emit = defineEmits(["select", "close"]);

const menuRef = ref(null);
const activeIndex = ref(-1);
const position = ref({ left: props.x, top: props.y });
let cleanupFns = [];

const enabledIndexes = computed(() =>
  props.items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0)
);

/** 就近收拢：菜单超出右/下边缘时向左/上翻转，保证完整可见。 */
function placeMenu() {
  const element = menuRef.value;
  if (!element) {
    position.value = { left: props.x, top: props.y };
    return;
  }
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth || 0;
  const viewportHeight = window.innerHeight || 0;
  const margin = 6;
  let left = props.x;
  let top = props.y;
  if (viewportWidth && left + rect.width > viewportWidth - margin) {
    left = Math.max(margin, viewportWidth - rect.width - margin);
  }
  if (viewportHeight && top + rect.height > viewportHeight - margin) {
    top = Math.max(margin, viewportHeight - rect.height - margin);
  }
  position.value = { left, top };
}

function selectItem(item) {
  if (!item || item.disabled) {
    return;
  }
  emit("select", item.key);
}

function moveActive(step) {
  const indexes = enabledIndexes.value;
  if (indexes.length === 0) {
    return;
  }
  const current = indexes.indexOf(activeIndex.value);
  const next = current < 0
    ? (step > 0 ? 0 : indexes.length - 1)
    : (current + step + indexes.length) % indexes.length;
  activeIndex.value = indexes[next];
}

function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActive(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(-1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    selectItem(props.items[activeIndex.value]);
  }
}

function onDocumentPointerDown(event) {
  const element = menuRef.value;
  if (element && !element.contains(event.target)) {
    emit("close");
  }
}

function onWindowBlur() {
  emit("close");
}

function onAnyScroll() {
  emit("close");
}

// 右键另一行时父级可能在同一个事件循环里先关后开（visible 不经历真正的卸载），
// 组件不会重新挂载，因此位置与尺寸必须跟着新的坐标/菜单项重新收拢。
watch(
  () => [props.x, props.y],
  async () => {
    await nextTick();
    placeMenu();
  }
);

watch(
  () => props.items,
  async () => {
    await nextTick();
    placeMenu();
  }
);

onMounted(async () => {
  await nextTick();
  placeMenu();
  // 捕获阶段监听滚动与指针：固定标签区与树区域都可能滚动，菜单必须跟着关掉。
  document.addEventListener("mousedown", onDocumentPointerDown, true);
  document.addEventListener("contextmenu", onDocumentPointerDown, true);
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", placeMenu);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("scroll", onAnyScroll, true);
  cleanupFns = [
    () => document.removeEventListener("mousedown", onDocumentPointerDown, true),
    () => document.removeEventListener("contextmenu", onDocumentPointerDown, true),
    () => window.removeEventListener("keydown", onKeydown),
    () => window.removeEventListener("resize", placeMenu),
    () => window.removeEventListener("blur", onWindowBlur),
    () => window.removeEventListener("scroll", onAnyScroll, true),
  ];
});

onBeforeUnmount(() => {
  for (const cleanup of cleanupFns.splice(0)) {
    cleanup();
  }
});
</script>

<template>
  <div
    ref="menuRef"
    class="sb-menu"
    role="menu"
    :style="{ left: `${position.left}px`, top: `${position.top}px` }"
  >
    <template v-for="(item, index) in items" :key="item.key">
      <div v-if="item.separatorBefore" class="sb-menu-sep" aria-hidden="true"></div>
      <button
        type="button"
        class="sb-menu-item"
        :class="{ danger: item.danger, active: activeIndex === index }"
        :disabled="Boolean(item.disabled)"
        role="menuitem"
        @click="selectItem(item)"
        @mouseenter="activeIndex = item.disabled ? -1 : index"
      >
        {{ item.label }}
      </button>
    </template>
  </div>
</template>
