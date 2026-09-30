# 设计文档索引

本目录按模块归类功能与交互设计说明，便于快速定位实现与交互逻辑。

## 界面与交互（docs/ui）
- `docs/ui/manager_ui.md`：管理界面（Vue）结构与主要交互。
- `docs/ui/quick_actions.md`：右键菜单与页面悬浮组件的快捷操作。
- `docs/ui/ai_grouping.md`：AI 分组能力与使用流程。
- `docs/ui/auto_discard.md`：自动冻结与冻结历史交互。
- `docs/ui/recent_tabs.md`：近期标签页与回收提醒。
- `docs/ui/tree_style_tabs.md`：树状标签页（树模型、持久化、拖拽改父子、性能约束）。
- `docs/ui/firefox_sidebar.md`：Firefox 原生侧边栏（`sidebar_action`、实时刷新、构建与清单）。

## 系统与数据（docs/data）
- `docs/data/background_service_worker.md`：后台服务、事件与消息协议。
- `docs/data/storage_model.md`：存储结构、字段与数据流。

## 构建与发布（docs）
- `docs/build.md`：Chrome 与 Firefox 双浏览器构建与打包方案。
