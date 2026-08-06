<template>
  <div class="filter-bar">
    <FilterInput
      :model-value="modelValue"
      placeholder="筛选标题或网址"
      @update:model-value="emit('update:modelValue', $event)"
      @commit="emit('commit', $event)"
      @next="emit('next')"
      @prev="emit('prev')"
    />
    <div class="filter-mode-toggle" role="group" aria-label="筛选模式">
      <button
        type="button"
        class="filter-mode-btn"
        :class="{ active: mode === 'filter' }"
        @click="emit('mode-change', 'filter')"
      >
        过滤
      </button>
      <button
        type="button"
        class="filter-mode-btn"
        :class="{ active: mode === 'jump' }"
        @click="emit('mode-change', 'jump')"
      >
        跳转
      </button>
    </div>
    <template v-if="mode === 'jump' && hasQuery">
      <span class="filter-match-count" :class="{ empty: matchCount === 0 }">
        {{ matchCount === 0 ? "无匹配" : `${Math.max(currentIndex, 0) + 1}/${matchCount}` }}
      </span>
      <button
        type="button"
        class="ghost btn-icon filter-jump-btn"
        title="上一个匹配（Shift+Enter）"
        :disabled="matchCount === 0"
        @click="emit('prev')"
      >
        <span class="icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M6 15l6-6 6 6" />
          </svg>
        </span>
      </button>
      <button
        type="button"
        class="ghost btn-icon filter-jump-btn"
        title="下一个匹配（Enter）"
        :disabled="matchCount === 0"
        @click="emit('next')"
      >
        <span class="icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
    </template>
  </div>
</template>

<script setup>
import FilterInput from "./FilterInput.vue";

defineProps({
  modelValue: {
    type: String,
    default: "",
  },
  mode: {
    type: String,
    default: "filter",
  },
  matchCount: {
    type: Number,
    default: 0,
  },
  // 当前匹配位置（0 起），-1 表示无当前匹配。
  currentIndex: {
    type: Number,
    default: -1,
  },
  hasQuery: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  "update:modelValue",
  "commit",
  "mode-change",
  "next",
  "prev",
]);
</script>
