<template>
  <div class="panel list-panel">
    <div v-if="items.length === 0" class="virtual-empty">{{ emptyText }}</div>
    <div v-else ref="wrapperRef" class="track-host">
      <VirtualList
        ref="listRef"
        class="list-items"
        :items="items"
        :item-height="itemHeight"
        :current-match-index="currentMatchIndex"
        :auto-scroll-to-match="autoScrollToMatch"
        @range-change="emit('visible-range', $event)"
      >
        <template #default="{ item, index }">
          <div
            class="list-item"
            :class="{
              selected: Boolean(selectedMap[item.key]),
              matched: highlightMatches && Boolean(item.matched),
              'match-current': index === currentMatchIndex,
            }"
            @click="handleToggleSelection(item.key)"
          >
            <input
              type="checkbox"
              :checked="Boolean(selectedMap[item.key])"
              @click.stop
              @change="handleToggleItem(item.key, $event.target.checked)"
            />
            <TabFavicon class="list-icon" :url="item.favIconUrl" />
            <div class="list-body">
              <div class="list-title">
                <span class="list-link" @click.stop="handleOpen(item)">
                  {{ item.title || item.url || "未命名" }}
                </span>
              </div>
              <div class="list-url">
                <span class="list-link" @click.stop="handleOpen(item)">
                  {{ item.url || "" }}
                </span>
              </div>
              <div v-if="item.savedAt" class="list-meta">保存时间：{{ item.savedAt }}</div>
            </div>
            <button class="ghost list-action danger btn-icon" @click.stop="handleDelete(item)">
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

      <!-- 标记层放在滚动容器外面，否则会跟着内容一起滚走；管理页滚动条在右侧 -->
      <div v-if="markers.length > 0" class="track-marks on-right">
        <button
          v-for="marker in markers"
          :key="marker.key"
          type="button"
          class="track-mark"
          :class="marker.kind"
          :style="{ top: `${marker.top}px` }"
          :title="markerTitle(marker)"
          @click.stop="onMarkerClick(marker)"
        ></button>
      </div>
    </div>
  </div>
</template>

<script setup>
// 保存列表的列表面板。
//
// 为什么不复用 TabListPanel：后者的行模型是"活标签"（有 active/pinned/discarded/父子/冻结/关闭），
// 而保存项只有 url/title/savedAt，多出来的那些列在语义上不成立。
// 但**滚动条轨道刻度**这部分与标签视图必须一致（搜索匹配刻度、当前匹配高亮），
// 因此这里复用同一个刻度层组件与同一份纯逻辑 buildTrackMarkers，只是行数据来源不同。

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import VirtualList from "./VirtualList.vue";
import TabFavicon from "./TabFavicon.vue";
import { buildTrackMarkers } from "../utils/scroll_markers.js";

const emit = defineEmits(["marker-click", "visible-range"]);

const props = defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  itemHeight: {
    type: Number,
    default: 64,
  },
  selectedMap: {
    type: Object,
    default: () => ({}),
  },
  highlightMatches: {
    type: Boolean,
    default: false,
  },
  currentMatchIndex: {
    type: Number,
    default: -1,
  },
  // 与标签视图同一条权衡：调用方若在滚动时同步"当前项"，就不能再让它触发自动滚动。
  autoScrollToMatch: {
    type: Boolean,
    default: true,
  },
  emptyText: {
    type: String,
    default: "暂无已保存的标签。",
  },
  onToggleSelection: {
    type: Function,
    default: null,
  },
  onToggleItem: {
    type: Function,
    default: null,
  },
  onDeleteItem: {
    type: Function,
    default: null,
  },
  onOpenItem: {
    type: Function,
    default: null,
  },
});

const listRef = ref(null);
const wrapperRef = ref(null);
// 轨道高度 = 滚动容器自身高度：刻度按 (行序号 + 0.5) / 总行数 的比例落在它上面。
const trackHeight = ref(0);
let trackResizeObserver = null;

function handleToggleSelection(key) {
  if (props.onToggleSelection) {
    props.onToggleSelection(key);
  }
}

function handleToggleItem(key, checked) {
  if (props.onToggleItem) {
    props.onToggleItem(key, checked);
  }
}

function handleDelete(item) {
  if (props.onDeleteItem) {
    props.onDeleteItem(item);
  }
}

function handleOpen(item) {
  if (props.onOpenItem) {
    props.onOpenItem(item);
  }
}

/**
 * 刻度的行模型：只需要"唯一 id"与"是否匹配"两个字段。
 * id 用保存项的 key（已含所属列表 id 与原始下标），保证左列表右列表切换后 key 不会串。
 */
const trackRows = computed(() =>
  props.items.map((item) => ({
    id: item.key,
    matched: Boolean(item.matched),
  }))
);

const markers = computed(() =>
  buildTrackMarkers({
    rows: trackRows.value,
    highlightMatches: props.highlightMatches,
    currentMatchIndex: props.currentMatchIndex,
    trackHeight: trackHeight.value,
  })
);

function markerTitle(marker) {
  const isMatch = marker.kind === "match" || marker.kind === "match-current";
  if (marker.merged) {
    return `跳转到这 ${marker.count} 个匹配项`;
  }
  return isMatch ? "跳转到该匹配项" : "跳转到该项";
}

function onMarkerClick(marker) {
  emit("marker-click", { index: marker.index, kind: marker.kind, matchIndex: marker.matchIndex });
}

function updateTrackHeight() {
  trackHeight.value = wrapperRef.value ? wrapperRef.value.clientHeight || 0 : 0;
}

/** 把观察器挂到当前存在的滚动容器上（不存在就只清空，等它出现时再挂）。 */
function attachTrackObserver() {
  if (!trackResizeObserver) {
    return;
  }
  trackResizeObserver.disconnect();
  updateTrackHeight();
  if (wrapperRef.value) {
    trackResizeObserver.observe(wrapperRef.value);
  }
}

onMounted(() => {
  trackResizeObserver = new ResizeObserver(updateTrackHeight);
  attachTrackObserver();
});

/*
  与 TabListPanel 同样的理由：数据到达前渲染的是"空状态"分支（没有 .track-host），
  那时 wrapperRef 是 null、观察器无处可挂；等数据到达滚动容器才出现，必须重新挂一次，
  否则 trackHeight 一直是 0，所有刻度都会叠在轨道顶端并被合并成一条。
*/
watch(wrapperRef, () => {
  attachTrackObserver();
});

onBeforeUnmount(() => {
  if (trackResizeObserver) {
    trackResizeObserver.disconnect();
    trackResizeObserver = null;
  }
});

defineExpose({
  scrollToIndex(index) {
    if (listRef.value && listRef.value.scrollToIndex) {
      listRef.value.scrollToIndex(index);
    }
  },
});
</script>
