<template>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-title">Nesoi 标签管理器</div>
        <div class="brand-subtitle">管理海量标签页</div>
      </div>
      <nav class="nav">
        <button
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ active: view === item.key }"
          @click="setView(item.key)"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path :d="item.icon" />
            </svg>
          </span>
          {{ item.label }}
        </button>
      </nav>
    </aside>

    <aside class="sub-sidebar" :class="{ hidden: view === 'settings' || view === 'discard' }">
      <div class="sub-title">{{ view === "windows" ? "窗口" : "列表" }}</div>
      <div class="sub-items">
        <template v-if="view === 'windows'">
          <button
            class="sub-item"
            :class="{ active: selectedWindowId === 'all' }"
            @click="setSelectedWindow('all')"
          >
            <span>全部窗口</span>
            <small>{{ totalTabCount }}</small>
          </button>
          <button
            v-for="item in windowSubItems"
            :key="item.id"
            class="sub-item"
            :class="{ active: String(selectedWindowId) === String(item.id) }"
            @click="setSelectedWindow(String(item.id))"
          >
            <span>{{ item.label }}</span>
            <small>{{ item.count }}</small>
          </button>
          <div v-if="windowSubItems.length === 0" class="empty-state">暂无窗口</div>
        </template>
        <template v-else>
          <button
            v-for="item in listSubItems"
            :key="item.id"
            class="sub-item"
            :class="{ active: selectedListId === item.id }"
            :title="item.description || ''"
            @click="setSelectedList(item.id)"
          >
            <span>{{ item.label }}</span>
            <small>{{ item.count }}</small>
          </button>
          <div v-if="listSubItems.length === 0" class="empty-state">暂无列表</div>
          <button class="sub-item add" @click="openCreateListModal">
            <span class="sub-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span>新增列表</span>
          </button>
        </template>
      </div>
    </aside>

    <main class="content">
      <section v-show="view === 'windows'" class="view view-windows">
        <div class="content-header">
          <div>
            <h1>打开的窗口</h1>
            <div class="content-subtitle">{{ windowSubtitle }}</div>
          </div>
          <div class="content-actions">
            <button class="ghost btn-icon" @click="setVisibleSelection(true)">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </span>
              全选
            </button>
            <button class="ghost btn-icon" @click="setVisibleSelection(false)">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              清空
            </button>
            <button class="ghost danger btn-icon" @click="closeSelectedTabs">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭所选
            </button>
            <button class="ghost btn-icon" @click="openAiModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 3l2.2 4.4L19 9l-4.8 1.6L12 15l-2.2-4.4L5 9l4.8-1.6z" />
                </svg>
              </span>
              AI 分组
            </button>
            <button class="ghost btn-icon" @click="openSaveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
                </svg>
              </span>
              保存所选
            </button>
          </div>
        </div>

        <div class="panel tabs-panel">
          <div v-if="windowRows.length === 0" class="virtual-empty">未找到打开的标签页。</div>
          <VirtualList
            v-else
            class="tabs"
            :items="windowRows"
            :item-height="44"
          >
            <template #default="{ item }">
              <div v-if="item.type === 'window'" class="window-title-row">
                {{ item.label }}（{{ item.count }}）
              </div>
              <div v-else-if="item.type === 'empty'" class="empty-row">
                此窗口没有标签页。
              </div>
              <div v-else class="tab-row" @click="toggleTabSelection(item.tab.id)">
                <input
                  type="checkbox"
                  :checked="Boolean(selectedTabIds[item.tab.id])"
                  @click.stop
                  @change="toggleTab(item.tab.id, $event.target.checked)"
                />
                <img
                  class="tab-icon"
                  :class="{ hidden: !item.tab.favIconUrl }"
                  :src="item.tab.favIconUrl || ''"
                  @error="handleIconError($event)"
                />
                <div class="tab-body">
                  <div class="tab-title">
                    <span v-if="item.tab.discarded" class="discard-dot" aria-hidden="true"></span>
                    <span class="tab-link" @click.stop="activateTab(item.tab)">
                      {{ item.tab.title || item.tab.url || "未命名" }}
                    </span>
                  </div>
                  <div class="tab-url">
                    <span class="tab-link" @click.stop="activateTab(item.tab)">
                      {{ item.tab.url || "" }}
                    </span>
                  </div>
                </div>
                <div class="tab-actions">
                  <span
                    class="tab-tag"
                    :class="{ hidden: !aiTags[item.tab.id] }"
                    @click.stop="saveTabToAiGroup(item.tab, false)"
                  >
                    {{ aiTags[item.tab.id] || "" }}
                  </span>
                  <span
                    class="tab-tag close"
                    :class="{ hidden: !aiTags[item.tab.id] }"
                    @click.stop="saveTabToAiGroup(item.tab, true)"
                  >
                    保存并关闭
                  </span>
                  <button class="ghost tab-action danger btn-icon" @click.stop="closeTab(item.tab)">
                    <span class="icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="M6 6l12 12M18 6l-12 12" />
                      </svg>
                    </span>
                    关闭
                  </button>
                  <button class="ghost tab-action btn-icon" @click.stop="discardTab(item.tab)">
                    <span class="icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                      </svg>
                    </span>
                    冻结
                  </button>
                </div>
              </div>
            </template>
          </VirtualList>
        </div>

        
      </section>

      <section v-show="view === 'lists'" class="view view-lists">
        <div class="content-header">
          <div class="content-title">
            <div v-if="isEditingListName" class="title-edit">
              <input
                ref="listNameInput"
                class="title-input"
                type="text"
                v-model="listNameDraft"
                @keydown.enter.prevent="saveListName"
                @keydown.esc.prevent="cancelEditListName"
              />
              <button class="ghost btn-icon" @click="cancelEditListName">
                <span class="icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6l-12 12" />
                  </svg>
                </span>
                取消
              </button>
              <button class="primary btn-icon" @click="saveListName">
                <span class="icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
                  </svg>
                </span>
                保存
              </button>
            </div>
            <h1
              v-else
              class="clickable"
              :class="{ disabled: !selectedList }"
              @click="startEditListName"
            >
              {{ listTitle }}
            </h1>
            <div class="content-subtitle">{{ listSubtitle }}</div>
          </div>
          <div class="content-actions">
            <button class="ghost btn-icon" @click="selectAllListItems">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </span>
              全选
            </button>
            <button class="ghost btn-icon" @click="clearListSelection">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              清空
            </button>
            <button class="ghost danger btn-icon" @click="deleteSelectedListItems">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 7h16M9 7v10M15 7v10M6 7l1-3h10l1 3M7 20h10" />
                </svg>
              </span>
              删除所选
            </button>
            <button class="ghost btn-icon" :disabled="!selectedList" @click="openMoveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
              移动所选
            </button>
            <button class="ghost danger btn-icon" @click="deleteList">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 7h16M9 7v10M15 7v10M6 7l1-3h10l1 3M7 20h10" />
                </svg>
              </span>
              删除列表
            </button>
            <button class="ghost btn-icon" @click="exportLists">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 3v12M8 11l4 4 4-4M5 21h14" />
                </svg>
              </span>
              导出列表
            </button>
            <label class="ghost import-label btn-icon" for="import-file">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 21V9M8 13l4-4 4 4M5 3h14" />
                </svg>
              </span>
              导入列表
            </label>
            <input id="import-file" type="file" accept="application/json" @change="importLists" />
          </div>
        </div>

        <section class="panel">
          <div class="panel-header">
            <h2>列表描述</h2>
            <div class="panel-actions">
              <button class="ghost btn-icon" :disabled="!selectedList" @click="clearListDescription">
                <span class="icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6l-12 12" />
                  </svg>
                </span>
                清空
              </button>
              <button class="primary btn-icon" :disabled="!selectedList" @click="saveListDescription">
                <span class="icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
                  </svg>
                </span>
                保存描述
              </button>
            </div>
          </div>
          <div class="form-row">
            <label for="list-description">用于指导 AI 分组，可留空</label>
            <textarea
              id="list-description"
              rows="4"
              :disabled="!selectedList"
              placeholder="例如：客户调研、竞品分析"
              v-model="listDescriptionDraft"
            ></textarea>
          </div>
        </section>

        <div class="panel list-panel">
          <div v-if="listItems.length === 0" class="virtual-empty">暂无已保存的列表。</div>
          <VirtualList
            v-else
            class="list-items"
            :items="listItems"
            :item-height="60"
          >
            <template #default="{ item }">
              <div
                class="list-item"
                :class="{ selected: Boolean(selectedListItemKeys[item.key]) }"
                @click="toggleListItemSelection(item.key)"
              >
                <input
                  type="checkbox"
                  :checked="Boolean(selectedListItemKeys[item.key])"
                  @click.stop
                  @change="toggleListItem(item.key, $event.target.checked)"
                />
                <img
                  class="list-icon"
                  :class="{ hidden: !item.favIconUrl }"
                  :src="item.favIconUrl || ''"
                  @error="handleIconError($event)"
                />
                <div class="list-body">
                  <div class="list-title">
                    <span class="list-link" @click.stop="openSavedInNewWindow(item)">
                      {{ item.title || item.url || "未命名" }}
                    </span>
                  </div>
                  <div class="list-url">
                    <span class="list-link" @click.stop="openSavedInNewWindow(item)">
                      {{ item.url || "" }}
                    </span>
                  </div>
                  <div v-if="item.savedAt" class="list-meta">保存时间：{{ item.savedAt }}</div>
                </div>
                <button class="ghost list-action danger btn-icon" @click.stop="deleteListItem(item)">
                  <span class="icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M4 7h16M9 7v10M15 7v10M6 7l1-3h10l1 3M7 20h10" />
                    </svg>
                  </span>
                  删除
                </button>
              </div>
            </template>
          </VirtualList>
        </div>

        <section class="panel">
          <div class="panel-header">
            <h2>导入选项</h2>
          </div>
          <div class="form-row checkbox-row">
            <label>
              <input type="checkbox" v-model="importReplace" />
              导入时替换现有列表
            </label>
          </div>
          <div class="status" :class="listStatus.type">{{ listStatus.message }}</div>
        </section>
      </section>

      <div v-if="showMoveModal" class="modal-backdrop" @click.self="closeMoveModal">
        <div class="modal">
          <div class="modal-header">
            <h3>移动所选标签</h3>
            <button class="ghost btn-icon" @click="closeMoveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label for="move-list-select">目标列表</label>
              <select id="move-list-select" v-model="moveTargetListId">
                <option
                  v-for="list in moveTargetLists"
                  :key="list.id"
                  :value="list.id"
                >
                  {{ list.name }}（{{ list.items ? list.items.length : 0 }}）
                </option>
                <option :value="MOVE_NEW_LIST_VALUE">新建列表</option>
              </select>
            </div>
            <div class="form-row" :class="{ hidden: moveTargetListId !== MOVE_NEW_LIST_VALUE }">
              <label for="move-new-list-name">新建列表名称</label>
              <input
                id="move-new-list-name"
                type="text"
                placeholder="例如：已归档"
                v-model="moveNewListName"
              />
            </div>
            <div class="status" :class="listStatus.type">{{ listStatus.message }}</div>
          </div>
          <div class="modal-actions">
            <button class="ghost btn-icon" @click="closeMoveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              取消
            </button>
            <button class="primary btn-icon" @click="confirmMoveSelected">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
              确认移动
            </button>
          </div>
        </div>
      </div>

      <div v-if="showAiModal" class="modal-backdrop" @click.self="closeAiModal">
        <div class="modal">
          <div class="modal-header">
            <h3>AI 分组</h3>
            <button class="ghost btn-icon" @click="closeAiModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
          </div>
          <div class="modal-body">
            <div class="hint">仅使用标题与基础域名，并结合打开顺序生成标签。</div>
            <div class="form-row ai-actions">
              <button class="ghost btn-icon" @click="runAiGrouping">
                <span class="icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M12 3l2.2 4.4L19 9l-4.8 1.6L12 15l-2.2-4.4L5 9l4.8-1.6z" />
                  </svg>
                </span>
                AI 分组
              </button>
              <button class="primary btn-icon" @click="applyAiGrouping">
                <span class="icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M4 7h10M4 12h16M4 17h12" />
                  </svg>
                </span>
                应用分组生成新列表
              </button>
            </div>
            <div class="status" :class="aiStatus.type">{{ aiStatus.message }}</div>
          </div>
        </div>
      </div>

      <div v-if="showSaveModal" class="modal-backdrop" @click.self="closeSaveModal">
        <div class="modal">
          <div class="modal-header">
            <h3>保存所选标签页</h3>
            <button class="ghost btn-icon" @click="closeSaveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label for="list-select">目标列表</label>
              <select id="list-select" v-model="selectedListTarget">
                <option v-if="lists.length === 0" :value="NEW_LIST_VALUE">新建列表</option>
                <template v-else>
                  <option v-for="list in lists" :key="list.id" :value="list.id">
                    {{ list.name }}（{{ list.items ? list.items.length : 0 }}）
                  </option>
                  <option :value="NEW_LIST_VALUE">新建列表</option>
                </template>
              </select>
            </div>
            <div class="form-row" :class="{ hidden: selectedListTarget !== NEW_LIST_VALUE }">
              <label for="new-list-name">新建列表名称</label>
              <input
                id="new-list-name"
                type="text"
                placeholder="例如：研究资料"
                v-model="newListName"
              />
            </div>
            <div class="form-row" :class="{ hidden: selectedListTarget !== NEW_LIST_VALUE }">
              <label for="new-list-description">新建列表描述（可选）</label>
              <textarea
                id="new-list-description"
                rows="3"
                placeholder="用于指导 AI 分组，例如：工作相关、学习资料"
                v-model="newListDescription"
              ></textarea>
            </div>
            <div class="form-row checkbox-row">
              <label>
                <input type="checkbox" v-model="closeAfter" />
                保存后关闭标签页
              </label>
            </div>
            <div class="status" :class="status.type">{{ status.message }}</div>
          </div>
          <div class="modal-actions">
            <button class="ghost btn-icon" @click="closeSaveModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              取消
            </button>
            <button class="primary btn-icon" @click="saveSelectedTabs">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
                </svg>
              </span>
              保存
            </button>
          </div>
        </div>
      </div>

      <div v-if="showCreateListModal" class="modal-backdrop" @click.self="closeCreateListModal">
        <div class="modal">
          <div class="modal-header">
            <h3>新增列表</h3>
            <button class="ghost btn-icon" @click="closeCreateListModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label for="create-list-name">列表名称</label>
              <input
                id="create-list-name"
                type="text"
                placeholder="例如：项目资料"
                v-model="createListName"
              />
            </div>
            <div class="form-row">
              <label for="create-list-description">列表描述（可选）</label>
              <textarea
                id="create-list-description"
                rows="3"
                placeholder="用于指导 AI 分组"
                v-model="createListDescription"
              ></textarea>
            </div>
            <div class="status" :class="listStatus.type">{{ listStatus.message }}</div>
          </div>
          <div class="modal-actions">
            <button class="ghost btn-icon" @click="closeCreateListModal">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              取消
            </button>
            <button class="primary btn-icon" @click="confirmCreateList">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              创建列表
            </button>
          </div>
        </div>
      </div>

      <section v-show="view === 'discard'" class="view view-discard">
        <div class="content-header">
          <div>
            <h1>自动冻结调试</h1>
            <div class="content-subtitle">显示满足条件且即将被冻结的标签页</div>
          </div>
          <div class="content-actions">
            <button class="ghost btn-icon" @click="loadDiscardCandidates">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 4v6h6M20 20v-6h-6M20 8a8 8 0 0 0-14-3M4 16a8 8 0 0 0 14 3" />
                </svg>
              </span>
              刷新
            </button>
          </div>
        </div>
        <div class="panel discard-panel">
          <div class="panel-header">
            <h2>候选标签页</h2>
            <div class="panel-actions">
              <div class="discard-summary">
                共 {{ discardSummary.total }} 个，展示前 {{ discardCandidates.length }} 个
              </div>
            </div>
          </div>
          <div class="status" :class="discardDebugStatus.type">{{ discardDebugStatus.message }}</div>
          <div v-if="discardCandidates.length === 0" class="virtual-empty">暂无候选标签页。</div>
          <VirtualList
            v-else
            class="discard-list"
            :items="discardCandidates"
            :item-height="60"
          >
            <template #default="{ item }">
              <div class="tab-row discard-row">
                <img
                  class="tab-icon"
                  :class="{ hidden: !item.favIconUrl }"
                  :src="item.favIconUrl || ''"
                  @error="handleIconError($event)"
                />
                <div class="tab-body">
                  <div class="tab-title">{{ item.title || item.url || "未命名" }}</div>
                  <div class="tab-url">{{ item.url || "" }}</div>
                  <div class="discard-meta">
                    闲置 {{ item.idleMinutes }} 分钟 · 最后活跃：{{ formatLocalTime(item.lastActive) }}
                  </div>
                </div>
                <div class="tab-actions">
                  <button class="ghost tab-action btn-icon" @click.stop="discardTab(item)">
                    <span class="icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                      </svg>
                    </span>
                    冻结
                  </button>
                </div>
              </div>
            </template>
          </VirtualList>
        </div>
      </section>

      <section v-show="view === 'settings'" class="view view-settings">
        <div class="content-header">
          <div>
            <h1>插件设置</h1>
            <div class="content-subtitle">配置与偏好设置</div>
          </div>
        </div>
        <section class="panel">
          <div class="panel-header">
            <h2>AI 配置</h2>
          </div>
          <div class="form-row">
            <label for="ai-endpoint">API 端点</label>
            <input
              id="ai-endpoint"
              type="text"
              v-model="aiConfig.endpoint"
              placeholder="填写完整请求地址（如 https://api.openai.com/v1/responses）"
            />
          </div>
          <div class="form-row">
            <label for="ai-mode">API 格式</label>
            <select id="ai-mode" v-model="aiConfig.apiMode">
              <option value="responses">Responses</option>
              <option value="codex">Codex CLI</option>
              <option value="chat">Chat Completions</option>
            </select>
          </div>
          <div class="form-row">
            <label for="ai-key">API Key</label>
            <input
              id="ai-key"
              type="password"
              v-model="aiConfig.apiKey"
              placeholder="sk-..."
            />
          </div>
          <div class="form-row">
            <label for="ai-model">模型名称</label>
            <input id="ai-model" type="text" v-model="aiConfig.model" placeholder="gpt-4.1-mini" />
          </div>
          <div class="form-row">
            <label for="ai-max-tabs">单次最多标签数</label>
            <input
              id="ai-max-tabs"
              type="number"
              min="10"
              max="500"
              v-model.number="aiConfig.maxTabs"
            />
          </div>
          <div class="form-row checkbox-row">
            <label>
              <input type="checkbox" v-model="aiConfig.includeListTitles" />
              发送已有列表标题/描述作为参考
            </label>
          </div>
          <div class="form-row">
            <button class="primary btn-icon" @click="saveAiConfig">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
                </svg>
              </span>
              保存配置
            </button>
          </div>
          <div class="status" :class="settingsStatus.type">{{ settingsStatus.message }}</div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>自动冻结</h2>
          </div>
          <div class="form-row checkbox-row">
            <label>
              <input type="checkbox" v-model="discardConfig.enabled" />
              启用自动冻结（闲置时自动 discard）
            </label>
          </div>
          <div class="panel-grid">
            <div class="form-row">
              <label for="discard-idle">闲置阈值（分钟）</label>
              <input
                id="discard-idle"
                type="number"
                min="1"
                max="1440"
                v-model.number="discardConfig.idleMinutes"
              />
            </div>
            <div class="form-row">
              <label for="discard-sweep">扫描间隔（分钟）</label>
              <input
                id="discard-sweep"
                type="number"
                min="1"
                max="120"
                v-model.number="discardConfig.sweepMinutes"
              />
            </div>
            <div class="form-row">
              <label for="discard-batch">每次最多冻结</label>
              <input
                id="discard-batch"
                type="number"
                min="1"
                max="200"
                v-model.number="discardConfig.batchLimit"
              />
            </div>
          </div>
          <div class="panel-grid">
            <div class="form-row checkbox-row">
              <label>
                <input type="checkbox" v-model="discardConfig.allowPinned" />
                允许冻结已固定的标签页
              </label>
            </div>
            <div class="form-row checkbox-row">
              <label>
                <input type="checkbox" v-model="discardConfig.allowAudible" />
                允许冻结正在发声的标签页
              </label>
            </div>
          </div>
          <div class="form-row">
            <label for="discard-match-mode">白名单匹配方式</label>
            <select id="discard-match-mode" v-model="discardConfig.matchMode">
              <option value="domain">基础域名（默认）</option>
              <option value="url">URL（不含参数）</option>
              <option value="full">完整链接（含参数）</option>
            </select>
          </div>
          <div class="form-row checkbox-row">
            <label>
              <input type="checkbox" v-model="discardConfig.regexMode" />
              使用正则匹配（性能较差）
            </label>
          </div>
          <div class="form-row">
            <label for="discard-whitelist">白名单（每行一条，命中后不自动冻结）</label>
            <textarea
              id="discard-whitelist"
              rows="5"
              placeholder="例如：github.com&#10;notion.so"
              v-model="discardConfig.whitelist"
            ></textarea>
          </div>
          <div class="form-row">
            <button class="primary btn-icon" @click="saveDiscardConfig">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
                </svg>
              </span>
              保存配置
            </button>
          </div>
          <div class="status" :class="discardConfigStatus.type">{{ discardConfigStatus.message }}</div>
        </section>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import VirtualList from "./components/VirtualList.vue";

