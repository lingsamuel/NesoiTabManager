import { ref } from "vue";

// 管理单个筛选输入框的状态：query 为输入框实时值（可能含输入法临时字符），
// committed 为防抖后真正用于过滤的关键词，避免频繁输入造成性能损耗。
// 防抖与输入法组合期处理由 FilterInput 组件负责，这里只承载页面级状态。
function useFilterQuery() {
  const query = ref("");
  const committed = ref("");

  function update(value) {
    query.value = String(value || "");
  }

  function commit(value) {
    committed.value = String(value || "");
  }

  function clear() {
    update("");
    commit("");
  }

  return { query, committed, update, commit, clear };
}

export { useFilterQuery };
