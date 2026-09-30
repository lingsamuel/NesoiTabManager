# Firefox 原生侧边栏

## 目标与范围
- 为 **Firefox** 提供真正的浏览器侧边栏（`sidebar_action`），把「当前窗口的标签树」常驻在浏览器侧边，使用体验向 Tree Style Tab 靠拢。
- 侧边栏只做**当前窗口的树状标签列表 + 单条操作**，不承载批量操作、保存列表、AI 分组、冻结历史与设置；需要这些能力时通过侧边栏顶部的「打开管理界面」跳转到管理页。
- **只做 Firefox**。Chrome/Edge 的侧边栏是另一套不兼容的 `sidePanel` API，本次不涉及。
- **不新增任何浏览器权限**。

## 为什么可行（能力依据）
| 事实 | 说明 |
| --- | --- |
| `sidebar_action.default_panel` 声明真正的浏览器侧边栏 | Firefox 专有清单键；会出现在「视图 → 侧边栏」菜单里 |
| **每个浏览器窗口各有一份独立的侧边栏文档实例** | 因此「只显示自己所在窗口」是天然语义，无需额外维护窗口状态 |
| 侧边栏文档可调用 `windows.getCurrent()` 得知自己属于哪个窗口 | 用于确定要展示的 `windowId` |
| 侧边栏文档拥有与后台/弹窗同等的特权 API | `tabs` / `windows` / `storage` 可直接使用，不需要「所有操作经后台转发」的绕行 |
| 窗口关闭或用户关掉侧边栏时文档被卸载 | 不常驻，**对浏览器启动零开销** |
| ⚠️ 扩展首次安装/更新后 Firefox 会自动打开一次该侧边栏 | 浏览器行为，扩展无法阻止，只能在文案上接受 |