const NEW_LIST_VALUE = "__new__";
const MOVE_NEW_LIST_VALUE = "__move_new__";

const navItems = [
  {
    key: "windows",
    label: "打开的窗口",
    icon: "M4 5h16v4H4zM4 11h10v8H4zM16 11h4v8h-4z",
  },
  {
    key: "lists",
    label: "保存的列表",
    icon: "M4 6h16M4 12h16M4 18h16",
  },
  {
    key: "discard",
    label: "自动冻结调试",
    icon: "M7 5h4v14H7zM13 5h4v14h-4z",
  },
  {
    key: "settings",
    label: "插件设置",
    icon:
      "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM4 12h2m12 0h2M6.5 6.5l1.5 1.5m8-1.5-1.5 1.5M6.5 17.5l1.5-1.5m8 1.5-1.5-1.5",
  },
];

const view = ref("windows");
const windows = ref([]);
const lists = ref([]);
const selectedWindowId = ref("all");
const selectedListId = ref("");
const selectedTabIds = reactive({});
const selectedListItemKeys = reactive({});
const aiTags = reactive({});
const aiGroups = ref([]);

const status = reactive({ message: "", type: "" });
const aiStatus = reactive({ message: "", type: "" });
const listStatus = reactive({ message: "", type: "" });
const settingsStatus = reactive({ message: "", type: "" });
const discardConfigStatus = reactive({ message: "", type: "" });
const discardDebugStatus = reactive({ message: "", type: "" });

