# Firefox（AMO）发布清单

本文件记录把 Nesoi 标签管理器发布到 addons.mozilla.org（AMO）所需的清单字段、提交材料与审核注意点。
纯构建/打包流程见 `docs/build.md`，提交给审核员的源码包说明见 `docs/source_build.md`。

## 1. 清单字段（已实现）

Firefox 目标清单由 `scripts/write-manifest.mjs` 从根目录 `manifest.json` 派生，除 Chrome 版差异外还包含：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `browser_specific_settings.gecko.id` | `nesoi-tab-manager@lingsamuel.github.io` | MV3 签名必需；**上架后不可更改**，换 ID 等于换一个全新扩展 |
| `browser_specific_settings.gecko.strict_min_version` | `140.0` | 见第 2 节 |
| `browser_specific_settings.gecko.data_collection_permissions` | `{ required: ["none"], optional: ["browsingActivity", "websiteContent"] }` | 见第 3 节 |
| `sidebar_action` | `ui/sidebar.html` | Firefox 原生侧边栏 |
| `permissions` | 基础权限 + `menus.overrideContext` | Firefox 专有权限，用于在标签栏右键菜单渲染自建菜单项 |
| `background.scripts` + `type: "module"` | 单文件 ESM | Firefox 不支持 MV3 `service_worker`（Firefox bug 1573659） |
| `icons` / `action.default_icon` | `icons/icon-{16,32,48,96,128}.png` | 两个浏览器共用，源文件 `icons/icon.svg` |

## 2. 为什么最低版本是 140

Firefox 140 起才有浏览器内置的「数据收集与传输同意」体验。按 AMO 政策：

- **6.2.1**：只兼容 Firefox 140+ 且使用内置同意体验 → 只需在清单中如实声明数据实践。
- **6.2.2**：兼容 139 及更早、或不使用内置同意体验 → 必须自己实现"安装后立即出现、不可忽略、单页、
  同时给出接受/拒绝及其后果"的数据传输同意流程。

因此把 `strict_min_version` 定为 140.0 是合规成本最低的路径。
（Firefox 115 ESR 已于 2025 年 9 月结束支持，实际覆盖面损失很小。）

## 3. 数据声明：required 为什么是 none

按 Mozilla 的数据分类（Firefox add-on data classification taxonomy）：

- 扩展自身**不收集也不传输任何数据**：没有账号、遥测、统计或开发者服务器。
- 唯一的对外请求来自可选的「AI 分组」：由用户自行配置端点/Key/模型，并在**点击按钮**后才把
  所选标签页的标题、基础域名、打开顺序（以及可选的已有列表标题/描述）POST 给该端点。
  - 域名/URL → `browsingActivity`
  - 页面标题、列表标题/描述 → `websiteContent`

这两个分类放在 `optional` 而不是 `required`：不用 AI 的用户在安装时不应被数据提示打扰，
而一旦放进 `required`，所有用户都必须接受才能安装。

授权时机在用户点击「AI 分组」时：`src/manager/utils/data_collection.js` 在用户手势内同步调用
`chrome.permissions.request({ data_collection })`，被拒绝则中止，不外发任何内容。
Chrome 与 Firefox <140 没有该机制，`request()` 会报错，代码按"由商店页面与隐私政策披露"处理，不阻断功能。

> 注意：`permissions.request` 必须在用户输入处理器中**同步**调用，因此 `runAiGrouping()` 里
> 这一句之前不能插入任何 `await`，改动该函数时不要破坏这个前提。

### 提交前自查

```bash
npm run build:firefox
npx --yes web-ext lint --source-dir dist/firefox
```

期望结果：`0 errors`；`MISSING_DATA_COLLECTION_PERMISSIONS` 警告消失。
以下两条 warning 属于预期，无需处理：

- `UNSAFE_VAR_ASSIGNMENT`（`ui/assets/tree_core-*.js`）：Vue runtime-dom 内部对 `innerHTML` 的赋值，
  压缩产物上的静态误报；本扩展自己的 DOM 文本一律走 `textContent`（见 `popup.js` 的 `appendSubItemContent`），
  已在 `docs/source_build.md` 中向审核员说明。
- `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`：`data_collection_permissions` 需要 Firefox for
  Android 142+，而 `gecko` 的 `strict_min_version` 是 140。本扩展**不发布 Android 版**
  （清单未声明 `gecko_android`，默认只在桌面 Firefox 提供），因此该提示可忽略；
  若将来要上 Android，需要把 `gecko_android.strict_min_version` 设为 `142.0` 并单独测试。

## 4. 必须随版本上传的源码包

AMO 政策 3.1：代码经过压缩/打包（本项目用 Vite 压缩 UI、esbuild 打包后台）时，
每个版本都必须附带可复现构建的源码包与构建说明。

