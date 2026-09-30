import { storageGet, storageSet } from "../../../background/storage.js";

/*
  管理页的"上次选择的分组"记忆。

  为什么单独成模块而不是塞进 useLists：useLists 是纯函数式 composable，测试里直接实例化，
  引入 chrome.storage 会让它在 Node 环境不可用（同 useTree 的教训：setup 阶段抛错就是整页白屏）。
  这里做成"读写都吞异常、失败即降级为不记忆"，任何一步出错都不会影响列表本身的可用性。

  存储形态：`listTargetMemory` 一个键，内含两个入口：
    - save：最后一次「保存所选」弹窗选择的目标列表 id
    - move：最后一次「移动到」弹窗选择的目标列表 id
  这两个入口互不影响（用户可能习惯把标签固定存到 A、把临时标签移到 B）。

  约束：`__new__` / `__move_new__` 这类"新建列表"占位值**不写盘**。
  因为它们是"上一次选了新建"，而不是一个具体的分组；记住它只会让下次弹窗默认落在新建表单上，
  把用户上一次真正选过的分组挤掉。选择新建后仍按下面的回退规则决定默认值。

  回退规则（读取时逐条判断，任何一条不满足就降级到"新建列表"）：
    1. 该 id 对应的列表还存在；
    2. 该列表不是当前弹窗里的源列表（「移动到」不允许移动到自身，见 background/lists.js 的校验）。
*/

const MEMORY_KEY = "listTargetMemory";

const NEW_LIST_VALUE = "__new__";
const MOVE_NEW_LIST_VALUE = "__move_new__";

function isConcreteListId(value) {
  if (!value) {
    return false;
  }
  const id = String(value);
  return id !== NEW_LIST_VALUE && id !== MOVE_NEW_LIST_VALUE;
}

async function readMemory() {
  try {
    const stored = await storageGet(MEMORY_KEY);
    return stored && typeof stored === "object" ? stored : {};
  } catch (error) {
    return {};
  }
}

/**
 * @param {"save"|"move"} slot 弹窗种类
 * @param {Array<{id: string}>} lists 当前全部列表
 * @param {string} [excludeListId] 「移动到」里要排除的源列表 id
 * @returns {Promise<string|null>} 可用的列表 id；null 表示应当回退到"新建列表"
 */
async function resolveRememberedListId(slot, lists, excludeListId) {
  const memory = await readMemory();
  const remembered = isConcreteListId(memory[slot]) ? String(memory[slot]) : "";
  if (!remembered) {
    return null;
  }
  const available = Array.isArray(lists) ? lists : [];
  if (!available.some((list) => list && String(list.id) === remembered)) {
    return null;
  }
  if (excludeListId && String(excludeListId) === remembered) {
    return null;
  }
  return remembered;
}

/**
 * 写入队列：读—改—写三步必须串行，否则两个弹窗几乎同时选择时会互相覆盖
 * （后完成的那个用自己读到的旧快照把对方写入的值盖掉，表现为"刚记住的分组又没了"）。
 */
let writeQueue = Promise.resolve();

/** 记住用户在一次弹窗里真正选中的分组；占位值会被忽略（见文件顶部说明）。 */
async function rememberListId(slot, listId) {
  if (!isConcreteListId(listId)) {
    return;
  }
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      try {
        const memory = await readMemory();
        memory[slot] = String(listId);
        await storageSet({ [MEMORY_KEY]: memory });
      } catch (error) {
        // 忽略：记忆失败不影响主流程，下次弹窗退化为"新建列表"。
      }
    });
  return writeQueue;
}

export {
  MOVE_NEW_LIST_VALUE,
  NEW_LIST_VALUE,
  rememberListId,
  resolveRememberedListId,
};
