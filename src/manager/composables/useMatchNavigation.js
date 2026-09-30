import { computed, ref, watch } from "vue";

// “跳转模式”下的匹配项导航：在完整列表中定位匹配行，支持下一个/上一个循环跳转。
// rows 为当前渲染的数据（行/条目），isMatchRow 判断某条数据是否为可跳转的匹配目标。
function useMatchNavigation(options = {}) {
  const rows = options.rows;
  const isMatchRow = options.isMatchRow;
  const mode = options.mode;
  const hasQuery = options.hasQuery;

  const matchIndices = computed(() => {
    const list = Array.isArray(rows.value) ? rows.value : [];
    const indices = [];
    list.forEach((item, index) => {
      if (isMatchRow(item)) {
        indices.push(index);
      }
    });
    return indices;
  });

  const matchCount = computed(() => matchIndices.value.length);
  const currentMatchIdx = ref(-1);

  // 当前匹配在列表中的行号，供列表组件滚动与高亮；-1 表示无当前匹配。
  const currentMatchIndex = computed(() => {
    const idx = currentMatchIdx.value;
    if (idx < 0 || idx >= matchIndices.value.length) {
      return -1;
    }
    return matchIndices.value[idx];
  });

  // 当前匹配的位置序号（0 起），用于“第 n / 共 m”展示。
  const currentMatchPosition = computed(() =>
    currentMatchIdx.value >= 0 ? currentMatchIdx.value : -1
  );

  function goToNext() {
    if (matchCount.value === 0) {
      return;
    }
    currentMatchIdx.value = (currentMatchIdx.value + 1) % matchCount.value;
  }

  function goToPrev() {
    if (matchCount.value === 0) {
      return;
    }
    currentMatchIdx.value =
      (currentMatchIdx.value - 1 + matchCount.value) % matchCount.value;
  }

  /**
   * 按"行号"设置当前匹配项（滚动条刻度点击、滚动同步都会用到）。
   * 与 goToNext/goToPrev 一样只改状态：是否滚动由调用方决定，
   * 因为"滚动同步"绝不能反过来触发滚动，否则会把用户拽回去。
   *
   * @returns {boolean} 该行不是匹配项时返回 false
   */
  function setCurrentMatchByRowIndex(rowIndex) {
    const ordinal = matchIndices.value.indexOf(Number(rowIndex));
    if (ordinal < 0) {
      return false;
    }
    currentMatchIdx.value = ordinal;
    return true;
  }

  // 关键词变化、模式切换或数据变化时，重置到第一个匹配（或清空）。
  watch([hasQuery, mode, matchCount], () => {
    if (mode.value !== "jump" || !hasQuery.value || matchCount.value === 0) {
      currentMatchIdx.value = -1;
      return;
    }
    currentMatchIdx.value = 0;
  });

  return {
    matchCount,
    currentMatchIndex,
    currentMatchPosition,
    goToNext,
    goToPrev,
    setCurrentMatchByRowIndex,
  };
}

export { useMatchNavigation };
