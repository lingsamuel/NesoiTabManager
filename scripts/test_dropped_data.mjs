// 侧边栏外部拖放的纯逻辑测试。
//
// 拖放交互在真实浏览器里几乎没法自动化，但"取哪种类型、算链接还是搜索词、落到哪个位置"
// 全是纯函数。这里用假的 DataTransfer 把 Tree Style Tab 对齐过来的那套规则固定下来，
// 以后改优先级或正则时不会悄悄退化。

const dropped = await import("../src/sidebar/dropped_data.js");

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function assertEqual(actual, expected, label) {
  checks += 1;
  if (actual !== expected) {
    failures += 1;
    console.error(`✗ ${label}：期望 ${expected}，实际 ${actual}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

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

/** 假 DataTransfer：只实现解析真正用到的两个成员。 */
function fakeDataTransfer(entries) {
  const types = Object.keys(entries);
  return {
    types,
    getData(type) {
      return Object.prototype.hasOwnProperty.call(entries, type) ? entries[type] : "";
    },
  };
}

function main() {
  console.log("场景 1：拖链接时优先取 text/uri-list，而不是把链接当文本搜索");
  assertDeepEqual(
    dropped.parseDroppedItem(
      fakeDataTransfer({
        "text/uri-list": "https://example.com/page\r\n",
        "text/plain": "https://example.com/page",
      })
    ),
    { kind: "url", value: "https://example.com/page" },
    "uri-list 优先"
  );
  assertDeepEqual(
    dropped.parseDroppedItem(
      fakeDataTransfer({
        "text/uri-list": "# 注释行\n\nhttps://a.example/x\nhttps://b.example/y\n",
        "text/plain": "https://a.example/x",
      })
    ),
    { kind: "url", value: "https://a.example/x" },
    "丢掉 # 注释行与空行，取第一条"
  );

  console.log("");
  console.log("场景 2：Firefox 的 text/x-moz-url 是 URL/标题成对数据");
  assertDeepEqual(
    dropped.parseDroppedItem(
      fakeDataTransfer({ "text/x-moz-url": "https://moz.example/p\n页面标题\n" })
    ),
    { kind: "url", value: "https://moz.example/p" },
    "取偶数行（URL）"
  );
  assertDeepEqual(
    dropped.parseDroppedItem(
      fakeDataTransfer({ "text/x-moz-text-internal": "https://internal.example/\n" })
    ),
    { kind: "url", value: "https://internal.example/" },
    "text/x-moz-text-internal 也能识别"
  );

  console.log("");
  console.log("场景 3：纯文本的判定 —— 链接 / 裸域名 / 搜索词");
  assertDeepEqual(
    dropped.parseDroppedItem(fakeDataTransfer({ "text/plain": "https://plain.example/x" })),
    { kind: "url", value: "https://plain.example/x" },
    "带协议头 → 链接"
  );
  assertDeepEqual(
    dropped.parseDroppedItem(fakeDataTransfer({ "text/plain": "example.com/a?b=1" })),
    { kind: "url", value: "http://example.com/a?b=1" },
    "裸域名 → 补 http:// 当链接"
  );
  assertDeepEqual(
    dropped.parseDroppedItem(fakeDataTransfer({ "text/plain": "子域名.example.co.jp" })),
    { kind: "url", value: "http://子域名.example.co.jp" },
    "多级域名也补 http://"
  );
  assertDeepEqual(
    dropped.parseDroppedItem(fakeDataTransfer({ "text/plain": "怎么修 tabs.discard" })),
    { kind: "query", value: "怎么修 tabs.discard" },
    "普通文本 → 搜索词"
  );
  assertDeepEqual(
    dropped.parseDroppedItem(fakeDataTransfer({ "text/plain": "第一行\n第二行\n" })),
    { kind: "query", value: "第一行" },
    "多行只取第一行"
  );

  console.log("");
  console.log("场景 4：不安全的协议被忽略，且不回退到低优先级类型");
  assertEqual(
    dropped.parseDroppedItem(fakeDataTransfer({ "text/uri-list": "javascript:alert(1)" })),
    null,
    "javascript: 被丢弃"
  );
  assertEqual(
    dropped.parseDroppedItem(fakeDataTransfer({ "text/plain": " data:text/html,<b>x</b>" })),
    null,
    "data: 被丢弃"
  );
  assertEqual(
    dropped.parseDroppedItem(
      fakeDataTransfer({
        "text/uri-list": "javascript:alert(1)",
        "text/plain": "javascript:alert(1)",
      })
    ),
    null,
    "同一段内容不会因为回退而被当成搜索词打开"
  );
  assertEqual(dropped.parseDroppedItem(null), null, "没有 DataTransfer 时返回 null");
  assertEqual(
    dropped.parseDroppedItem({
      types: ["text/plain"],
      getData() {
        throw new Error("drop 事件已经结束");
      },
    }),
    null,
    "getData 抛错时不崩溃"
  );

  console.log("");
  console.log("场景 5：只有携带文本/链接类型才算外部拖放");
  assertEqual(
    dropped.isExternalDropData({ types: ["text/plain"] }),
    true,
    "text/plain 算外部拖放"
  );
  assertEqual(
    dropped.isExternalDropData({ types: ["text/uri-list", "text/html"] }),
    true,
    "uri-list 算外部拖放"
  );
  assertEqual(
    dropped.isExternalDropData({ types: ["application/x-treestyletab-drag-data"] }),
    false,
    "其它扩展的私有类型不算"
  );
  assertEqual(dropped.isExternalDropData({}), false, "没有 types 时不算");
  assertEqual(dropped.isExternalDropData(null), false, "null 不算");

  console.log("");
  console.log("场景 6：树区域落点 → 后台布局意图");
  assertDeepEqual(
    dropped.buildTreeDropPayload(12, 3, "child"),
    { replaceTabId: 12 },
    "行中间 → 覆盖该标签"
  );
  assertDeepEqual(
    dropped.buildTreeDropPayload(12, 3, "before"),
    { parentId: 3, beforeTabId: 12 },
    "行上 1/4 → 插在该行之前，父取该行的父"
  );
  assertDeepEqual(
    dropped.buildTreeDropPayload(12, null, "after"),
    { parentId: null, afterTabId: 12 },
    "行下 1/4 → 插在该行之后，顶层"
  );
  assertDeepEqual(
    dropped.buildAppendDropPayload(20, 7),
    { parentId: 7, afterTabId: 20 },
    "空白处 → 追加到最后一个可见行之后"
  );
  assertDeepEqual(
    dropped.buildAppendDropPayload(null, null),
    { parentId: null },
    "没有可见行 → 新建顶层"
  );

  console.log("");
  console.log("场景 7：固定标签区左右 1/4 插入、中间 1/2 覆盖");
  assertEqual(dropped.resolvePinnedDropPosition(105, { left: 100, width: 28 }), "before", "左 1/4");
  assertEqual(dropped.resolvePinnedDropPosition(114, { left: 100, width: 28 }), "overwrite", "中间");
  assertEqual(dropped.resolvePinnedDropPosition(127, { left: 100, width: 28 }), "after", "右 1/4");
  assertEqual(
    dropped.resolvePinnedDropPosition(110, { left: 100, width: 0 }),
    "overwrite",
    "取不到宽度时退化为覆盖"
  );
  assertDeepEqual(
    dropped.buildPinnedDropPayload(
      { tabId: 5, windowId: 10, isCurrentWindow: true },
      "before"
    ),
    { windowId: 10, pinned: true, beforeTabId: 5 },
    "本窗口 → 新建固定标签插到前面"
  );
  assertDeepEqual(
    dropped.buildPinnedDropPayload(
      { tabId: 5, windowId: 10, isCurrentWindow: true },
      "after"
    ),
    { windowId: 10, pinned: true, afterTabId: 5 },
    "本窗口 → 新建固定标签插到后面"
  );
  assertDeepEqual(
    dropped.buildPinnedDropPayload(
      { tabId: 5, windowId: 20, isCurrentWindow: false },
      "overwrite"
    ),
    { replaceTabId: 5 },
    "其它窗口的固定标签允许覆盖"
  );
  assertEqual(
    dropped.buildPinnedDropPayload(
      { tabId: 5, windowId: 20, isCurrentWindow: false },
      "before"
    ),
    null,
    "其它窗口的固定标签不允许插入"
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