const aiConfig = reactive({
  endpoint: "",
  apiKey: "",
  model: "gpt-4.1-mini",
  apiMode: "responses",
  maxTabs: 120,
  includeListTitles: true,
});

const discardConfig = reactive({
  enabled: false,
  idleMinutes: 20,
  sweepMinutes: 3,
  batchLimit: 20,
  allowPinned: false,
  allowAudible: false,
  whitelist: "",
  matchMode: "domain",
  regexMode: false,
});

const discardCandidates = ref([]);
const discardSummary = reactive({ total: 0, updatedAt: "" });

const selectedListTarget = ref(NEW_LIST_VALUE);
const newListName = ref("");
const newListDescription = ref("");
const closeAfter = ref(false);
const importReplace = ref(false);
const listDescriptionDraft = ref("");
const isEditingListName = ref(false);
const listNameDraft = ref("");
const listNameInput = ref(null);
const moveTargetListId = ref(MOVE_NEW_LIST_VALUE);
const moveNewListName = ref("");
const showMoveModal = ref(false);
const showCreateListModal = ref(false);
const createListName = ref("");
const createListDescription = ref("");
const showAiModal = ref(false);
const showSaveModal = ref(false);

const totalTabCount = computed(() =>
  windows.value.reduce((sum, win) => sum + (win.tabs ? win.tabs.length : 0), 0)
);