```bash
npm run package:source   # 生成 dist/nesoi-tab-manager-source-<version>.zip
```

压缩包根层直接是源码 + `README_BUILD.md`（内容来自 `docs/source_build.md`），
不包含 `ui/`、`dist/`、`node_modules` 等产物。上传位置：AMO 版本页底部的 **Source code**。

## 5. 商品页（listing）材料

| 项目 | 建议内容 |
| --- | --- |
| 名称 | `Nesoi 标签管理器`（不在名称中使用 "Firefox"，避免商标命名规范） |
| 摘要（≤250 字符） | 管理海量标签页：树状展示、保存为列表、AI 分组、原生侧边栏，数据全部留在本地。 |
| 分类 | Tabs |
| 许可证 | MIT（见根目录 `LICENSE`） |
| 图标 | 上传 `icons/icon-128.png`（列表页另需 32×32 / 64×64，可用同目录 `icon-32.png` / `icon-64.png`） |
| 截图 | 至少 1 张，建议 1280×800：管理页（树状视图）、保存的列表、Firefox 侧边栏、设置页 |
| 隐私政策 | 粘贴 `docs/privacy_policy.md` 的内容 |
| 支持渠道 | 填写支持站点或支持邮箱（本仓库不再维护联系邮箱，建议用项目 issue 页） |
| 关键词 | 标签页管理、tab manager、tree tabs、会话保存、侧边栏 |
| 测试说明（Notes to reviewer） | 见第 6 节 |

## 6. 给审核员的测试说明（可直接粘贴）

- 点击工具栏图标会在新标签页打开管理界面（不弹小窗口）。
- 「打开的窗口」默认树状视图；「保存的列表」用于会话保存；两者都在左上角子侧边栏切换。
- Firefox 专属：`about:debugging` 之外无需特殊设置；右键标签栏可见自建菜单项
  （刷新/固定/静音/冻结/复制链接/移动到窗口），由原生菜单控件渲染，依赖 `menus.overrideContext`。
- Firefox 侧边栏：视图 → 侧边栏 → Nesoi 标签侧边栏。
- **AI 分组需要凭证**：设置页需填入 API 端点、Key 与模型。若审核不便使用真实 Key，
  可跳过该功能——它不影响其余功能的验收；点击「AI 分组」时会先弹出 Firefox 的数据传输授权提示。
- 全部列表数据存放于 `chrome.storage.local`，不会写日志、不会外发。
- 无需任何测试账号。

### 审核员可能追问的权限用途

| 声明 | 为什么必需 |
| --- | --- |
| `host_permissions: <all_urls>` + 内容脚本（`document_idle`） | 内容脚本只创建本扩展自己的悬浮组件与提醒气泡；页面浮层的「近期标签页」面板用 iframe 加载 `ui/manager.html?mode=overlay`，因此该文件与 `ui/assets/*` 需要 `web_accessible_resources`（`<all_urls>`）。除此之外不读取、不修改页面内容。 |
| `permissions: tabs` | 列出/保存/移动/冻结/关闭标签页的核心能力。 |
| `permissions: storage` | 列表、标签树、设置全部存本机。 |
| `permissions: contextMenus` + `menus.overrideContext` | 网页右键「保存到列表」与 Firefox 标签栏右键菜单；`overrideContext` 用于把上下文切到 `tab`，让自建菜单项出现在原生标签菜单中。 |
| `permissions: alarms` | 近期标签页提醒的定时检查。 |
| `sidebar_action` | Firefox 原生标签树侧边栏。 |
| `data_collection_permissions.optional` | 仅用于用户主动触发的 AI 分组外发，见第 3 节。 |

## 7. 提交步骤

1. `npm run build`（确认 `npm run test:tree` 全绿）。
2. `npx --yes web-ext lint --source-dir dist/firefox` 无 error。
3. 上传 `dist/nesoi-tab-manager-firefox-<version>.zip` 到 AMO。
4. 在版本页上传 `npm run package:source` 生成的源码包。
5. 填写第 5 节材料，勾选平台为 **Firefox（桌面）**（未声明 `gecko_android`，不发布 Android 版）。
6. 提交后关注审核反馈；若被要求说明某项权限，引用 `docs/privacy_policy.md` 第 4 节的权限用途表。

## 8. 版本与合规提醒

- 任何版本都要上传源码包，不要遗漏。
- 若将来新增数据传输（例如云端同步），必须同步修改 `data_collection_permissions`，
  否则安装/升级提示与实际行为不符，可能按 "No Surprises" 规则下架。
- 扩展 ID 一旦发布不可更改；若要更换发布者身份，需要新建 listing。
