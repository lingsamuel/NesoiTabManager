# Nesoi Tab Manager

A Chrome/Edge extension to manage large volumes of tabs.

帮我写个Chrome/Edge的浏览器插件，用于管理我的海量标签页。它需要能读取所有窗口和标签页。然后我可以勾选一些，将它们保存到一个列表里（可以是已有的或者新建列表），并且可以勾选保存时关闭。还需要有导入、导出已保存的标签页功能。此外，还需要给网页的右键菜单添加一个选项：保存到（某个列表）和关闭并保存到某个列表。同时给网页的左下角添加一个悬浮框，鼠标划过时向上展开已有的列表，然后可以快捷将当前网页保存（或者关闭并保存）到选中的列表。将这个需求记作README，然后逐步实现。

## Requirements

- Read all windows and tabs.
- Allow selecting multiple tabs and saving them into a list.
- Support saving into an existing list or a new list.
- Optional checkbox to close tabs after saving.
- Import and export saved tab lists.
- Add right-click menu items on web pages:
  - Save to <list>
  - Close and save to <list>
- Add a bottom-left floating widget on web pages:
  - On hover, expand upward to show existing lists.
  - Allow quick save (or close + save) of the current page to a selected list.

## Implementation Notes

- Manifest V3 extension with a service worker.
- Use chrome.tabs, chrome.storage, chrome.contextMenus.
- Lists stored in chrome.storage.local as JSON.