const windowSubItems = computed(() =>
  windows.value.map((win, index) => ({
    id: win.id,
    label: `窗口 ${index + 1}`,
    count: win.tabs ? win.tabs.length : 0,
  }))
);

const listSubItems = computed(() =>
  lists.value.map((list) => ({
    id: list.id,
    label: list.name,
    count: list.items ? list.items.length : 0,
    description: list.description || "",
  }))
);

const moveTargetLists = computed(() =>
  lists.value.filter((list) => list.id !== selectedListId.value)
);

const windowsToRender = computed(() => {
  if (selectedWindowId.value === "all") {
    return windows.value;
  }
  return windows.value.filter(
    (win) => String(win.id) === String(selectedWindowId.value)
  );
});

const windowSubtitle = computed(() => {
  const tabCount = windowsToRender.value.reduce(
    (sum, win) => sum + (win.tabs ? win.tabs.length : 0),
    0
  );
  if (selectedWindowId.value === "all") {
    return `当前：全部窗口（共 ${tabCount} 个标签页）`;
  }
  const index = windows.value.findIndex(
    (win) => String(win.id) === String(selectedWindowId.value)
  );
  const label = index >= 0 ? `窗口 ${index + 1}` : "当前窗口";
  return `当前：${label}（共 ${tabCount} 个标签页）`;
});

