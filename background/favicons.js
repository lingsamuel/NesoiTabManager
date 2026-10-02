// 列表 favicon 去重：全局图标表 + 内容指纹。
//
// 背景：保存列表时每个条目都会带上当时的 `tab.favIconUrl`，而实测它主要是
// `data:image/...;base64,...`——同一张图标被逐条完整重复写进 `storage.local`，
// 几十个同站点标签页就能吃掉可观的配额（扩展没有申请 unlimitedStorage）。
//
// 做法：条目只保留一个短键 `iconKey`，图标数据集中在 `favIcons` 表里按 key 只存一份。
// 本模块是**纯逻辑**（不依赖 chrome API），因此在 Node 里可以直接单测；
// 真正的读写由 background/lists.js 的写盘路径与读取出口负责。
//
// 详细设计见 docs/data/favicon_dedup.md。

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a 64 位哈希，输出 16 位十六进制。
 *
 * 用途：给 `data:` 图标算"内容指纹"，让同一张图片无论出现在哪个站点都只占表里的一条。
 * 它是**去重指纹而不是安全哈希**：碰撞只意味着两个不同图标被当成同一张，概率在图标数量级下可忽略。
 * 用 BigInt 实现是为了跨浏览器结果一致（普通 number 会在 2^53 之后丢精度，得到平台相关的值）。
 */
function fnv1a64Hex(text) {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** 去掉 URL 的 fragment。保留 query：部分站点的图标 URL 用 query 区分版本（如 `?v=3`）。 */
function stripFragment(url) {
  const index = url.indexOf("#");
  return index >= 0 ? url.slice(0, index) : url;
}

/** 取绝对 URL 的 origin（协议+主机+端口）；不是绝对 URL（或非特殊协议）时返回空串。 */
function safeOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin && parsed.origin !== "null" ? parsed.origin : "";
  } catch (error) {
    return "";
  }
}

/**
 * 计算一个 favIconUrl 的图标键。
 *
 * 规则（决定去重粒度，必须保证"不同子域名各自独立"）：
 * - 空 → `""`（不写表项）；
 * - `data:...` → `d:<内容指纹>`：按图片内容去重，同一张图跨站点也只存一份；
 * - `page-icon:<pageUrl>` → `p:<pageUrl 的 origin>`：Firefox 给出的是这种"带页面地址"的形态，
 *   同一站点的每个页面都会得到不同的字符串，但图标是同一张，因此归一到 origin；
 *   origin 含完整主机名，所以 `a.example.com` 与 `b.example.com` 是两个 key；
 * - 其它 → `u:<去掉 fragment 的 URL>`：同一图标 URL 只存一份，子域名/CDN 路径天然分开。
 *
 * @param {string} favIconUrl chrome.tabs.Tab.favIconUrl（可为空）
 * @returns {string} 图标键；无图标时为空字符串
 */
function computeIconKey(favIconUrl) {
  const url = favIconUrl ? String(favIconUrl) : "";
  if (!url) {
    return "";
  }
  if (url.startsWith("data:")) {
    return `d:${fnv1a64Hex(url)}`;
  }
  if (url.startsWith("page-icon:")) {
    const origin = safeOrigin(url.slice("page-icon:".length));
    // 内层不是绝对 URL 时不猜：退回按原字符串去重，至少不会把两个不同的东西并成一个。
    return origin ? `p:${origin}` : `u:${stripFragment(url)}`;
  }
  return `u:${stripFragment(url)}`;
}

/** 带记忆化的 computeIconKey：一次写盘里有大量重复 favIconUrl（同站点多标签），避免反复哈希。 */
function iconKeyOf(favIconUrl, cache) {
  const url = favIconUrl ? String(favIconUrl) : "";
  if (!url) {
    return "";
  }
  if (cache.has(url)) {
    return cache.get(url);
  }
  const key = computeIconKey(url);
  cache.set(url, key);
  return key;
}

/**
 * 归一化一个条目：把 `favIconUrl` 换算成 `iconKey` 并登记进图标表。
 *
 * @param {object} item 落盘条目（可能是带 favIconUrl 的旧结构）
 * @param {object} icons 图标表（就地写入，同 key 后写覆盖 → 站点换图标时以最新一次保存为准）
 * @param {Map<string,string>} cache favIconUrl → iconKey 的记忆化表
 * @param {Set<string>} referenced 本次归一化引用到的 key（用于裁剪表）
 */
