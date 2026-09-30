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
┌──────────────────────────────────┐
│ [搜索框...............] [过滤|跳转]   │  工具栏（固定）
│ [+ 新建标签页] [打开管理界面]          │
├──────────────────────────────────┤
│ [icon][icon] │ [icon][icon][icon]   │  固定标签区（固定不滚动）
│                                     │  ├ 横向铺开的图标方块
├──────────────────────────────────┤  ├ 竖线分隔不同窗口
│ ▾ A                                 │  └ 只显示图标，可拖拽重排
│   ▾ B                               │
│     C                               │  本窗口非固定标签的树
│   D                                 │  （虚拟滚动）
│ E                                   │
└──────────────────────────────────┘
```
- 无标签时显示空状态文案；侧边栏窗口关闭前不会出现「无窗口」的情况。
- 固定标签区没有任何固定标签时整体不显示（0 高度）。

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

## 固定标签区（pinned）
固定标签从树区域**移出**，单独放在侧边栏顶部一个**不参与滚动**的区域，行为对齐 Tree Style Tab 的 pinned 容器。

### 跨窗口聚合
- 数据来自 `chrome.tabs.query({ pinned: true })`，即**所有窗口**的固定标签，而不是只查本窗口。
- 分组与排序：
  - **本窗口的固定标签排在最前**，其后是其它窗口；
  - 其它窗口按 `chrome.windows.getAll()` 返回的顺序排列，与「窗口 N」编号口径与管理页一致；
  - 组内按标签 `index` 升序。
- 组与组之间画一条**细分隔线**；固定标签行 hover 的 tooltip 显示「标题（窗口 N）」，本窗口则只显示标题。
- 点击固定标签仍然走后台的 `activateTab`：先前置它所属窗口再激活标签，因此**切换窗口的能力不变**。

### 图标方块
- **横向铺开的小方块**，不是整行横条：每个方块 **28×28px**、间距 2px，容器自动换行，方块内居中显示 16px 的 favicon。
  这是 Tree Style Tab 的 pinned 容器外观；整行横条会让固定标签区白白吃掉大量纵向空间。
- 容器自带浅灰底色，与下方白色树区域区分开。
- 状态提示：
  - **本窗口当前活动的固定标签** → 白底方块 + 轻微阴影（与 TST 一致）；
  - **其它窗口里活动的固定标签** → 只描一圈浅色边，避免聚合多个窗口后满屏都是白块；
  - 已冻结 → 降低不透明度；静音 → 右上角一个小圆点。
- **刻意不做 hover 关闭按钮**：方块只有 28px，关闭按钮一旦出现就会盖住唯一的点击区域，
  用户想切换标签却只能关闭。固定标签的关闭改由**鼠标中键**承担（右键菜单里没有"关闭"项，见下文「右键菜单」）。
- tooltip 给出完整标题（其它窗口的固定标签还带「窗口 N」）。
- 固定标签**不参与搜索筛选**：它是固定导航区，始终完整显示（这与它在树区域之外单独成区是同一套语义）。

### favicon 占位图
- 站点没有提供 favicon（或图标加载失败）时显示**内置的地球占位图标**，而不是留一个空白方块。
- 这部分是**全项目共用**的：`src/manager/components/TabFavicon.vue` + `src/manager/styles/favicon.css`，
  管理页标签行、保存列表项、侧边栏树行与固定标签方块都在用它；加载失败会回退到占位图（换标签时重置）。
  仅遗留的 popup（普通脚本，非模块）用同款 data URI 占位图自行实现。
- 原因：固定标签区整块区域只有图标，空白方块会让人以为渲染坏了；Tree Style Tab 也提供默认图标。

### 高度与溢出
- 高度**自适应**：按实际固定标签数量决定，但上限为**侧边栏可视高度的 40%**。
- 达到上限后固定标签区**内部滚动**，不会把下方的树区域挤没。

### 拖拽重排（仅同窗口）
- 固定标签之间可拖拽调整顺序，落点用插入线表示（按行的上下半区决定插到前/后）。
- **只允许同一窗口内的重排**：拖到另一个窗口的组上时不显示落点、不触发任何操作。
  理由是聚合后的"跨组拖拽"意味着把标签移动到另一个窗口，属于会影响窗口结构的高风险操作，与"重排顺序但不动窗口"的诉求相悖。
- 实现为 `chrome.tabs.move(tabId, { windowId, index })`，其中 `index` 是目标在该窗口**固定标签范围内**的位置（固定标签本身占据窗口标签栏最前面的若干位）。
- 固定标签与树区域之间**不互相拖拽**：拖到树区域、或把树里的标签拖进固定区都不响应（取消固定请用右键菜单）。

### 中键关闭
- 固定标签行与树行都支持**鼠标中键关闭**（`auxclick` + `button === 1`）。
- 同时拦截中键的 `mousedown` 默认行为，避免 Firefox 触发中键自动滚动。

## 右键菜单
### 方案：Firefox 原生菜单外壳 + 本插件提供菜单项
浏览器**没有**任何 API 能让扩展弹出「Firefox 内置的标签菜单」。`menus.overrideContext({ context: "tab", tabId })` 的语义
（Mozilla 关于 Firefox 64 的说明与 MDN 一致）是：**隐藏所有默认 Firefox 菜单项**，只渲染「本扩展注册到该上下文的项」
与「其它扩展注册到该上下文的项」。
也就是说它提供的是**原生菜单外壳**（原生外观、键盘导航、自动合并其它扩展的 tab 项），菜单**内容**必须自己注册——
Tree Style Tab 的 `background/tab-context-menu.js`（1900 余行）正是自己注册了一整套。

本插件的做法：
1. 侧边栏右键某个标签行 / 固定标签方块时，调用 `menus.overrideContext({ context: "tab", tabId })`，并且**不** `preventDefault`；
2. 由后台在启动时注册一组 `contexts: ["tab"]` 的真实菜单项来提供菜单内容；
3. 不使用自建 HTML 菜单。

### 菜单项
| 菜单项 | 行为 |
| --- | --- |
| 刷新标签页 | `chrome.tabs.reload` |
| 固定标签页 / 取消固定 | `chrome.tabs.update({ pinned })`，文案随被右键标签的状态切换 |
| 静音标签页 / 取消静音 | `chrome.tabs.update({ muted })`，文案随状态切换 |
| 冻结标签页 | 复用后台 `manualDiscard`（与行内按钮、管理页冻结同一条路径）；已冻结时置灰 |
| 复制链接 | 后台页面用 `navigator.clipboard.writeText` |
| 移动到窗口 ▸ | 子菜单：每个已打开窗口一项（「窗口 N」，与管理页编号口径一致）+「移动到新窗口」（固定排最后） |

- 固定/静音/冻结的文案与可用状态在 `menus.onShown` 里按**被右键的那个标签**实时更新，再调 `menus.refresh()`。
- 「移动到窗口」里**当前窗口那一项会被隐藏**（移动到自身没有意义）；窗口打开/关闭时子菜单整体重建。
- 为避免 `onShown → update → refresh → onShown` 死循环，只有当"期望呈现状态"（固定/静音/冻结/各窗口项可见性）真的变化时才写回并刷新。
- 这些项注册在 `contexts: ["tab"]`，因此它们**同样会出现在 Firefox 自带标签栏的右键菜单**里——这是同一份注册的自然结果。
- 本次**不注册**「关闭 / 关闭其他 / 关闭右侧 / 复制标签页」等项（按需求"其他可以不要"）。
  关闭标签仍可通过树行的 hover 按钮与鼠标中键完成；固定标签方块只能中键关闭，因为它没有行内按钮。

### 为什么只在 Firefox 注册这组项
侧边栏本身就是 Firefox 专有的实现；并且「复制链接」依赖后台页面的 DOM（Chrome 的 MV3 service worker 没有 DOM）。
因此后台通过运行时判断（是否存在 `chrome.sidebarAction`）只在 Firefox 注册这组 `contexts: ["tab"]` 项，
Chrome 侧的右键菜单保持原样、不受影响。网页右键的「保存到列表」两项在两端都保留。

### 权限
- 新增 **`menus.overrideContext`**：Firefox 专有的必需权限，**只写进 Firefox 目标清单**（Chrome 不认识这个权限）。
- 现有的 `contextMenus` 已覆盖 `create` / `update` / `onShown` / `onClicked`。由于使用的是 `contextMenus` 这个别名，
  API 统一通过 `chrome.contextMenus` 访问（MDN：使用别名时必须以该别名访问）；侧边栏侧对 `chrome.menus` / `chrome.contextMenus` 都做了兼容探测。
- **代价**：通过 AMO 安装的用户在扩展更新时会因新增必需权限被 Firefox 禁用并提示重新授权（`about:debugging` 临时加载无感）。

## 拖拽改父子
- 复用与管理页树状视图**完全相同**的落点规则：
  - 行上 1/4 → 插到该行之前，成为其兄弟（父 = 目标行的父）；
  - 行下 1/4 → 插到该行之后（含该行整棵子树之后），成为其兄弟；
  - 行中间 1/2 → 成为该行的子标签，追加为最后一个子标签。
- 复用同一个后台消息 `moveTabTree`，因此校验（跨窗口、固定标签、拖到自身子孙）与「同步移动物理位置」的行为完全一致。
- 无效落点不显示指示、不触发操作。

## 数据流与刷新策略（实时跟随）
1. 初始化：`chrome.windows.getCurrent()` 得到 `windowId` → 取本窗口标签 `chrome.tabs.query({ windowId })`、跨窗口固定标签 `chrome.tabs.query({ pinned: true })`、窗口列表 `chrome.windows.getAll()` → `getTreeStructure({ windowIds: [windowId] })` 取父子映射 → 读 `treeCollapsed`。
2. 订阅 `chrome.tabs.onCreated / onRemoved / onMoved / onAttached / onDetached / onUpdated`。
3. 事件到达后按来源分流，再**防抖 250ms 合并**：
   - `windowId` 等于自身窗口 → 重取第 1 步的全部数据；
   - `windowId` 是其它窗口 → **只重取跨窗口固定标签**（固定标签区是唯一的跨窗口区域，其它窗口的变化只会影响它）；
   - 提取函数返回 `undefined` 的事件直接忽略。
4. 三处针对性优化（10K 标签下差别明显）：
   - `onActivated`（切换标签）**不重取数据**，只在本地改活动标记——把一次"IPC + 整窗序列化"降成一次 O(n) 内存遍历；
   - `onUpdated` 只在 `title` / `url` / `favIconUrl` / `discarded` / `pinned` 真正变化时才刷新。
     页面加载期间 `onUpdated` 会因 `status`、`audible` 等字段连续触发，若不过滤会把防抖窗口填满无意义的整窗查询。
5. 侧边栏被关闭或窗口关闭时文档卸载，监听器随之销毁——不产生常驻开销。

### 10K 标签下的成本控制
- 单次刷新 = 一次 `chrome.tabs.query`（本窗口，10K 标签约 2MB 序列化）+ 一次 `getTreeStructure`（约 300KB 父子映射），实测在几十毫秒量级，且被 250ms 防抖合并。
- 渲染复用 `VirtualList`，只挂载可见行；折叠隐藏的子树不进入行序列（`flattenTree` 一次 O(n)）。
- 缩进与折叠都在前端本地计算，不产生额外 IPC。
- 若侧边栏处于隐藏状态（`document.visibilityState !== "visible"`）则跳过刷新，等重新可见时补一次——避免用户在其它侧边栏/无侧边栏状态下持续付出刷新成本。
- **其它窗口的事件只刷新固定标签区**：`chrome.tabs.query({ pinned: true })` 的返回量只与固定标签数量有关（通常个位数到几十个），
  不影响本窗口的整窗查询；这样既能让跨窗口聚合的固定标签保持实时，又不会因为别的窗口开标签而重取自己的 10K 标签。

## 代码与构建
### 目录
```
src/manager/            # Vite root（历史命名）：两个入口 HTML 必须放在 root 顶层，
├── manager.html        #   否则 Vite 会按相对路径输出到 ui/ 的子目录里
├── sidebar.html        # 新增：侧边栏入口（只做引路，逻辑在 src/sidebar/）
└── ...
src/sidebar/            # 新增：侧边栏专用源码
├── main.js
├── SidebarApp.vue              # 窗口绑定、事件订阅、刷新调度、操作
├── pinned_data.js              # 固定标签的纯逻辑：跨窗口分组、同窗口重排下标（可 Node 单测）
├── components/
│   ├── SidebarTabTree.vue      # 树区域：紧凑行、折叠、拖拽改父子、中键关闭、右键上下文覆盖
│   ├── SidebarPinnedTabs.vue   # 固定标签区：跨窗口分组、图标方块、同窗口拖拽重排、中键关闭
│   ├── TabFavicon.vue          # 标签图标：无 favicon 或加载失败时回退到内置占位图
└── styles/sidebar.css
```
- `vite.config.js` 的 `rollupOptions.input` 增加 `sidebar: src/manager/sidebar.html`，输出 `ui/sidebar.html`（与管理页共用同一份 JS/CSS chunk）。
- 侧边栏复用：`background/tree_core.js` 的 `buildTreeRows`、`src/manager/composables/useTree.js` 的父子映射与折叠状态、`src/manager/components/FilterInput.vue`、`src/manager/composables/useFilterQuery.js`、`useMatchNavigation.js`、`src/manager/utils/request.js`、`src/manager/utils/helpers.js` 的 `getTreeDropZone`、`VirtualList.vue`。
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
- **权限**：`sidebar_action` 本身不需要权限（`tabs` / `storage` 已具备）；但右键菜单方案需要新增 Firefox 专有的
  `menus.overrideContext`，同样只加在 Firefox 目标清单里。

## 已知限制
- 仅 Firefox。Chrome/Edge 需要 `sidePanel` 权限与 `side_panel` 清单键，属另一套实现。
- 首次安装/更新后 Firefox 会自动打开一次侧边栏，无法通过扩展阻止。
- 树区域只显示自己所在窗口的标签，不提供跨窗口的整树视图；**固定标签区是唯一的跨窗口区域**。
- 固定标签区只做同窗口内的顺序重排，不做跨窗口拖拽（跨窗口移动标签请用管理页的「移动到窗口」）。
- 右键菜单是"原生外壳 + 本插件菜单项"：Firefox 内置的标签菜单项不会出现（`overrideContext` 会把它们隐藏），
  菜单内容完全由本插件注册；书签、重新打开已关闭标签页、发送到设备需要新增权限或 Firefox 专有能力，本次不做。
- 新增 `menus.overrideContext` 必需权限会让 AMO 用户在更新时被要求重新授权。
- 沿用树状结构「不主动移动标签页」的设计：原生标签栏里的顺序与树可能不一致，只有在侧边栏/管理页拖拽时才会同步移动。
- 折叠状态不跨浏览器重启保留（与树状结构一致，存 `storage.session`）。
- 未做深色主题适配：侧边栏使用与管理页相同的浅色配色，Firefox 深色主题下观感不统一，留作后续。
- 侧边栏窄（约 250–350px），深层缩进会挤压标题，因此缩进在 16 层后封顶。
- 固定标签区不参与搜索筛选：它是固定导航区，始终完整显示。

## 验收方式
无法自动化真实浏览器，因此分两层：
1. **可自动化**：`npm run build` 产出 `ui/sidebar.html` 且 Firefox 目标 `manifest.json` 含 `sidebar_action`、Chrome 目标不含；复用现有 `npm run test:tree` 保证树算法未回归；固定标签区的分组/排序/重排下标抽成纯函数 `src/sidebar/pinned_data.js` 并由 `scripts/test_sidebar_pinned.mjs` 覆盖
   （跨窗口分组顺序与窗口编号、同窗口重排下标、原位拖拽返回 -1、tooltip 文案），随 `npm run test:tree` 一起跑。
2. **需手工验收**（在 Firefox 115+ 加载 `dist/firefox`，从「视图 → 侧边栏」打开）：
   - 打开/关闭标签、拖动标签、切换标签时侧边栏实时跟随；
   - 点击行能切换标签；「新建标签页」出现且挂在当前标签之下；
   - 折叠三角、搜索过滤/跳转、拖拽改父子（含物理位置同步）均生效；
   - **固定标签区**：固定在顶部不随树滚动；图标是**横向铺开的小方块**而不是整行横条；
     聚合了其它窗口的固定标签并用竖线按窗口分组；点击其它窗口的固定标签能切到那个窗口；
     tooltip 有完整标题；同窗口内可拖拽重排，拖到别的窗口组上无反应；
   - **favicon 占位图**：站点没有 favicon（或图标加载失败）时，固定标签与树行都显示内置地球图标而不是空白方块；
   - **中键关闭**：固定标签与树行都能用中键关闭，且不触发 Firefox 的中键自动滚动；
   - **右键菜单**：右键标签后弹出的是 Firefox 原生菜单控件（外观/键盘导航是原生的），内容为刷新/固定/静音/冻结/复制链接/移动到窗口▸；
     固定与静音的文案随状态切换、已冻结时「冻结标签页」置灰；「移动到窗口」里不出现当前窗口、且最后一项是「移动到新窗口」；
     右键不同窗口的标签时子项可见性正确切换；同一标签重复右键不会出现菜单闪动（refresh 死循环）；
     同样的项也应出现在 Firefox 自带标签栏的右键菜单里；
   - 折叠状态与管理页互通；
   - 多窗口下每个窗口的树各显示自己的标签；
   - 关闭侧边栏后重开、以及关闭窗口后无残留错误。

## 后续可选扩展（本次不做）
- Chrome/Edge `sidePanel` 适配。
- 深色主题跟随。
- 侧边栏内多选与批量操作。
- 从侧边栏直接保存标签到列表。
- 右键菜单补充需要新增权限的原生项（书签、重新打开已关闭标签页），以及「关闭 / 关闭其他 / 关闭右侧」。
