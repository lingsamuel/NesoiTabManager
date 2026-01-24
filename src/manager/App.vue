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
          {{ item.label }}
        </button>
      </nav>
    </aside>

    <aside class="sub-sidebar" :class="{ hidden: view === 'settings' }">
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
        </template>
      </div>
    </aside>

    <main class="content">
      <section v-show="view === 'windows'" class="view active">
        <div class="content-header">
          <div>
            <h1>打开的窗口</h1>
            <div class="content-subtitle">{{ windowSubtitle }}</div>
          </div>
          <div class="content-actions">
            <button class="ghost" @click="setVisibleSelection(true)">全选</button>
            <button class="ghost" @click="setVisibleSelection(false)">清空</button>
            <button class="ghost danger" @click="closeSelectedTabs">关闭所选</button>
          </div>
        </div>

        <div class="panel">
          <div v-if="windowRows.length === 0" class="virtual-empty">未找到打开的标签页。</div>
          <VirtualList
            v-else
            class="tabs"
            :items="windowRows"
            :item-height="54"
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
                  <span class="tab-tag" :class="{ hidden: !aiTags[item.tab.id] }">
                    {{ aiTags[item.tab.id] || "" }}
                  </span>
                  <button class="ghost tab-action danger" @click.stop="closeTab(item.tab)">
                    关闭
                  </button>
                </div>
              </div>
            </template>
          </VirtualList>
        </div>

        <div class="panel-grid">
          <section class="panel">
            <div class="panel-header">
              <h2>AI 分组</h2>
            </div>
            <div class="form-row">
              <div class="hint">仅使用标题与基础域名，并结合打开顺序生成标签。</div>
            </div>
            <div class="form-row ai-actions">
              <button class="ghost" @click="runAiGrouping">AI 分组</button>
              <button class="primary" @click="applyAiGrouping">应用分组生成新列表</button>
            </div>
            <div class="status" :class="aiStatus.type">{{ aiStatus.message }}</div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2>保存选择</h2>
            </div>
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
            <div class="form-row">
              <button class="primary" @click="saveSelectedTabs">保存所选标签页</button>
            </div>
            <div class="status" :class="status.type">{{ status.message }}</div>
          </section>
        </div>
      </section>

      <section v-show="view === 'lists'" class="view">
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
              <button class="ghost" @click="cancelEditListName">取消</button>
              <button class="primary" @click="saveListName">保存</button>
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
            <button class="ghost" @click="selectAllListItems">全选</button>
            <button class="ghost" @click="clearListSelection">清空</button>
            <button class="ghost danger" @click="deleteSelectedListItems">删除所选</button>
            <button class="ghost danger" @click="deleteList">删除列表</button>
            <button class="ghost" @click="exportLists">导出列表</button>
            <label class="ghost import-label" for="import-file">导入列表</label>
            <input id="import-file" type="file" accept="application/json" @change="importLists" />
          </div>
        </div>

        <section class="panel">
          <div class="panel-header">
            <h2>列表描述</h2>
            <div class="panel-actions">
              <button class="ghost" :disabled="!selectedList" @click="clearListDescription">
                清空
              </button>
              <button class="primary" :disabled="!selectedList" @click="saveListDescription">
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

        <div class="panel">
          <div v-if="listItems.length === 0" class="virtual-empty">暂无已保存的列表。</div>
          <VirtualList
            v-else
            class="list-items"
            :items="listItems"
            :item-height="92"
          >
            <template #default="{ item }">
              <div
                class="list-item"
                :class="{ selected: Boolean(selectedListItemKeys[item.key]) }"
                @click="toggleListItemSelection(item.key)"
              >
                <div class="list-top">
                  <input
                    type="checkbox"
                    :checked="Boolean(selectedListItemKeys[item.key])"
                    @click.stop
                    @change="toggleListItem(item.key, $event.target.checked)"
                  />
                  <div class="list-header">
                    <img
                      class="list-icon"
                      :class="{ hidden: !item.favIconUrl }"
                      :src="item.favIconUrl || ''"
                      @error="handleIconError($event)"
                    />
                    <div class="list-title">{{ item.title || item.url || "未命名" }}</div>
                  </div>
                  <button
                    class="ghost list-action danger"
                    @click.stop="deleteListItem(item)"
                  >
                    删除
                  </button>
                </div>
                <div class="list-url">{{ item.url || "" }}</div>
                <div v-if="item.savedAt" class="list-meta">保存时间：{{ item.savedAt }}</div>
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

      <section v-show="view === 'settings'" class="view">
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
            <button class="primary" @click="saveAiConfig">保存配置</button>
          </div>
          <div class="status" :class="settingsStatus.type">{{ settingsStatus.message }}</div>
        </section>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import VirtualList from "./components/VirtualList.vue";

const NEW_LIST_VALUE = "__new__";

const navItems = [
  { key: "windows", label: "打开的窗口" },
  { key: "lists", label: "保存的列表" },
  { key: "settings", label: "插件设置" },
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

const aiConfig = reactive({
  endpoint: "",
  apiKey: "",
  model: "gpt-4.1-mini",
  apiMode: "responses",
  maxTabs: 120,
  includeListTitles: true,
});

const selectedListTarget = ref(NEW_LIST_VALUE);
const newListName = ref("");
const newListDescription = ref("");
const closeAfter = ref(false);
const importReplace = ref(false);
const listDescriptionDraft = ref("");
const isEditingListName = ref(false);
const listNameDraft = ref("");
const listNameInput = ref(null);

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

function clearListDescription() {
  listDescriptionDraft.value = "";
}

function clearAiTags() {
  Object.keys(aiTags).forEach((key) => delete aiTags[key]);
}

function setView(nextView) {
  view.value = nextView;
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

onMounted(async () => {
  await loadWindows();
  await loadLists();
  await loadAiConfig();
});
</script>