const windowRows = computed(() => {
  const rows = [];
  let globalIndex = 0;
  windowsToRender.value.forEach((win) => {
    const actualIndex = windows.value.findIndex(
      (item) => String(item.id) === String(win.id)
    );
    const labelIndex = actualIndex >= 0 ? actualIndex + 1 : 1;
    rows.push({
      type: "window",
      key: `window-${win.id}`,
      label: `窗口 ${labelIndex}`,
      count: win.tabs ? win.tabs.length : 0,
    });

    const tabs = Array.isArray(win.tabs) ? win.tabs : [];
    if (tabs.length === 0) {
      rows.push({
        type: "empty",
        key: `empty-${win.id}`,
      });
      return;
    }

    tabs.forEach((tab) => {
      rows.push({
        type: "tab",
        key: `tab-${tab.id}`,
        tab: {
          id: tab.id,
          windowId: tab.windowId,
          title: tab.title,
          url: tab.url,
          favIconUrl: tab.favIconUrl,
          discarded: Boolean(tab.discarded),
          index: globalIndex,
        },
      });
      globalIndex += 1;
    });
  });
  return rows;
});

const selectedList = computed(() =>
  lists.value.find((item) => item.id === selectedListId.value) || null
);

const listTitle = computed(() => {
  if (lists.value.length === 0) {
    return "保存的列表";
  }
  return selectedList.value ? selectedList.value.name : "请选择列表";
});

const listSubtitle = computed(() => {
  if (lists.value.length === 0) {
    return "暂无列表";
  }
  const list = selectedList.value;
  if (!list) {
    return "请选择列表";
  }
  const count = list.items ? list.items.length : 0;
  const selectedCount = Object.keys(selectedListItemKeys).length;
  const suffix = selectedCount > 0 ? `，已选 ${selectedCount}` : "";
  return `共 ${count} 个标签页${suffix}`;
});

const listItems = computed(() => {
  if (lists.value.length === 0) {
    return [];
  }
  const list = lists.value.find((item) => item.id === selectedListId.value);
  if (!list || !Array.isArray(list.items)) {
    return [];
  }
  return list.items.map((item, index) => ({
    ...item,
    key: `list-${list.id}-${index}`,
    index,
  }));
});

function setStatus(target, message, type) {
  target.message = message;
  target.type = type || "";
}

function resetAiTags() {
  clearAiTags();
  aiGroups.value = [];
  setStatus(aiStatus, "", "");
}

function syncListDescription() {
  listDescriptionDraft.value = selectedList.value
    ? selectedList.value.description || ""
    : "";
}

function syncListName() {
  listNameDraft.value = selectedList.value ? selectedList.value.name || "" : "";
}

function syncMoveTarget() {
  if (!selectedList.value) {
    moveTargetListId.value = MOVE_NEW_LIST_VALUE;
    return;
  }
  const available = moveTargetLists.value;
  const current = moveTargetListId.value;
  if (current === MOVE_NEW_LIST_VALUE) {
    return;
  }
  if (!available.some((list) => list.id === current)) {
    moveTargetListId.value =
      available.length > 0 ? available[0].id : MOVE_NEW_LIST_VALUE;
  }
}

function clearListDescription() {
  listDescriptionDraft.value = "";
}

function openMoveModal() {
  if (!selectedList.value) {
    setStatus(listStatus, "请先选择一个列表。", "error");
    return;
  }
  setStatus(listStatus, "", "");
  syncMoveTarget();
  showMoveModal.value = true;
}

function closeMoveModal() {
  showMoveModal.value = false;
}

function openAiModal() {
  setStatus(aiStatus, "", "");
  showAiModal.value = true;
}

function closeAiModal() {
  showAiModal.value = false;
}

function openSaveModal() {
  setStatus(status, "", "");
  showSaveModal.value = true;
}

function closeSaveModal() {
  showSaveModal.value = false;
}

function openCreateListModal() {
  createListName.value = "";
  createListDescription.value = "";
  setStatus(listStatus, "", "");
  showCreateListModal.value = true;
}

function closeCreateListModal() {
  showCreateListModal.value = false;
}

function clearAiTags() {
  Object.keys(aiTags).forEach((key) => delete aiTags[key]);
}

function setView(nextView) {
  view.value = nextView;
  showAiModal.value = false;
  showSaveModal.value = false;
  showMoveModal.value = false;
  showCreateListModal.value = false;
  if (nextView === "discard") {
    loadDiscardCandidates();
  }
}

function setSelectedWindow(windowId) {
  selectedWindowId.value = windowId;
  Object.keys(selectedTabIds).forEach((key) => delete selectedTabIds[key]);
  resetAiTags();
}

function setSelectedList(listId) {
  selectedListId.value = listId;
  clearListSelection();
  isEditingListName.value = false;
  syncListName();
  syncListDescription();
  syncMoveTarget();
  showMoveModal.value = false;
  showCreateListModal.value = false;
}

function startEditListName() {
  if (!selectedList.value) {
    return;
  }
  isEditingListName.value = true;
  syncListName();
  nextTick(() => {
    if (listNameInput.value) {
      listNameInput.value.focus();
      listNameInput.value.select();
    }
  });
}

function cancelEditListName() {
  isEditingListName.value = false;
  syncListName();
}

async function saveListName() {
  if (!selectedList.value) {
    return;
  }
  const nextName = listNameDraft.value.trim();
  if (!nextName) {
    setStatus(listStatus, "列表名称不能为空。", "error");
    return;
  }
  const response = await request("renameList", {
    listId: selectedList.value.id,
    name: nextName,
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "重命名失败。", "error");
    return;
  }
  isEditingListName.value = false;
  setStatus(listStatus, "列表已重命名。", "ok");
  await loadLists();
}

