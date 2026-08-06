import { ref } from "vue";

// 管理单个筛选输入框的状态：query 为输入框实时值（可能含输入法临时字符），
// committed 为防抖后真正用于过滤的关键词，避免频繁输入造成性能损耗。
// mode 区分两种使用方式：filter 只显示匹配项；jump 保持完整列表并高亮匹配，可上下跳转。
// 防抖与输入法组合期处理由 FilterInput 组件负责，这里只承载页面级状态。
function useFilterQuery() {
  const query = ref("");
  const committed = ref("");
  const mode = ref("filter");

  function update(value) {
    query.value = String(value || "");
  }

  function commit(value) {
    committed.value = String(value || "");
  }

  function setMode(value) {
    mode.value = value === "jump" ? "jump" : "filter";
  }

  function clear() {
    update("");
    commit("");
  }

  return { query, committed, mode, update, commit, setMode, clear };
}

export { useFilterQuery };
