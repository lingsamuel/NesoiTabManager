<template>
  <div class="panel tabs-panel">
    <div v-if="rows.length === 0" class="virtual-empty">{{ emptyText }}</div>
    <VirtualList
      v-else
      class="tabs"
      :items="rows"
      :item-height="itemHeight"
    >
      <template #default="{ item }">
        <div v-if="item.type === 'window'" class="window-title-row">
          {{ item.label }}<span v-if="item.count !== undefined">（{{ item.count }}）</span>
        </div>
        <div v-else-if="item.type === 'separator'" class="window-separator"></div>
        <div v-else-if="item.type === 'empty'" class="empty-row">
          {{ emptyRowText }}
        </div>
        <div v-else class="tab-row" @click="handleToggleSelection(item.tab.id)">
          <input
            type="checkbox"
            :checked="Boolean(selectedMap[item.tab.id])"
            @click.stop
            @change="handleToggleTab(item.tab.id, $event.target.checked)"
          />
          <img
            class="tab-icon"
            :class="{ hidden: !item.tab.favIconUrl }"
            :src="item.tab.favIconUrl || ''"
            @error="handleIconError($event)"
          />
          <div class="tab-body">
            <div class="tab-title">
              <span v-if="item.tab.pinned" class="pinned-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M8 4h8l-2 4v4l2 4H8l2-4V8z" />
                  <path d="M12 16v5" />
                </svg>
              </span>
              <span v-if="item.tab.discarded" class="discard-dot" aria-hidden="true"></span>
              <span class="tab-link" @click.stop="handleActivate(item.tab)">
                {{ item.tab.title || item.tab.url || "未命名" }}
              </span>
              <span
                v-if="item.tab.freezeCount && item.tab.freezeCount > 1"
                class="freeze-badge"
              >
                第{{ item.tab.freezeCount }}次冻结
              </span>
            </div>
            <div class="tab-url">
              <span class="tab-link" @click.stop="handleActivate(item.tab)">
                {{ item.tab.url || "" }}
              </span>
            </div>
          </div>
          <div class="tab-actions">
            <span
              v-if="showAiTags"
              class="tab-tag"
              :class="{ hidden: !aiTags[item.tab.id] }"
              @click.stop="handleSaveAi(item.tab, false)"
            >
              {{ aiTags[item.tab.id] || "" }}
            </span>
            <span
              v-if="showAiTags"
              class="tab-tag close"
              :class="{ hidden: !aiTags[item.tab.id] }"
              @click.stop="handleSaveAi(item.tab, true)"
            >
              保存并关闭
            </span>
            <button class="ghost tab-action danger btn-icon" @click.stop="handleClose(item.tab)">
              <span class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </span>
              关闭
            </button>
            <button class="ghost tab-action btn-icon" @click.stop="handleDiscard(item.tab)">
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
</template>

<script setup>
import VirtualList from "./VirtualList.vue";

const props = defineProps({
  rows: {
    type: Array,
    default: () => [],
  },
  itemHeight: {
    type: Number,
    default: 44,
  },
  selectedMap: {
    type: Object,
    default: () => ({}),
  },
  aiTags: {
    type: Object,
    default: () => ({}),
  },
  showAiTags: {
    type: Boolean,
    default: true,
  },
  emptyText: {
    type: String,
    default: "暂无数据。",
  },
  emptyRowText: {
    type: String,
    default: "暂无标签页。",
  },
  onToggleSelection: {
    type: Function,
    default: null,
  },
  onToggleTab: {
    type: Function,
    default: null,
  },
  onActivate: {
    type: Function,
    default: null,
  },
  onClose: {
    type: Function,
    default: null,
  },
  onDiscard: {
    type: Function,
    default: null,
  },
  onSaveAiGroup: {
    type: Function,
    default: null,
  },
});

function handleToggleSelection(tabId) {
  if (props.onToggleSelection) {
    props.onToggleSelection(tabId);
  }
}

function handleToggleTab(tabId, checked) {
  if (props.onToggleTab) {
    props.onToggleTab(tabId, checked);
  }
}

function handleActivate(tab) {
  if (props.onActivate) {
    props.onActivate(tab);
  }
}

function handleClose(tab) {
  if (props.onClose) {
    props.onClose(tab);
  }
}

function handleDiscard(tab) {
  if (props.onDiscard) {
    props.onDiscard(tab);
  }
}

function handleSaveAi(tab, closeTab) {
  if (props.onSaveAiGroup) {
    props.onSaveAiGroup(tab, closeTab);
  }
}

function handleIconError(event) {
  event.target.classList.add("hidden");
}
</script>