function normalizeItem(item, icons, cache, referenced) {
  const next = { ...(item || {}) };
  const rawFavicon = item && item.favIconUrl ? String(item.favIconUrl) : "";
  let key = "";
  if (rawFavicon) {
    // 有原始 URL 时一律以它为准：导入的旧文件、保存时抓到的值都走这里，
    // 即使条目里同时带着一个（可能来自别的机器的）iconKey 也能自愈。
    key = iconKeyOf(rawFavicon, cache);
    icons[key] = rawFavicon;
  } else if (item && item.iconKey) {
    key = String(item.iconKey);
  }
  delete next.favIconUrl;
  // 表里解析不到的 key 没有意义（渲染只会得到占位图），顺手清掉，避免脏键长期占位。
  next.iconKey = key && icons[key] ? key : "";
  if (next.iconKey) {
    referenced.add(next.iconKey);
  }
  return next;
}

/**
 * 写盘前的归一化：把全部列表条目转成 `iconKey` 形式，并裁剪图标表。
 *
 * 这是"懒迁移"的落点：旧数据里的 `favIconUrl` 在下一次任何列表写操作时被自动转换。
 * 同时完成 GC：裁剪掉不再被任何条目引用的表项（删除列表/条目/覆盖导入后不留孤儿）。
 * 返回的两个对象要由调用方在**同一次 storageSet** 中写出，避免"列表已写、表未写"的中间态。
 *
 * @param {Array} lists 即将落盘的列表（原始结构，可含 favIconUrl）
 * @param {object} storedIcons 当前图标表
 * @returns {{lists: Array, favIcons: object}}
 */
function normalizeListsForWrite(lists, storedIcons) {
  const source = Array.isArray(lists) ? lists : [];
  const icons = storedIcons && typeof storedIcons === "object" ? { ...storedIcons } : {};
  const cache = new Map();
  const referenced = new Set();

  const nextLists = source.map((list) => {
    const items = list && Array.isArray(list.items) ? list.items : [];
    return {
      ...(list || {}),
      items: items.map((item) => normalizeItem(item, icons, cache, referenced)),
    };
  });

  const favIcons = {};
  referenced.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(icons, key) && icons[key]) {
      favIcons[key] = icons[key];
    }
  });

  return { lists: nextLists, favIcons };
}

/**
 * 判断列表里是否还有"旧结构"条目（带 `favIconUrl` 字段的落盘形态）。
 *
 * 用途：启动/更新时决定要不要做一次幂等的落盘迁移。归一化之后的条目只有 `iconKey`、
 * 完全没有 `favIconUrl` 字段，因此这里用"字段是否存在"判断，而不是"值是否为空"——
 * 后者会把"本来就没有图标"的条目永远当成待迁移，每次启动都白写一遍。
 */
function listsNeedMigration(lists) {
  const source = Array.isArray(lists) ? lists : [];
  return source.some((list) => {
    const items = list && Array.isArray(list.items) ? list.items : [];
    return items.some((item) => item && Object.prototype.hasOwnProperty.call(item, "favIconUrl"));
  });
}

/** 解析单个条目要展示的图标地址：优先 iconKey，解析不到再兼容懒迁移前的 favIconUrl。 */
function resolveItemFavicon(item, icons) {
  const key = item && item.iconKey ? String(item.iconKey) : "";
  if (key && icons && Object.prototype.hasOwnProperty.call(icons, key)) {
    return icons[key] ? String(icons[key]) : "";
  }
  return item && item.favIconUrl ? String(item.favIconUrl) : "";
}

/**
 * 读取出口的解析：把条目里的 `iconKey` 换回 `favIconUrl`，并删除 `iconKey`。
 *
 * 目的是让渲染类调用方（管理页、弹窗）看到的结构与去重前完全一致，前端渲染代码不需要改动。
 * **不能用于导出**：逐条展开会把同一个图标按条目数重复 N 份，导出必须走"图标表 + 引用"的紧凑结构。
 * **只能用于返回给 UI 的路径**：把解析结果回写存储会丢失 key、把去重成果全部作废。
 */
function resolveLists(lists, icons) {
  const source = Array.isArray(lists) ? lists : [];
  return source.map((list) => {
    const items = list && Array.isArray(list.items) ? list.items : [];
    return {
      ...(list || {}),
      items: items.map((item) => {
        const next = { ...(item || {}) };
        delete next.iconKey;
        next.favIconUrl = resolveItemFavicon(item, icons);
        return next;
      }),
    };
  });
}

export {
  computeIconKey,
  listsNeedMigration,
  normalizeListsForWrite,
  resolveItemFavicon,
  resolveLists,
};
