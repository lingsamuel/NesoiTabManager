# Nesoi 标签管理器

一个用于管理海量标签页的 Chrome/Edge 与 Firefox 扩展。

## 需求

- 读取所有窗口与标签页。
- 可勾选多个标签页保存到列表。
- 支持保存到已有列表或新建列表。
- 保存时可选择关闭标签页。
- 支持导入、导出已保存的标签页。
- 支持重命名/删除列表，以及删除列表内的标签。
- 列表支持可选描述，用于指导 AI 分组。
- 支持直接关闭单个或已选标签页，并可点击跳转到对应标签页。
- 点击扩展按钮在新标签页打开管理界面，避免弹窗过小。
- 网页右键菜单提供：
  - 保存到某个列表
  - 关闭并保存到某个列表
- 网页左下角悬浮组件：
  - 鼠标划过向上展开已有列表
  - 一键保存或关闭并保存当前页面
- AI 辅助分组（手动触发）：
  - 发送标签页标题与基础域名，结合打开顺序生成标签
  - 标签展示在标签页列表旁，可一键应用生成新列表（不影响原列表）
- 树状标签页（参考 Tree Style Tab）：
  - 「打开的窗口」视图支持树状 / 平铺切换，默认树状
  - 展示标签页的父子层级，支持折叠子树
  - 支持在管理页拖拽改变父子关系（上/下 1/4 → 兄弟，中间 → 子标签），被拖标签的整棵子树一起移动
  - 树结构持久化到 `chrome.storage.local`，跨浏览器重启尽力恢复
  - 面向 10K 级标签页设计：无 O(n²) 算法、启动静默期不加载不写盘、脏窗口空闲防抖落盘
- Firefox 标签右键菜单（仅 Firefox）：刷新 / 固定(取消固定) / 静音(取消静音) / 冻结 / 复制链接 / 移动到窗口▸，
  由 Firefox 原生菜单控件渲染，并同样出现在浏览器自带标签栏的右键菜单里。
- Firefox 原生侧边栏（仅 Firefox，`sidebar_action`）：
  - 常驻显示当前窗口的标签树，实时跟随标签增删与移动
  - 支持折叠、搜索过滤/跳转、拖拽改父子
  - 底部固定「新建标签页」按钮：在窗口末尾新建顶层标签页（与工具栏 `＋` 的"挂在当前标签下"是两种有意的不同行为）
  - 滚动条位于侧边栏左侧，并在轨道上标记当前标签页位置（点击刻度可跳转）与搜索匹配项；
    刻度过密时自动合并，管理页的轨道还会标出每个窗口的活动标签
  - 列表会自动跟随当前标签页：打开侧边栏、以及切换标签（旧标签仍在视野里）时把活动标签滚到视口中间
  - 「过滤 / 跳转」模式作为全局偏好持久化
  - 窗口关闭或侧边栏关闭即卸载，不常驻、不增加启动开销
- 管理界面采用侧边栏分区：打开的窗口、保存的列表、插件设置；前两者提供子侧边栏快速切换。
- 管理界面使用 Vue 渲染，并使用虚拟列表支撑海量标签页与列表。
- 交互文案统一使用中文。

## 实现说明

- Manifest V3：Chrome/Edge 后台使用 service worker，Firefox 使用 event page（构建时自动适配）。
- 使用 `chrome.tabs`、`chrome.storage`、`chrome.contextMenus`。
- 列表数据存放在 `chrome.storage.local`。
- `chrome.storage.session` 为 Chrome 专有能力，Firefox 下自动降级。
- UI 构建使用 Vite + Vue，输出到 `ui/` 目录。
- AI 分组需要在“插件设置”里配置完整 API 端点、Key、模型、API 格式与单次上限。
- 列表描述会在启用“发送已有列表标题/描述作为参考”时一并发送给 AI。
- 树状标签页不新增任何浏览器权限，也不在非用户操作时移动标签页。
- Firefox 侧边栏使用 `sidebar_action`（Firefox 专有清单键），Chrome 目标清单不受影响。
- Firefox 标签右键菜单需要专有权限 `menus.overrideContext`，只加在 Firefox 目标清单；Chrome 清单的权限保持不变。
- Firefox 目标最低版本为 140：该版本起浏览器内置「数据收集与传输同意」体验，可以只靠清单声明完成合规。
- 数据声明为 `required: ["none"]` + `optional: ["browsingActivity", "websiteContent"]`：
  扩展默认不传输任何数据，只有用户自行配置端点并点击「AI 分组」时才外发标签标题与基础域名，
  且会先弹出 Firefox 的数据传输授权；被拒绝则不外发。
- 图标源文件为 `icons/icon.svg`，PNG 已提交（两个浏览器共用同一套）。
- 许可证为 MIT，隐私政策见 `docs/privacy_policy.md`。

## 开发与构建

- 安装依赖：`npm install`
- 一键构建：`npm run build`（同时生成 Chrome 与 Firefox 两套产物及 zip）
- 单独构建：`npm run build:chrome` / `npm run build:firefox`
- 重新导出图标：`npm run icons`（需要 `rsvg-convert`；PNG 已提交，普通构建无需执行）
- AMO 源码包：`npm run package:source`（每次提交版本都必须随包上传）
- 提交前静态检查：`npx --yes web-ext lint --source-dir dist/firefox`
- 树算法基准：`npm run bench:tree`（10K 标签的建树 / 快照 / 对齐 / 扁平化耗时与阈值校验）
- 树功能回归测试：`npm run test:tree`（后台事件链路与页面行构建，纯 Node 运行）
- 产物目录：`dist/chrome/`（Chrome/Edge 加载）、`dist/firefox/`（Firefox 加载，140+）
- 发布包：`dist/nesoi-tab-manager-<target>-<version>.zip`
- 详细方案见 `docs/build.md`；Firefox 商店发布清单见 `docs/publish_firefox.md`。