async function moveSelectedListItems() {
  if (!selectedList.value) {
    setStatus(listStatus, "请先选择一个列表。", "error");
    return;
  }
  const indices = getSelectedListIndices();
  if (indices.length === 0) {
    setStatus(listStatus, "请先选择要移动的标签。", "error");
    return;
  }
  const isNewTarget = moveTargetListId.value === MOVE_NEW_LIST_VALUE;
  const targetListId = isNewTarget ? "" : moveTargetListId.value;
  const newListName = isNewTarget ? moveNewListName.value.trim() : "";
  if (isNewTarget && !newListName) {
    setStatus(listStatus, "请输入新建列表名称。", "error");
    return;
  }
  setStatus(listStatus, "正在移动标签...", "");
  const response = await request("moveListItems", {
    listId: selectedList.value.id,
    indices,
    targetListId,
    newListName,
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "移动失败。", "error");
    return;
  }
  const moved = response.result ? response.result.moved : 0;
  setStatus(listStatus, `已移动 ${moved} 个标签。`, "ok");
  moveNewListName.value = "";
  clearListSelection();
  await loadLists();
}

async function confirmMoveSelected() {
  await moveSelectedListItems();
  if (listStatus.type !== "error") {
    closeMoveModal();
  }
}

async function confirmCreateList() {
  const name = createListName.value.trim();
  if (!name) {
    setStatus(listStatus, "请输入列表名称。", "error");
    return;
  }
  const response = await request("createList", {
    name,
    description: createListDescription.value.trim(),
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "创建列表失败。", "error");
    return;
  }
  const created = response.result ? response.result.list : null;
  setStatus(listStatus, "列表已创建。", "ok");
  createListName.value = "";
  createListDescription.value = "";
  if (created && created.id) {
    selectedListId.value = created.id;
  }
  await loadLists();
  closeCreateListModal();
}


function setVisibleSelection(checked) {
  windowsToRender.value.forEach((win) => {
    (win.tabs || []).forEach((tab) => {
      if (checked) {
        selectedTabIds[tab.id] = true;
      } else {
        delete selectedTabIds[tab.id];
      }
    });
  });
}

function selectAllListItems() {
  listItems.value.forEach((item) => {
    selectedListItemKeys[item.key] = true;
  });
}

function clearListSelection() {
  Object.keys(selectedListItemKeys).forEach((key) => delete selectedListItemKeys[key]);
}

function toggleListItem(key, checked) {
  if (checked) {
    selectedListItemKeys[key] = true;
  } else {
    delete selectedListItemKeys[key];
  }
}

function toggleListItemSelection(key) {
  if (selectedListItemKeys[key]) {
    delete selectedListItemKeys[key];
  } else {
    selectedListItemKeys[key] = true;
  }
}

function getSelectedListIndices() {
  const indices = [];
  listItems.value.forEach((item) => {
    if (selectedListItemKeys[item.key]) {
      indices.push(item.index);
    }
  });
  return indices;
}

function toggleTab(tabId, checked) {
  if (checked) {
    selectedTabIds[tabId] = true;
  } else {
    delete selectedTabIds[tabId];
  }
}

function toggleTabSelection(tabId) {
  const key = String(tabId);
  if (selectedTabIds[key]) {
    delete selectedTabIds[key];
  } else {
    selectedTabIds[key] = true;
  }
}

function normalizeName(name) {
  return String(name || "").trim();
}

function findListByName(name) {
  const target = normalizeName(name);
  if (!target) {
    return null;
  }
  return lists.value.find((list) => normalizeName(list.name) === target) || null;
}

async function saveTabToAiGroup(tab, closeTab) {
  if (!tab || !tab.id) {
    return;
  }
  const label = normalizeName(aiTags[tab.id]);
  if (!label) {
    return;
  }
  const existing = findListByName(label);
  const response = await request("saveTabs", {
    tabIds: [tab.id],
    listId: existing ? existing.id : "",
    newListName: existing ? "" : label,
    closeTabs: Boolean(closeTab),
  });
  if (!response.ok) {
    setStatus(aiStatus, response.error || "保存到分组失败。", "error");
    return;
  }
  const actionText = closeTab ? "保存并关闭" : "保存";
  setStatus(aiStatus, `已${actionText}到列表：${label}`, "ok");
  await loadLists();
  if (closeTab) {
    await loadWindows();
  }
}

function handleIconError(event) {
  event.target.classList.add("hidden");
}

function activateTab(tab) {
  if (!tab || !tab.id) {
    return;
  }
  if (tab.windowId) {
    chrome.windows.update(tab.windowId, { focused: true });
  }
  chrome.tabs.update(tab.id, { active: true });
}

function openSavedInNewWindow(item) {
  const url = item && item.url ? String(item.url) : "";
  if (!url) {
    return;
  }
  chrome.windows.create({ url });
}

function getSelectedTabs() {
  const selected = new Set(Object.keys(selectedTabIds));
  const results = [];
  windows.value.forEach((win) => {
    (win.tabs || []).forEach((tab) => {
      if (selected.has(String(tab.id))) {
        results.push(tab);
      }
    });
  });
  return results;
}

function getBaseDomain(url) {
  if (!url) {
    return "";
  }
  try {
    const hostname = new URL(url).hostname || "";
    const cleaned = hostname.replace(/^www\./, "");
    const parts = cleaned.split(".");
    if (parts.length <= 2) {
      return cleaned;
    }
    return parts.slice(-2).join(".");
  } catch (error) {
    return "";
  }
}

function buildAiItems(tabs) {
  let index = 0;
  return tabs.map((tab) => {
    const item = {
      tabId: tab.id,
      title: tab.title || "",
      domain: getBaseDomain(tab.url),
      index,
    };
    index += 1;
    return item;
  });
}

function applyTags(groups) {
  clearAiTags();
  groups.forEach((group) => {
    const label = group.label || "未分组";
    (group.tabIds || []).forEach((tabId) => {
      aiTags[tabId] = label;
    });
  });
}

async function request(action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      resolve(response || { ok: false, error: "无响应" });
    });
  });
}

function discardTab(tab) {
  if (!tab || !tab.id) {
    return;
  }
  chrome.tabs.discard(tab.id, () => {
    if (view.value === "windows") {
      loadWindows();
    }
    if (view.value === "discard") {
      loadDiscardCandidates();
    }
  });
}

