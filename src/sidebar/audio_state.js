// 侧边栏行内「发声 / 静音 / 需要关注」标记的纯逻辑。
//
// 为什么单独抽一个模块：这三个状态的**读写口径很不对称**——
//   写：tabs.update({ muted })，Firefox 与 Chromium 都支持；
//   读：只能走 mutedInfo.muted（tabs.Tab 没有 muted 字段，见 background/utils.js 的 isTabMuted）；
//   关注：attention 自 Firefox 63 起进入 tabs.Tab 与 onUpdated 的 changeInfo。
// 判定与补丁都收在这里，组件只负责渲染、SidebarApp 只负责调度，规则可以在 Node 里直接单测。
//
// 本模块不依赖 Vue 与浏览器 API：所有入参都是普通的 Tab / changeInfo 对象。

import { isTabMuted } from "../../background/utils.js";

// 与静音状态同源：后台右键菜单、固定标签圆点都用它，避免两处读法分叉。
export { isTabMuted };

/** 标签是否正在发声（Firefox 里"最近几秒内产生过声音"，与原生标签喇叭图标同义）。 */
export function isTabAudible(tab) {
  return Boolean(tab && tab.audible);
}

/** 标签是否在请求关注（例如后台页面弹出了对话框）。 */
export function isTabAttention(tab) {
  return Boolean(tab && tab.attention);
}

/**
 * 行内喇叭按钮的呈现状态。
 *
 * visible 为 false 时整行**不渲染**按钮（也就不会占位）：
 * 只有"正在发声"或"已被静音"的标签才显示音频图标，与 Firefox 原生标签栏一致。
 * 已静音时即使当前没在出声也保持显示——它表达的是"这个标签被你静音了"，
 * 用户需要一个一眼能看出、并且能点回去的入口。
 *
 * @param {{ audible?: boolean, mutedInfo?: { muted?: boolean } }|null|undefined} tab
 * @returns {{ visible: boolean, audible: boolean, muted: boolean, title: string }}
 */
export function audioIndicator(tab) {
  const audible = isTabAudible(tab);
  const muted = isTabMuted(tab);
  return {
    visible: audible || muted,
    audible,
    muted,
    title: muted ? "取消静音" : "静音此标签页",
  };
}

/**
 * 把任意来源的 mutedInfo 规整成 `{ muted: boolean }`。
 * 保留 reason / extensionId 等原有字段（右键菜单与其它扩展都会读它们），
 * 只把 muted 强制成布尔值，避免 undefined / null 渗进模板判定。
 */
export function normalizeMutedInfo(info) {
  if (!info || typeof info !== "object") {
    return { muted: false };
  }
  return { ...info, muted: Boolean(info.muted) };
}

/**
 * 构造"把某个标签切换为 muted"的本地补丁。
 * 用于点击喇叭后的**乐观更新**：先让界面立刻响应，等 onUpdated 回来再以浏览器为准。
 */
export function mutedPatch(tab, muted) {
  return {
    mutedInfo: { ...normalizeMutedInfo(tab && tab.mutedInfo), muted: Boolean(muted) },
  };
}

/**
 * onUpdated 的 changeInfo → 本地标签对象的状态补丁。
 *
 * 只提取行内标记真正用到的字段：changeInfo 是任意子集（一个事件可能只带一个键），
 * 且 title / url / favIconUrl / discarded / pinned 由"整窗刷新"那条路径负责，这里一概不碰——
 * 混进来会把一次廉价的本地补丁变成一次整窗查询。
 *
 * @param {object|null|undefined} changeInfo
 * @returns {{ audible?: boolean, attention?: boolean, mutedInfo?: object }}
 */
export function statePatchFromChangeInfo(changeInfo) {
  const patch = {};
  if (!changeInfo) {
    return patch;
  }
  if ("audible" in changeInfo) {
    patch.audible = Boolean(changeInfo.audible);
  }
  if ("attention" in changeInfo) {
    patch.attention = Boolean(changeInfo.attention);
  }
  if ("mutedInfo" in changeInfo) {
    patch.mutedInfo = normalizeMutedInfo(changeInfo.mutedInfo);
  }
  return patch;
}
