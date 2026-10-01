// 侧边栏行内「发声 / 静音 / 需要关注」标记的纯逻辑测试。
//
// 这一层在浏览器里只能靠肉眼观察"喇叭有没有出现、点了有没有反应"，很容易漏掉边界情况，
// 因此把判定与补丁都抽成纯函数在这里覆盖。其中最要命的一条是**读法回归**：
// tabs.Tab 没有 muted 字段，任何地方退回读 tab.muted 都会让静音状态永远判成 false，
// 表现为"取消静音点不动"——这类错误不会报错，只会在真实浏览器里静默失效。

import {
  audioIndicator,
  isTabAttention,
  isTabAudible,
  isTabMuted,
  mutedPatch,
  statePatchFromChangeInfo,
} from "../src/sidebar/audio_state.js";

let failures = 0;
let checks = 0;

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  checks += 1;
  if (a !== b) {
    failures += 1;
    console.error(`✗ ${label}\n    期望 ${b}\n    实际 ${a}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function assertEqual(actual, expected, label) {
  checks += 1;
  if (actual !== expected) {
    failures += 1;
    console.error(`✗ ${label}：期望 ${expected}，实际 ${actual}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

/** 造一个"形状与真实 chrome.tabs.Tab 一致"的标签：静音状态只在 mutedInfo 里。 */
function makeTab(extra = {}) {
  return {
    id: 1,
    windowId: 10,
    audible: false,
    mutedInfo: { muted: false },
    attention: false,
    ...extra,
  };
}

function main() {
  console.log("场景 1：静音状态只认 mutedInfo.muted（回归：tab.muted 不存在）");
  assertEqual(isTabMuted(makeTab({ mutedInfo: { muted: true } })), true, "mutedInfo.muted=true → 已静音");
  assertEqual(isTabMuted(makeTab()), false, "mutedInfo.muted=false → 未静音");
  // 关键回归：早期实现读 tab.muted，而真实的 tabs.Tab 根本没有这个字段。
  assertEqual(isTabMuted({ id: 1, muted: true }), false, "只有 tab.muted（真实 API 不存在）时判为未静音");
  assertEqual(isTabMuted(null), false, "空标签不报错");
  assertEqual(isTabMuted({ id: 1, mutedInfo: null }), false, "mutedInfo 为 null 时不报错");
  assertEqual(isTabAudible(makeTab({ audible: true })), true, "audible=true → 正在发声");
  assertEqual(isTabAttention(makeTab({ attention: true })), true, "attention=true → 需要关注");
  assertEqual(isTabAttention(makeTab()), false, "attention 缺省 → 不需要关注");

  console.log("场景 2：喇叭按钮的显示规则");
  assertDeepEqual(
    audioIndicator(makeTab({ audible: true })),
    { visible: true, audible: true, muted: false, title: "静音此标签页" },
    "正在发声 → 显示喇叭，提示「静音此标签页」"
  );
  assertDeepEqual(
    audioIndicator(makeTab({ audible: false, mutedInfo: { muted: true } })),
    { visible: true, audible: false, muted: true, title: "取消静音" },
    "已静音但当前无声 → 仍然常显（与原生标签一致），提示「取消静音」"
  );
  assertDeepEqual(
    audioIndicator(makeTab({ audible: true, mutedInfo: { muted: true } })),
    { visible: true, audible: true, muted: true, title: "取消静音" },
    "已静音且正在发声 → 显示静音图标（点击是取消静音）"
  );
  assertDeepEqual(
    audioIndicator(makeTab()),
    { visible: false, audible: false, muted: false, title: "静音此标签页" },
    "既无声也未静音 → 整行不渲染按钮（不占位）"
  );
  assertEqual(audioIndicator(null).visible, false, "空标签不显示按钮");
  assertEqual(audioIndicator({ id: 2 }).visible, false, "缺少 mutedInfo / audible 的标签不显示按钮");

  console.log("场景 3：onUpdated 的 changeInfo → 本地补丁");
  assertDeepEqual(statePatchFromChangeInfo({ audible: true }), { audible: true }, "audible 变化进补丁");
  assertDeepEqual(statePatchFromChangeInfo({ attention: true }), { attention: true }, "attention 变化进补丁");
  assertDeepEqual(
    statePatchFromChangeInfo({ mutedInfo: { muted: true, reason: "user" } }),
    { mutedInfo: { muted: true, reason: "user" } },
    "mutedInfo 连 reason 一起进补丁"
  );
  assertDeepEqual(
    statePatchFromChangeInfo({ mutedInfo: null }),
    { mutedInfo: { muted: false } },
    "mutedInfo 为 null 时规整成 { muted: false }，避免脏值渗进模板"
  );
  assertDeepEqual(
    statePatchFromChangeInfo({ audible: true, attention: true, mutedInfo: { muted: true } }),
    { audible: true, attention: true, mutedInfo: { muted: true } },
    "一个事件带多个展示态字段时全部提取"
  );
  assertDeepEqual(statePatchFromChangeInfo({}), {}, "空 changeInfo → 空补丁（不触发任何写入）");
  assertDeepEqual(statePatchFromChangeInfo(null), {}, "changeInfo 为 null → 空补丁");
  assertDeepEqual(
    statePatchFromChangeInfo({ status: "loading", title: "新标题" }),
    {},
    "只影响结构与文本的字段不进补丁（那条路走整窗刷新）"
  );

  console.log("场景 4：乐观补丁保留 mutedInfo 的其它字段");
  assertDeepEqual(
    mutedPatch(makeTab({ mutedInfo: { muted: false, reason: "user", extensionId: "x" } }), true),
    { mutedInfo: { muted: true, reason: "user", extensionId: "x" } },
    "切换静音时保留 reason / extensionId"
  );
  assertDeepEqual(
    mutedPatch(null, true),
    { mutedInfo: { muted: true } },
    "标签缺少 mutedInfo 时也能构造出合法补丁"
  );

  console.log("");
  console.log(`共 ${checks} 项断言，失败 ${failures} 项`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("✓ 全部通过");
}

main();
