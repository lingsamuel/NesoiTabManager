<script setup>
// 标签图标：有 favicon 用 favicon，没有（或加载失败）时退回内置的占位图标。
//
// 为什么需要占位：直接隐藏 <img> 会留下一个空方块，尤其是固定标签区这种"整块区域只有图标"的布局，
// 空白方块会让用户以为渲染坏了。Tree Style Tab 同样提供默认图标。
//
// 尺寸由使用方的类控制（例如固定标签区 16px、树行 14px），这里只负责内容与失败回退。

import { computed, ref, watch } from "vue";

const props = defineProps({
  url: {
    type: String,
    default: "",
  },
});

// 记录加载失败：换标签（url 变化）时重置，避免同一组件复用后一直显示占位图。
const failed = ref(false);
watch(
  () => props.url,
  () => {
    failed.value = false;
  }
);

const showPlaceholder = computed(() => !props.url || failed.value);

function onError() {
  failed.value = true;
}
</script>

<template>
  <span class="tab-favicon">
    <img v-if="!showPlaceholder" :src="url" alt="" @error="onError" />
    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
      <!-- 简化的地球：一眼能看出"这个站点没有提供图标"，而不是一片空白 -->
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.4 2.7 3.7 5.7 3.7 9s-1.3 6.3-3.7 9c-2.4-2.7-3.7-5.7-3.7-9S9.6 5.7 12 3z" />
    </svg>
  </span>
</template>
