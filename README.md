# Nesoi 标签管理器

一个用于管理海量标签页的 Chrome/Edge 扩展。

## 需求

- 读取所有窗口与标签页。
- 可勾选多个标签页保存到列表。
- 支持保存到已有列表或新建列表。
- 保存时可选择关闭标签页。
- 支持导入、导出已保存的标签页。
- 网页右键菜单提供：
  - 保存到某个列表
  - 关闭并保存到某个列表
- 网页左下角悬浮组件：
  - 鼠标划过向上展开已有列表
  - 一键保存或关闭并保存当前页面
- 交互文案统一使用中文。

## 实现说明

- Manifest V3，后台使用 service worker。
- 使用 `chrome.tabs`、`chrome.storage`、`chrome.contextMenus`。
- 列表数据存放在 `chrome.storage.local`。