参考：MDN [Sidebars](https://developer.mozilla.org/zh-CN/docs/Mozilla/Add-ons/WebExtensions/user_interface/Sidebars)、[sidebarAction](https://developer.mozilla.org/zh-CN/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction)、Tree Style Tab 的 `manifest.json` 与 `sidebar/sidebar.js`。

## 与现有入口的关系
| 入口 | 适用 | 定位 |
| --- | --- | --- |
| `ui/manager.html`（标签页形式） | Chrome/Edge/Firefox | 完整管理能力（批量、列表、AI、冻结、设置） |
| 网页内嵌浮层（`?mode=overlay`） | Chrome/Edge/Firefox | 页面内快速查看近期标签 |
| **`ui/sidebar.html`（新增）** | **仅 Firefox** | 当前窗口的树状标签导航与单条操作 |

三者共享同一份后台树数据与同一套算法，但**互不影响**：侧边栏不改变现有「点击扩展按钮在新标签页打开管理界面」的行为。

## 页面结构
```
┌──────────────────────────────┐
│ [搜索框..............] [过滤|跳转] │  工具栏
│ [+ 新建标签页] [打开管理界面]      │
├──────────────────────────────┤
│ ▾ A                          │
│   ▾ B                        │  树状标签列表
│     C                        │  （虚拟滚动）
│   D                          │
│ E                            │
└──────────────────────────────┘
```
- **固定标签**（pinned）按现有规则一律为顶层，正常显示在列表前部。
- 无标签时显示空状态文案；侧边栏窗口关闭前不会出现「无窗口」的情况。

### 行布局（紧凑）
- 行高固定 **30px**（虚拟列表要求行高固定），缩进 **12px/层**；超过 **16 层**后缩进不再增加（避免深层链把标题挤没）。
- 行内元素：折叠三角（仅有子标签时）→ favicon → 标题（单行省略，`title` 属性给完整标题）→ hover 时出现的「冻结」「关闭」小图标按钮。
- 点击行 = 激活该标签并聚焦其窗口。
- 「已冻结」标签以弱化样式展示；当前活动标签有高亮标记。
- 折叠状态与管理页树状视图**共用** `chrome.storage.session` 的 `treeCollapsed`，并监听 `chrome.storage.onChanged` 保持两端实时同步。

### 工具栏
- **搜索框**：复用现有 `FilterInput`（含 250ms 防抖与输入法组合期处理）与 `useFilterQuery`。
- **过滤 / 跳转双模式**：复用现有语义与 `useMatchNavigation`。过滤模式保留「匹配项 + 全部祖先」并忽略折叠；跳转模式保持完整树、高亮匹配并支持 ↑/↓ 循环。
- **新建标签页**：`chrome.tabs.create({ windowId })`。
- **打开管理界面**：在新标签页打开 `ui/manager.html`（复用后台既有的打开/聚焦逻辑）。

## 新建标签页的归属
侧边栏只负责「创建标签页」，父子归属**完全交给后台既有的创建规则**：无 `openerTabId` 的新标签挂到创建时刻的活动标签之下。
因此新建的标签会成为当前标签的子标签，并在树中直接显示在当前标签下方——这与管理页树状视图的表现一致，不需要为侧边栏增加任何特殊标记或额外消息。

## 拖拽改父子
- 复用与管理页树状视图**完全相同**的落点规则：
  - 行上 1/4 → 插到该行之前，成为其兄弟（父 = 目标行的父）；
  - 行下 1/4 → 插到该行之后（含该行整棵子树之后），成为其兄弟；
  - 行中间 1/2 → 成为该行的子标签，追加为最后一个子标签。
- 复用同一个后台消息 `moveTabTree`，因此校验（跨窗口、固定标签、拖到自身子孙）与「同步移动物理位置」的行为完全一致。
- 无效落点不显示指示、不触发操作。

## 数据流与刷新策略（实时跟随）
1. 初始化：`chrome.windows.getCurrent()` 得到 `windowId` → `chrome.tabs.query({ windowId })` 取本窗口标签 → `getTreeStructure({ windowIds: [windowId] })` 取父子映射 → 读 `treeCollapsed`。
2. 订阅 `chrome.tabs.onCreated / onRemoved / onMoved / onAttached / onDetached / onUpdated`。
   **只处理 `windowId` 等于自身窗口的事件**（这些事件都带窗口信息），因此其它窗口的活动不会引起本侧边栏刷新。
3. 事件到达后**防抖 250ms 合并**，再重新执行第 1 步的两次读取。
4. 两处针对性优化（10K 标签下差别明显）：
   - `onActivated`（切换标签）**不重取数据**，只在本地改活动标记——把一次"IPC + 整窗序列化"降成一次 O(n) 内存遍历；
   - `onUpdated` 只在 `title` / `url` / `favIconUrl` / `discarded` / `pinned` 真正变化时才刷新。
     页面加载期间 `onUpdated` 会因 `status`、`audible` 等字段连续触发，若不过滤会把防抖窗口填满无意义的整窗查询。
5. 侧边栏被关闭或窗口关闭时文档卸载，监听器随之销毁——不产生常驻开销。

### 10K 标签下的成本控制
- 单次刷新 = 一次 `chrome.tabs.query`（本窗口，10K 标签约 2MB 序列化）+ 一次 `getTreeStructure`（约 300KB 父子映射），实测在几十毫秒量级，且被 250ms 防抖合并。
- 渲染复用 `VirtualList`，只挂载可见行；折叠隐藏的子树不进入行序列（`flattenTree` 一次 O(n)）。
- 缩进与折叠都在前端本地计算，不产生额外 IPC。
- 若侧边栏处于隐藏状态（`document.visibilityState !== "visible"`）则跳过刷新，等重新可见时补一次——避免用户在其它侧边栏/无侧边栏状态下持续付出刷新成本。

## 代码与构建
### 目录
```
src/manager/            # Vite root（历史命名）：两个入口 HTML 必须放在 root 顶层，
├── manager.html        #   否则 Vite 会按相对路径输出到 ui/ 的子目录里
├── sidebar.html        # 新增：侧边栏入口（只做引路，逻辑在 src/sidebar/）
└── ...
src/sidebar/            # 新增：侧边栏专用源码
├── main.js
├── SidebarApp.vue
├── components/SidebarTabTree.vue
└── styles/sidebar.css
```
- `vite.config.js` 的 `rollupOptions.input` 增加 `sidebar: src/manager/sidebar.html`，输出 `ui/sidebar.html`（与管理页共用同一份 JS/CSS chunk）。
- 侧边栏复用：`background/tree_core.js` 的 `flattenTree`、`src/manager/composables/useTree.js` 的父子映射与折叠状态、`src/manager/components/FilterInput.vue`、`src/manager/composables/useFilterQuery.js`、`useMatchNavigation.js`、`src/manager/utils/request.js`、`VirtualList.vue`。
- 侧边栏**不复用** `App.vue`：管理页会连带加载列表/AI/冻结/设置等代码，而侧边栏只需要树。

### 清单
`scripts/write-manifest.mjs` 的 **firefox 分支**新增：
```jsonc
"sidebar_action": {
  "default_title": "Nesoi 标签侧边栏",
  "default_panel": "ui/sidebar.html"
}
```
- **Chrome 目标清单保持不变**（基础 `manifest.json` 不动，避免 Chromium 收到未知键）。
- 不需要 `default_icon`（项目当前没有图标资源，该字段可选）；不使用已废弃的 `browser_style`。
- **不新增权限**：`sidebar_action` 本身不需要权限，所需的 `tabs` / `storage` 已经具备。

## 已知限制
- 仅 Firefox。Chrome/Edge 需要 `sidePanel` 权限与 `side_panel` 清单键，属另一套实现。
- 首次安装/更新后 Firefox 会自动打开一次侧边栏，无法通过扩展阻止。
- 侧边栏只显示自己所在窗口的标签，不提供跨窗口视图。
- 沿用树状结构「不主动移动标签页」的设计：原生标签栏里的顺序与树可能不一致，只有在侧边栏/管理页拖拽时才会同步移动。
- 折叠状态不跨浏览器重启保留（与树状结构一致，存 `storage.session`）。
- 未做深色主题适配：侧边栏使用与管理页相同的浅色配色，Firefox 深色主题下观感不统一，留作后续。
- 侧边栏窄（约 250–350px），深层缩进会挤压标题，因此缩进在 16 层后封顶。

## 验收方式
无法自动化真实浏览器，因此分两层：
1. **可自动化**：`npm run build` 产出 `ui/sidebar.html` 且 Firefox 目标 `manifest.json` 含 `sidebar_action`、Chrome 目标不含；复用现有 `npm run test:tree` 保证树算法未回归；侧边栏行构建（紧凑 DFS + 折叠 + 筛选补祖先）补一个 Node 单元测试。
2. **需手工验收**（在 Firefox 115+ 加载 `dist/firefox`，从「视图 → 侧边栏」打开）：
   - 打开/关闭标签、拖动标签、切换标签时侧边栏实时跟随；
   - 点击行能切换标签；「新建标签页」出现且挂在当前标签之下；
   - 折叠三角、搜索过滤/跳转、拖拽改父子（含物理位置同步）均生效；
   - 折叠状态与管理页互通；
   - 多窗口下每个窗口显示各自的标签；
   - 关闭侧边栏后重开、以及关闭窗口后无残留错误。

## 后续可选扩展（本次不做）
- Chrome/Edge `sidePanel` 适配。
- 深色主题跟随。
- 侧边栏内多选与批量操作。
- 从侧边栏直接保存标签到列表。