async function closeTab(tab) {
  if (!tab || !tab.id) {
    return;
  }
  chrome.tabs.remove(tab.id, () => {
    loadWindows();
  });
}

async function closeSelectedTabs() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) {
    setStatus(status, "请先选择要关闭的标签页。", "error");
    return;
  }
  const ids = selectedTabs.map((tab) => tab.id).filter(Boolean);
  chrome.tabs.remove(ids, () => {
    setStatus(status, `已关闭 ${ids.length} 个标签页。`, "ok");
    loadWindows();
  });
}

async function runAiGrouping() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) {
    setStatus(aiStatus, "请先选择需要分组的标签页。", "error");
    return;
  }
  if (!aiConfig.endpoint || !aiConfig.apiKey || !aiConfig.model) {
    setStatus(aiStatus, "请先在设置中配置 AI 端点、Key 和模型。", "error");
    return;
  }
  const items = buildAiItems(selectedTabs);
  setStatus(aiStatus, "AI 分组中...", "");
  const response = await request("aiGroupTabs", { items });
  if (!response.ok) {
    setStatus(aiStatus, response.error || "AI 分组失败。", "error");
    return;
  }
  aiGroups.value = response.result ? response.result.groups || [] : [];
  if (aiGroups.value.length === 0) {
    setStatus(aiStatus, "未生成有效分组。", "error");
    return;
  }
  applyTags(aiGroups.value);
  const truncated = response.result && response.result.truncated ? response.result.truncated : 0;
  const suffix = truncated > 0 ? `（已截断 ${truncated} 个标签页）` : "";
  setStatus(aiStatus, `已生成 ${aiGroups.value.length} 组标签。${suffix}`, "ok");
}

async function applyAiGrouping() {
  if (aiGroups.value.length === 0) {
    setStatus(aiStatus, "请先执行 AI 分组。", "error");
    return;
  }
  setStatus(aiStatus, "正在生成新列表...", "");
  const response = await request("saveGroupedTabs", { groups: aiGroups.value });
  if (!response.ok) {
    setStatus(aiStatus, response.error || "生成新列表失败。", "error");
    return;
  }
  const created = response.result ? response.result.created : 0;
  setStatus(aiStatus, `已生成 ${created} 个新列表。`, "ok");
  await loadLists();
}

async function saveSelectedTabs() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) {
    setStatus(status, "请至少选择一个标签页。", "error");
    return;
  }

  const isNewList = selectedListTarget.value === NEW_LIST_VALUE;
  const listId = isNewList ? "" : selectedListTarget.value;
  const listName = isNewList ? newListName.value.trim() : "";
  const listDescription = isNewList ? newListDescription.value.trim() : "";

  if (isNewList && !listName) {
    setStatus(status, "请输入新列表名称。", "error");
    return;
  }

  setStatus(status, "保存中...", "");
  const response = await request("saveTabs", {
    tabIds: selectedTabs.map((tab) => tab.id),
    listId,
    newListName: listName,
    newListDescription: listDescription,
    closeTabs: closeAfter.value,
  });

  if (!response.ok) {
    setStatus(status, response.error || "保存失败。", "error");
    return;
  }

  const savedCount = response.result ? response.result.savedCount : 0;
  setStatus(status, `已保存 ${savedCount} 个标签页。`, "ok");
  newListName.value = "";
  newListDescription.value = "";
  await loadLists();

  if (closeAfter.value) {
    await loadWindows();
  }
}

async function exportLists() {
  const response = await request("getLists");
  if (!response.ok) {
    setStatus(listStatus, response.error || "导出失败。", "error");
    return;
  }
  const payload = JSON.stringify({ lists: response.lists || [] }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nesoi-标签列表-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(listStatus, "已导出列表文件。", "ok");
}

async function importLists(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) {
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const lists = Array.isArray(data) ? data : data.lists;
    const mode = importReplace.value ? "replace" : "merge";
    const response = await request("importLists", { lists, mode });
    if (!response.ok) {
      setStatus(listStatus, response.error || "导入失败。", "error");
      return;
    }
    setStatus(listStatus, `已导入 ${response.result.imported} 个列表。`, "ok");
    await loadLists();
  } catch (error) {
    setStatus(listStatus, "JSON 文件无效。", "error");
  } finally {
    event.target.value = "";
  }
}

async function deleteList() {
  if (!selectedListId.value) {
    setStatus(listStatus, "请先选择一个列表。", "error");
    return;
  }
  const confirmed = window.confirm("确定要删除该列表吗？此操作不可撤销。");
  if (!confirmed) {
    return;
  }
  const response = await request("deleteList", { listId: selectedListId.value });
  if (!response.ok) {
    setStatus(listStatus, response.error || "删除列表失败。", "error");
    return;
  }
  setStatus(listStatus, "列表已删除。", "ok");
  clearListSelection();
  await loadLists();
}

async function deleteListItem(item) {
  if (!item || item.index === undefined) {
    return;
  }
  const response = await request("deleteListItems", {
    listId: selectedListId.value,
    indices: [item.index],
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "删除失败。", "error");
    return;
  }
  setStatus(listStatus, "已删除标签。", "ok");
  await loadLists();
}

async function deleteSelectedListItems() {
  if (!selectedListId.value) {
    setStatus(listStatus, "请先选择一个列表。", "error");
    return;
  }
  const indices = listItems.value
    .filter((item) => selectedListItemKeys[item.key])
    .map((item) => item.index);
  if (indices.length === 0) {
    setStatus(listStatus, "请先选择要删除的标签。", "error");
    return;
  }
  const confirmed = window.confirm(`确定删除选中的 ${indices.length} 个标签吗？`);
  if (!confirmed) {
    return;
  }
  const response = await request("deleteListItems", {
    listId: selectedListId.value,
    indices,
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "删除失败。", "error");
    return;
  }
  setStatus(listStatus, `已删除 ${indices.length} 个标签。`, "ok");
  clearListSelection();
  await loadLists();
}

async function saveListDescription() {
  if (!selectedList.value) {
    setStatus(listStatus, "请先选择列表。", "error");
    return;
  }
  const response = await request("updateListDescription", {
    listId: selectedList.value.id,
    description: listDescriptionDraft.value,
  });
  if (!response.ok) {
    setStatus(listStatus, response.error || "保存描述失败。", "error");
    return;
  }
  setStatus(listStatus, "列表描述已更新。", "ok");
  await loadLists();
}

