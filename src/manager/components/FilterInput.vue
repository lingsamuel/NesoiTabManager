<template>
  <div class="filter-input">
    <span class="filter-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z" />
      </svg>
    </span>
    <input
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      @input="handleInput"
      @compositionstart="handleCompositionStart"
      @compositionend="handleCompositionEnd"
      @keydown.esc="handleClear"
    />
    <button
      v-if="modelValue"
      class="filter-clear"
      type="button"
      aria-label="清空筛选"
      title="清空筛选"
      @click="handleClear"
    >
      <svg viewBox="0 0 24 24">
        <path d="M6 6l12 12M18 6l-12 12" />
      </svg>
    </button>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue: {
    type: String,
    default: "",
  },
  placeholder: {
    type: String,
    default: "筛选标题或网址",
  },
  delay: {
    type: Number,
    default: 250,
  },
});

const emit = defineEmits(["update:modelValue", "commit"]);

let composing = false;
let timer = null;

function scheduleCommit(value) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    emit("commit", value);
  }, props.delay);
}

// 输入法组合期间（如拼音候选的“临时字符”）只更新显示值，不进入搜索流程；
// 组合结束后再基于最终文本触发一次防抖搜索，避免中间态误过滤。
function handleInput(event) {
  const value = event.target.value;
  emit("update:modelValue", value);
  if (composing || event.isComposing) {
    return;
  }
  scheduleCommit(value);
}

function handleCompositionStart() {
  composing = true;
}

function handleCompositionEnd(event) {
  composing = false;
  emit("update:modelValue", event.target.value);
  scheduleCommit(event.target.value);
}

function handleClear() {
  clearTimeout(timer);
  timer = null;
  emit("update:modelValue", "");
  emit("commit", "");
}
</script>
