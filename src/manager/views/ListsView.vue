<template>
  <section class="view view-lists">
    <div class="content-header">
      <div class="content-title">
        <div v-if="isEditingListName" class="title-edit">
          <input
            ref="listNameInput"
            class="title-input"
            type="text"
            :value="listNameDraft"
            @input="onUpdateListNameDraft($event.target.value)"
            @keydown.enter.prevent="onSaveListName"
            @keydown.esc.prevent="onCancelEditListName"
          />
          <button class="ghost btn-icon" @click="onCancelEditListName">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6l-12 12" />
              </svg>
            </span>
            取消
          </button>
          <button class="primary btn-icon" @click="onSaveListName">
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
          @click="onStartEditListName"
        >
          {{ listTitle }}
        </h1>
        <div class="content-subtitle">{{ listSubtitle }}</div>
      </div>
      <div class="content-actions">
        <FilterInput
          :model-value="filterQuery"
          placeholder="筛选标题或网址"
          @update:model-value="onUpdateFilterQuery"
          @commit="onCommitFilterQuery"
        />
        <button class="ghost btn-icon" @click="onSelectAllListItems">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
          全选
        </button>
        <button class="ghost btn-icon" @click="onClearListSelection">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </span>
          清空
        </button>
        <button class="ghost danger btn-icon" @click="onDeleteSelectedListItems">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 7h16M9 7v10M15 7v10M6 7l1-3h10l1 3M7 20h10" />
            </svg>
          </span>
          删除所选
        </button>
        <button class="ghost btn-icon" :disabled="!selectedList" @click="onOpenMoveModal">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
          移动所选
        </button>
        <button class="ghost danger btn-icon" @click="onDeleteList">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 7h16M9 7v10M15 7v10M6 7l1-3h10l1 3M7 20h10" />
            </svg>
          </span>
          删除列表
        </button>
        <button class="ghost btn-icon" @click="onExportLists">
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
        <input id="import-file" type="file" accept="application/json" @change="onImportLists" />
      </div>
    </div>

    <section class="panel">
      <div class="panel-header">
        <h2>列表描述</h2>
        <div class="panel-actions">
          <button class="ghost btn-icon" :disabled="!selectedList" @click="onClearListDescription">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6l-12 12" />
              </svg>
            </span>
            清空
          </button>
          <button class="primary btn-icon" :disabled="!selectedList" @click="onSaveListDescription">
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
          :value="listDescriptionDraft"
          @input="onUpdateListDescriptionDraft($event.target.value)"
        ></textarea>
      </div>
    </section>

    <div class="panel list-panel">
      <div v-if="listItems.length === 0" class="virtual-empty">{{ emptyText }}</div>
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
            @click="onToggleListItemSelection(item.key)"
          >
            <input
              type="checkbox"
              :checked="Boolean(selectedListItemKeys[item.key])"
              @click.stop
              @change="onToggleListItem(item.key, $event.target.checked)"
            />
            <img
              class="list-icon"
              :class="{ hidden: !item.favIconUrl }"
              :src="item.favIconUrl || ''"
              @error="handleIconError($event)"
            />
            <div class="list-body">
              <div class="list-title">
                <span class="list-link" @click.stop="onOpenSavedInNewWindow(item)">
                  {{ item.title || item.url || "未命名" }}
                </span>
              </div>
              <div class="list-url">
                <span class="list-link" @click.stop="onOpenSavedInNewWindow(item)">
                  {{ item.url || "" }}
                </span>
              </div>
              <div v-if="item.savedAt" class="list-meta">保存时间：{{ item.savedAt }}</div>
            </div>
            <button class="ghost list-action danger btn-icon" @click.stop="onDeleteListItem(item)">
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
          <input
            type="checkbox"
            :checked="importReplace"
            @change="onUpdateImportReplace($event.target.checked)"
          />
          导入时替换现有列表
        </label>
      </div>
      <div class="status" :class="listStatus.type">{{ listStatus.message }}</div>
    </section>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";
import FilterInput from "../components/FilterInput.vue";
import VirtualList from "../components/VirtualList.vue";

const props = defineProps({
  isEditingListName: {
    type: Boolean,
    default: false,
  },
  listNameDraft: {
    type: String,
    default: "",
  },
  listTitle: {
    type: String,
    default: "",
  },
  listSubtitle: {
    type: String,
    default: "",
  },
  selectedList: {
    type: Object,
    default: null,
  },
  listItems: {
    type: Array,
    default: () => [],
  },
  filterQuery: {
    type: String,
    default: "",
  },
  selectedListItemKeys: {
    type: Object,
    default: () => ({}),
  },
  listDescriptionDraft: {
    type: String,
    default: "",
  },
  listStatus: {
    type: Object,
    default: () => ({ message: "", type: "" }),
  },
  importReplace: {
    type: Boolean,
    default: false,
  },
  onUpdateFilterQuery: {
    type: Function,
    default: null,
  },
  onCommitFilterQuery: {
    type: Function,
    default: null,
  },
  onUpdateListNameDraft: {
    type: Function,
    default: null,
  },
  onUpdateListDescriptionDraft: {
    type: Function,
    default: null,
  },
  onUpdateImportReplace: {
    type: Function,
    default: null,
  },
  onStartEditListName: {
    type: Function,
    default: null,
  },
  onCancelEditListName: {
    type: Function,
    default: null,
  },
  onSaveListName: {
    type: Function,
    default: null,
  },
  onSelectAllListItems: {
    type: Function,
    default: null,
  },
  onClearListSelection: {
    type: Function,
    default: null,
  },
  onDeleteSelectedListItems: {
    type: Function,
    default: null,
  },
  onOpenMoveModal: {
    type: Function,
    default: null,
  },
  onDeleteList: {
    type: Function,
    default: null,
  },
  onExportLists: {
    type: Function,
    default: null,
  },
  onImportLists: {
    type: Function,
    default: null,
  },
  onOpenSavedInNewWindow: {
    type: Function,
    default: null,
  },
  onToggleListItemSelection: {
    type: Function,
    default: null,
  },
  onToggleListItem: {
    type: Function,
    default: null,
  },
  onDeleteListItem: {
    type: Function,
    default: null,
  },
  onClearListDescription: {
    type: Function,
    default: null,
  },
  onSaveListDescription: {
    type: Function,
    default: null,
  },
});

const emptyText = computed(() =>
  props.filterQuery ? "未找到匹配的标签页。" : "暂无已保存的列表。"
);

const listNameInput = ref(null);

watch(
  () => props.isEditingListName,
  (active) => {
    if (!active) {
      return;
    }
    nextTick(() => {
      if (listNameInput.value) {
        listNameInput.value.focus();
        listNameInput.value.select();
      }
    });
  }
);

function handleIconError(event) {
  event.target.classList.add("hidden");
}
</script>