async function loadWindows() {
  const data = await new Promise((resolve) => {
    chrome.windows.getAll({ populate: true }, (result) => resolve(result || []));
  });
  windows.value = data;
  const existing = new Set();
  windows.value.forEach((win) => {
    (win.tabs || []).forEach((tab) => {
      if (tab && tab.id) {
        existing.add(String(tab.id));
      }
    });
  });
  Object.keys(selectedTabIds).forEach((tabId) => {
    if (!existing.has(String(tabId))) {
      delete selectedTabIds[tabId];
    }
  });
  if (
    selectedWindowId.value !== "all" &&
    !windows.value.some((win) => String(win.id) === String(selectedWindowId.value))
  ) {
    selectedWindowId.value = "all";
  }
  resetAiTags();
}

async function loadLists() {
  const response = await request("getLists");
  if (!response.ok) {
    setStatus(status, response.error || "列表加载失败。", "error");
    setStatus(listStatus, response.error || "列表加载失败。", "error");
    return;
  }
  lists.value = response.lists || [];
  if (lists.value.length === 0) {
    selectedListId.value = "";
  } else if (!selectedListId.value) {
    selectedListId.value = lists.value[0].id;
  } else if (!lists.value.some((list) => list.id === selectedListId.value)) {
    selectedListId.value = lists.value[0].id;
  }
  clearListSelection();
  isEditingListName.value = false;
  syncListName();
  syncListDescription();
  syncMoveTarget();

  if (selectedListTarget.value !== NEW_LIST_VALUE) {
    const exists = lists.value.some((list) => list.id === selectedListTarget.value);
    if (!exists) {
      selectedListTarget.value = NEW_LIST_VALUE;
    }
  }
}

async function loadAiConfig() {
  const response = await request("getAiConfig");
  if (!response.ok) {
    setStatus(settingsStatus, response.error || "AI 配置加载失败。", "error");
    return;
  }
  const config = response.config || {};
  aiConfig.endpoint = config.endpoint || "https://api.openai.com/v1/responses";
  aiConfig.apiKey = config.apiKey || "";
  aiConfig.model = config.model || "gpt-4.1-mini";
  aiConfig.apiMode =
    config.apiMode === "chat" || config.apiMode === "codex" ? config.apiMode : "responses";
  aiConfig.maxTabs = Number.isFinite(config.maxTabs) ? config.maxTabs : 120;
  aiConfig.includeListTitles =
    config.includeListTitles === undefined ? true : Boolean(config.includeListTitles);
}

async function saveAiConfig() {
  if (!aiConfig.endpoint || !aiConfig.apiKey) {
    setStatus(settingsStatus, "请填写 API 端点与 Key。", "error");
    return;
  }
  const response = await request("saveAiConfig", { config: aiConfig });
  if (!response.ok) {
    setStatus(settingsStatus, response.error || "保存失败。", "error");
    return;
  }
  setStatus(settingsStatus, "AI 配置已保存。", "ok");
}

function normalizeWhitelistInput(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function applyDiscardConfig(config) {
  discardConfig.enabled = Boolean(config.enabled);
  discardConfig.idleMinutes = Number.isFinite(Number(config.idleMinutes))
    ? Number(config.idleMinutes)
    : 20;
  discardConfig.sweepMinutes = Number.isFinite(Number(config.sweepMinutes))
    ? Number(config.sweepMinutes)
    : 3;
  discardConfig.batchLimit = Number.isFinite(Number(config.batchLimit))
    ? Number(config.batchLimit)
    : 20;
  discardConfig.allowPinned = Boolean(config.allowPinned);
  discardConfig.allowAudible = Boolean(config.allowAudible);
  discardConfig.matchMode =
    config.matchMode === "url" || config.matchMode === "full" ? config.matchMode : "domain";
  discardConfig.regexMode = Boolean(config.regexMode);
  discardConfig.whitelist = Array.isArray(config.whitelist)
    ? config.whitelist.join("\n")
    : "";
}

async function loadDiscardConfig() {
  const response = await request("getDiscardConfig");
  if (!response.ok) {
    setStatus(discardConfigStatus, response.error || "自动冻结配置加载失败。", "error");
    return;
  }
  applyDiscardConfig(response.config || {});
}

async function saveDiscardConfig() {
  const whitelist = normalizeWhitelistInput(discardConfig.whitelist);
  const payload = {
    enabled: Boolean(discardConfig.enabled),
    idleMinutes: Number(discardConfig.idleMinutes),
    sweepMinutes: Number(discardConfig.sweepMinutes),
    batchLimit: Number(discardConfig.batchLimit),
    allowPinned: Boolean(discardConfig.allowPinned),
    allowAudible: Boolean(discardConfig.allowAudible),
    matchMode: discardConfig.matchMode,
    regexMode: Boolean(discardConfig.regexMode),
    whitelist,
  };
  const response = await request("saveDiscardConfig", { config: payload });
  if (!response.ok) {
    setStatus(discardConfigStatus, response.error || "保存失败。", "error");
    return;
  }
  applyDiscardConfig(response.config || payload);
  setStatus(discardConfigStatus, "自动冻结配置已保存。", "ok");
}

function formatLocalTime(timestamp) {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

async function loadDiscardCandidates() {
  setStatus(discardDebugStatus, "正在刷新候选标签页...", "");
  const response = await request("getDiscardCandidates", { limit: 200 });
  if (!response.ok) {
    setStatus(discardDebugStatus, response.error || "候选列表加载失败。", "error");
    discardCandidates.value = [];
    discardSummary.total = 0;
    return;
  }
  discardCandidates.value = (response.candidates || []).map((item) => ({
    ...item,
    key: `discard-${item.id}`,
  }));
  discardSummary.total = Number(response.total) || 0;
  discardSummary.updatedAt = new Date().toISOString();
  if (!response.enabled) {
    setStatus(discardDebugStatus, "自动冻结未开启，请先在设置中启用。", "error");
    return;
  }
  setStatus(discardDebugStatus, "候选列表已更新。", "ok");
}

onMounted(async () => {
  await loadWindows();
  await loadLists();
  await loadAiConfig();
  await loadDiscardConfig();
});
</script>
