# GitHub Actions 自动发布流程

本文件说明如何通过推送标签，由 GitHub Actions 自动构建并创建带发布包的 GitHub Release。
构建与打包命令本身的语义见 `docs/build.md`，AMO 商店侧的清单要求见 `docs/publish_firefox.md`。

## 1. 目标与非目标

### 1.1 目标

1. 推送形如 `v0.2.12` 的标签后，自动完成校验、回归测试、双浏览器构建与打包。
2. 自动创建对应标签的 GitHub Release，并附加三个发布包：Chrome/Edge zip、Firefox zip、AMO 源码包。
3. 发布前拦截版本号不一致、测试失败、Firefox 清单不合规这三类问题，避免把错误产物发出去。

### 1.2 非目标

1. 不自动上传到 Chrome Web Store 或 AMO，商店上传仍按人工流程进行。
2. 不回写仓库内容（不提交 `dist/`、不改版本号、不创建 commit）。
3. 不构建/发布 `ui/` 之外的额外渠道包（无 beta、nightly 等预发布通道）。

## 2. 触发方式与版本号规则

| 项目 | 约定 |
| --- | --- |
| 触发条件 | 推送匹配 `v*` 的标签（`on.push.tags`） |
| 标签格式 | `v<version>`，例如 `v0.2.12`；`v` 前缀必需 |
| 版本号一致性 | 标签去掉 `v` 后必须与 `package.json` 的 `version`、`manifest.json` 的 `version` 完全相同 |
| 发布前准备 | 先在 master 上 bump 版本号并提交（见 `AGENTS.md` 的版本号规则），再在该提交上打标签推送 |

一致性校验失败时工作流立即终止，不会创建 Release。

## 3. 工作流步骤

工作流文件为 `.github/workflows/release.yml`，单个 `release` 任务顺序执行：

1. 检出触发标签对应的提交（`actions/checkout`）。
2. 安装 Node.js 并启用 npm 缓存（`actions/setup-node`）。
3. `npm ci`：按 `package-lock.json` 安装依赖，保证与本地锁文件一致。
4. 校验版本号：`github.ref_name` 去掉 `v` 后与 `package.json`、`manifest.json` 的 `version` 逐一比对。
5. `npm run test:tree`：全量树状结构回归测试（纯 Node，无需浏览器）。
6. `npm run build`：Vite 构建 UI，产出 `dist/chrome`、`dist/firefox` 与两个浏览器 zip。
7. `npm run package:source`：产出提交给 AMO 审核的源码包。
8. `npx --yes web-ext lint --source-dir dist/firefox`：Firefox 清单与代码静态检查，出现 error 即失败
   （warning 按 `docs/publish_firefox.md` 的判断放行）。
9. `gh release create`：以标签名创建 Release，`--generate-notes` 自动生成变更说明，并附加第 6、7 步的三个 zip。

顺序上把校验与测试放在构建之前：任何一步失败都不会产生半成品 Release。

## 4. 产物清单

Release 附件固定为以下三个文件（版本号取自 `package.json`）：

| 文件 | 用途 |
| --- | --- |
| `nesoi-tab-manager-chrome-<version>.zip` | Chrome/Edge 侧载与商店上传 |
| `nesoi-tab-manager-firefox-<version>.zip` | Firefox 临时加载与 AMO 上传 |
| `nesoi-tab-manager-source-<version>.zip` | AMO 审核必需的源码包 |

解压后根层直接是扩展文件，不含多余顶层目录；`dist/` 下的构建产物本身不进入 Release。

## 5. 权限与 Secrets

- 权限仅需 `contents: write`，用于创建 Release 与上传附件；其余权限显式设为只读。
- 使用工作流内置的 `GITHUB_TOKEN`，不需要额外配置 Secret。
- 因为不自动上传商店，所以不涉及 AMO / Chrome Web Store 的 API 凭据。

## 6. 失败处理与重新发布

1. 校验、测试或 lint 失败：修复后在 master 上重新 bump 版本号，再推新标签；
   或修复后删除旧标签（本地 `git tag -d` + `git push origin :refs/tags/<tag>`）后重新推送同一标签。
2. Release 已存在：`gh release create` 会直接失败，不会覆盖已发布内容。确认需要重发时，
   先在 GitHub 上删除该 Release 与标签，再重新推送标签。
3. 需要不发 Release、只验证构建链路时，可在本地执行第 5～8 步命令，无需推送标签。

## 7. 发布后的人工步骤

1. 打开 Draft/Release 页面核对自动生成的变更说明，必要时手工补充。
2. 从 Release 附件下载 Chrome zip 上传 Chrome Web Store，下载 Firefox zip 与源码包提交 AMO。
3. 确认商店审核通过后，再把 Release 对外宣传。

## 8. 验收标准

1. 推送 `v<version>` 标签后工作流自动运行，无需人工点击。
2. 版本号不一致、`npm run test:tree` 失败、`web-ext lint` 报 error 三种情况下工作流失败且不创建 Release。
3. 成功时 Release 标题/标签与推送标签一致，附件恰为第 4 节列出的三个 zip，且文件名中的版本号与标签一致。
4. 工作流不产生任何向仓库回写的提交。

## 9. 参考资料

1. GitHub Actions 触发条件（`on.push.tags`）：https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#push
2. `gh release create`：https://cli.github.com/manual/gh_release_create
3. `actions/setup-node`：https://github.com/actions/setup-node
4. `web-ext lint`：https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-lint
