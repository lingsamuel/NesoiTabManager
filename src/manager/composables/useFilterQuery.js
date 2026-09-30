import { ref } from "vue";
import { storageLocalGet, storageLocalSet } from "../utils/storage.js";

// 管理单个筛选输入框的状态：query 为输入框实时值（可能含输入法临时字符），
// committed 为防抖后真正用于过滤的关键词，避免频繁输入造成性能损耗。
// mode 区分两种使用方式：filter 只显示匹配项；jump 保持完整列表并高亮匹配，可上下跳转。
// 防抖与输入法组合期处理由 FilterInput 组件负责，这里只承载页面级状态。

const MODE_STORAGE_KEY = "filterMode";
const MODE_FILTER = "filter";
const MODE_JUMP = "jump";

// 过滤/跳转模式是**全局偏好**，因此放在模块级而不是每个实例里：
// 管理页一次会创建 4 个筛选实例（Windows / 列表 / 最近 / 历史），侧边栏另有 1 个，
// 但它们表达的是同一个用户偏好，共用同一个 ref 与同一个 chrome.storage.local 键
// （与 treeViewMode 的做法保持一致）。跨重启记住，且只在切换时写一次。
const sharedMode = ref(MODE_FILTER);
let modeLoadStarted = false;
// 读取完成之前用户已经手动切过模式时，不能被存储里的旧值覆盖。
let modeDirty = false;

function normalizeMode(value) {
  return value === MODE_JUMP ? MODE_JUMP : MODE_FILTER;
}

function ensureModeLoaded() {
  if (modeLoadStarted) {
    return;
  }
  modeLoadStarted = true;
  Promise.resolve(storageLocalGet(MODE_STORAGE_KEY))
    .then((stored) => {
      if (modeDirty || stored === undefined || stored === null) {
        return;
      }
      sharedMode.value = normalizeMode(stored);
    })
    .catch(() => {
      // 读取失败就沿用默认值，不影响主流程。
    });
}

function setSharedMode(value) {
  const next = normalizeMode(value);
  modeDirty = true;
  if (sharedMode.value === next) {
    return;
  }
  sharedMode.value = next;
  void storageLocalSet({ [MODE_STORAGE_KEY]: next });
}

function useFilterQuery() {
  // 首次调用即开始读取持久化的模式；多个实例只会真正读一次。
  ensureModeLoaded();

  const query = ref("");
  const committed = ref("");

  function update(value) {
    query.value = String(value || "");
  }

  function commit(value) {
    committed.value = String(value || "");
  }

  function setMode(value) {
    setSharedMode(value);
  }

  function clear() {
    update("");
    commit("");
  }

  // mode 是模块级共享 ref：任一实例切换，所有实例与侧边栏一起变。
  return { query, committed, mode: sharedMode, update, commit, setMode, clear };
}

export { useFilterQuery };
