# 双浏览器构建与打包方案

## 1. 背景与目标

当前项目最初仅面向 Chrome/Edge（Manifest V3 + `background.service_worker`）。本方案在保持现有行为不变的前提下，让一次 `npm run build` 同时产出 Chrome 与 Firefox 两套可加载产物及发布 zip。

### 1.1 目标

1. 生成 `dist/chrome/` 与 `dist/firefox/` 两套可直接加载的目录产物。
2. 生成 `dist/nesoi-tab-manager-chrome-<version>.zip` 与 `dist/nesoi-tab-manager-firefox-<version>.zip` 两个发布包。
3. `npm run build` 一键完成 UI 构建、双浏览器后台打包、manifest 分流与 zip 打包。

### 1.2 非目标

1. 不修改扩展运行时功能与权限。
2. 不引入平台 API 抽象层（现有 `chrome.*` 回调写法在 Firefox 的 `chrome` 命名空间下兼容）。
3. 不包含 AMO 商店后台运营资料填写。

## 2. 兼容性口径

### 2.1 浏览器差异

| 维度 | Chrome/Edge | Firefox |
| --- | --- | --- |
| 后台声明 | `background.service_worker` + `type: "module"` | `background.scripts` + `type: "module"`（event page） |
| 后台代码 | ES Module 源码（多文件） | esbuild 打包后的单文件 |
| 侧边栏 | 无（本次不做 `sidePanel`） | `sidebar_action.default_panel = ui/sidebar.html` |
| 扩展 ID | 无要求 | `browser_specific_settings.gecko.id` |
| 最低版本 | 无 | `strict_min_version: "115.0"` |

### 2.2 关键事实与约束

1. Firefox 不支持 MV3 的 `background.service_worker`（参见 Firefox bug 1573659）；Firefox 121+ 会忽略该键并回退到 `background.scripts`。因此 Firefox 产物使用 event page 声明。
2. Firefox event page 支持 `type: "module"`，可直接加载 ES Module 打包产物。
3. `chrome.storage.session` 为 Chrome 专有能力，代码中已有 `HAS_SESSION_STORAGE` 守卫，Firefox 下自动降级为空实现（近期标签、自动冻结的会话状态退化为启动时重算）。
4. 业务代码全部使用 `chrome.*` 回调风格，Firefox 的 `chrome` 命名空间支持回调，无需改动业务代码。

## 3. 产物结构

执行 `npm run build` 后：

```
dist/
├── chrome/                          # Chrome/Edge 直接加载目录
│   ├── manifest.json                # service_worker + type: module
│   ├── background.js                # 源码（ES Module）
│   ├── background/                  # 后台子模块源码
│   ├── content_script.js
│   ├── popup.html / popup.css / popup.js
│   ├── ui/                          # Vite 构建的管理界面
│   │   ├── manager.html             # 管理页
│   │   └── sidebar.html             # 侧边栏（仅 Firefox 清单引用）
│   └── ...
├── firefox/                         # Firefox 直接加载目录
│   ├── manifest.json                # scripts + type: module + gecko.id + sidebar_action
│   ├── background.js                # esbuild 打包后的单文件
│   └── （其余文件同 Chrome）
├── nesoi-tab-manager-chrome-<version>.zip
└── nesoi-tab-manager-firefox-<version>.zip
```

zip 内部直接包含扩展文件本身（`manifest.json`、`background.js` 等），不包含额外顶层目录。本地 `dist/` 最多保留最近 3 个版本的 zip，按版本整组删除。

## 4. 构建流程

### 4.1 命令

```bash
npm run build          # 一键构建两套产物 + zip
npm run build:chrome   # 仅构建 Chrome 目录产物
npm run build:firefox  # 仅构建 Firefox 目录产物
npm run test:tree      # 树状结构回归测试（后台事件链路 + 管理页行构建，纯 Node，无需浏览器）
npm run bench:tree     # 树算法 10K 级性能基准（含阈值校验）
```

### 4.2 步骤分解

1. Vite 构建界面（`src/manager`）输出到 `ui/`，包含 `manager.html` 与 `sidebar.html` 两个入口（共用同一份 JS/CSS chunk）。
2. Chrome 产物：复制后台源码（`background.js` + `background/`）、popup、content script 与 `ui/`，写入原样 manifest。
3. Firefox 产物：esbuild 将 `background.js` 及其子模块打包为单文件 ESM，复制其余静态文件，写入 Firefox 适配 manifest（`background.scripts` + `gecko.id` + `sidebar_action` 等）。
4. 进入各产物目录执行 `zip` 打包，输出到 `dist/` 根目录。
5. 清理超出保留数量的历史 zip。

### 4.3 脚本职责

- `scripts/write-manifest.mjs`：读取 `manifest.json` 基础清单，按目标生成 `dist/<target>/manifest.json`。
- `scripts/package-builds.mjs`：读取 `package.json` 版本号，打包两个 zip，并清理历史包。
- `scripts/build.mjs`：串联 UI 构建、产物组装、manifest 写入与打包。
- `scripts/bench_tree.mjs` / `scripts/test_tree.mjs` / `scripts/test_tree_ui.mjs` / `scripts/test_sidebar_pinned.mjs`：树状与固定标签功能的基准与回归测试，不参与产物构建。

## 5. 验收标准

1. `npm run build` 成功生成 `dist/chrome`、`dist/firefox` 及两个 zip。
2. Chrome/Edge 可加载 `dist/chrome` 并保持现有功能。
3. Firefox（115+）可在 `about:debugging` 加载 `dist/firefox`。
4. 任一 zip 解压后根层直接包含扩展文件。
5. 历史 zip 超出 3 个版本时，下一次构建自动删除更早版本。
6. `ui/` 同时产出 `manager.html` 与 `sidebar.html`；`dist/firefox/manifest.json` 含 `sidebar_action`，`dist/chrome/manifest.json` 不含（Chrome 无该键）。

## 6. 参考资料

1. MDN `background`：https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
2. MDN `browser_specific_settings`：https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
