// 管理页「打开的窗口」的外部变更同步。
//
// 为什么需要它：管理页是常驻页面——点扩展图标或侧边栏「打开管理界面」时，只要已经有管理页标签
// 就复用（聚焦窗口 + 激活标签），不会重新挂载。若只在挂载时取一次数据，用户在别处开关/移动标签后
// 切回管理页看到的就是过期快照，表现为"必须手动刷新"。
//
// 设计要点（与 Firefox 侧边栏同一套口径，见 docs/ui/firefox_sidebar.md）：
// - 事件驱动的防抖合并：批量关闭/拖动/冻结会连续触发事件，不合并会把刷新次数放大成事件条数；
// - 只在"页面可见 + 当前视图是打开的窗口"时才真的查询：树状模式下一次刷新还要额外拉父子映射，
//   在错误的视图或后台标签页上刷新纯属浪费；
// - 不可见期间只置 pending，回到可见时补一次；切回本视图由 App 的 setView 负责刷新，
//   因此"视图不对"不设等待标记（否则会在用户已经离开本视图时留下一堆无意义的补刷）。
//
// 本模块不依赖 Vue，也不直接依赖浏览器：chrome / document 由调用方注入，
// 因此可以在 Node 里用假事件对象把调度逻辑完整测一遍（scripts/test_manager_sync.mjs）。

/** 结构类事件的合并窗口：10K 标签下一次刷新要取回整窗数据，必须避免逐事件刷新。 */
const REFRESH_DEBOUNCE_MS = 250;

// 影响列表展示的 onUpdated 字段。页面加载期间还会因 status / audible 等字段连续触发，
// 不过滤就会把防抖窗口填满无意义的整表查询（与侧边栏同一份名单）。
const RELEVANT_TAB_CHANGE_KEYS = [
  "title",
  "url",
  "favIconUrl",
  "discarded",
  "pinned",
  "mutedInfo",
];

/** 取某个 chrome.tabs / chrome.windows 事件对象；不存在或类型不对时返回 null。 */
function getEventTarget(chromeApi, event) {
  const target = chromeApi && chromeApi[event];
  if (!target || typeof target.addListener !== "function") {
    return null;
  }
  return target;
}

function windowIdOf(value) {
  const id = Number(value);
  return Number.isFinite(id) ? id : undefined;
}

/**
 * 事件来源窗口的提取函数集合。
 * 每个函数返回事件涉及的 windowId；返回 undefined 表示"这个事件不影响列表展示"。
 * onUpdated 只在影响显示的字段变化时才返回窗口，onActivated 不在其列（激活不影响标签内容，
 * 它单独用于判断"被激活的是不是管理页自己"）。
 */
const TAB_EVENT_SOURCES = {
  onCreated: (tab) => (tab ? windowIdOf(tab.windowId) : undefined),
  onRemoved: (_tabId, removeInfo) => (removeInfo ? windowIdOf(removeInfo.windowId) : undefined),
  onMoved: (_tabId, moveInfo) => (moveInfo ? windowIdOf(moveInfo.windowId) : undefined),
  onAttached: (_tabId, attachInfo) => (attachInfo ? windowIdOf(attachInfo.newWindowId) : undefined),
  onDetached: (_tabId, detachInfo) => (detachInfo ? windowIdOf(detachInfo.oldWindowId) : undefined),
  onUpdated: (_tabId, changeInfo, tab) => {
    if (!changeInfo) {
      return undefined;
    }
    const relevant = RELEVANT_TAB_CHANGE_KEYS.some((key) => key in changeInfo);
    return relevant && tab ? windowIdOf(tab.windowId) : undefined;
  },
};

const WINDOW_EVENT_SOURCES = {
  onCreated: (win) => (win ? windowIdOf(win.id) : undefined),
  onRemoved: (windowId) => windowIdOf(windowId),
};

/** 监听名单：管理页关注标签的增删移与 window 的开合，标签的"移入移出窗口"同样经由这里覆盖。 */
const WATCHED_TAB_EVENTS = Object.keys(TAB_EVENT_SOURCES);
const WATCHED_WINDOW_EVENTS = Object.keys(WINDOW_EVENT_SOURCES);

/**
 * 判断被激活的是不是管理页自己。
 *
 * 复用入口（扩展图标 / 侧边栏管理按钮）只会"聚焦窗口 + 激活标签"，不会重新加载页面，
 * 因此这里补一次刷新，让用户切回来时看到的就是最新数据。
 * 用 tabId 比较而不是 windowId：管理页所在的窗口里还有别的标签，只比窗口会把
 * "切到同窗口的普通标签"也当成管理页被激活。
 */
function isManagerSelfActivation(activeInfo, selfTabId) {
  if (!activeInfo || selfTabId === null || selfTabId === undefined) {
    return false;
  }
  const activatedTabId = Number(activeInfo.tabId);
  return Number.isFinite(activatedTabId) && activatedTabId === Number(selfTabId);
}

/**
 * 防抖刷新调度器：把「结构/内容变化」与「页面重新可见」两类触发合并成一次真正的刷新。
 *
 * 行为约定：
 * - pending 只在真正执行刷新时清空；因"页面不可见"被推迟的刷新会留下 waitingVisible 标记，
 *   等重新可见时补一次；因"视图不对"被推迟的不留标记（切回本视图时 App 会自己刷新）。
 * - 同一时刻最多存在一个定时器；每次 schedule 都重置计时，保证连续事件只刷新一次。
 * - 回调异常一律吞掉并只记 console，避免把错误抛进事件监听器影响后续事件。
 *
 * @param {object} deps
 * @param {(...args) => any} deps.refresh 真正的刷新动作（管理页传 refreshWindows）。
 * @param {() => boolean} deps.canRefresh 此刻是否允许查询（可见 + 视图正确）。
 * @param {() => boolean} deps.isVisible 页面当前是否可见。
 * @param {object} [deps.setTimeout] / [deps.clearTimeout] 便于测试注入假定时器。
 * @param {number} [deps.delay] 防抖窗口，缺省 250ms；测试可缩短。
 */
function createRefreshQueue(deps = {}) {
  const { refresh, canRefresh, isVisible, delay } = deps;
  // 定时器必须允许注入：测试要用假定时器把"防抖合并"这件事确定性地验证出来，
  // 否则只能靠真实等待 250ms，既慢又不稳定。
  const scheduleTimer =
    typeof deps.setTimeout === "function" ? deps.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const cancelTimer =
    typeof deps.clearTimeout === "function" ? deps.clearTimeout : (timer) => clearTimeout(timer);
  const wait = Number.isFinite(Number(delay)) ? Number(delay) : REFRESH_DEBOUNCE_MS;

  let pending = false;
  let waitingVisible = false;
  let timer = null;

  function clearPendingTimer() {
    if (timer !== null) {
      cancelTimer(timer);
      timer = null;
    }
  }

  function flush() {
    clearPendingTimer();
    const wasPending = pending;
    pending = false;
    if (!wasPending) {
      return;
    }
    if (!canRefresh()) {
      // 被推迟的原因分两种：不可见要补刷，视图不对则由切回本视图负责。
      if (!isVisible()) {
        waitingVisible = true;
      }
      return;
    }
    Promise.resolve()
      .then(() => refresh())
      .catch((error) => {
        console.warn(
          "管理页刷新窗口数据失败：",
          String(error && error.message ? error.message : error)
        );
      });
  }

  /**
   * 排入一次刷新。
   * @param {boolean} immediate 为 true 时（例如管理页自己被激活）立即冲刷，不再等防抖窗口——
   *   用户已经盯着页面了，晚 250ms 才更新会显得列表"卡了一下"。
   */
  function schedule(immediate = false) {
    pending = true;
    if (immediate) {
      flush();
      return;
    }
    clearPendingTimer();
    timer = scheduleTimer(flush, wait);
  }

  /** 页面可见性变化：从不可见回到可见，且期间被推迟过刷新，就补一次。 */
  function setVisible(nextVisible) {
    if (!nextVisible) {
      return;
    }
    if (!waitingVisible) {
      return;
    }
    waitingVisible = false;
    schedule();
  }

  return {
    schedule,
    setVisible,
    dispose() {
      clearPendingTimer();
      pending = false;
      waitingVisible = false;
    },
  };
}

/**
 * 组装管理页「打开的窗口」的事件订阅。
 *
 * @param {object} options
 * @param {object} [options.chrome] chrome 命名空间（缺省用全局 chrome，便于测试注入假对象）。
 * @param {object} [options.document] 用于读取 visibilityState（缺省用全局 document）。
 * @param {() => boolean} options.canRefresh 是否允许此刻刷新（可见 + 当前视图是打开的窗口）。
 * @param {() => Promise<any>} options.refresh 真正的刷新动作。
 * @param {number} [options.delay] 防抖窗口（测试用）。
 * @param {Function} [options.onError] 绑定/解绑失败时的提示回调（缺省 console.warn）。
 * @returns {{ start: () => void, setSelfTabId: (id: number|null) => void, dispose: () => void }}
 */
function useWindowsSync(options = {}) {
  const chromeApi = options.chrome || (typeof chrome !== "undefined" ? chrome : null);
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  const refresh = options.refresh;
  const canRefresh = options.canRefresh || (() => true);
  const delay = options.delay;
  const reportError =
    options.onError ||
    ((...args) => {
      console.warn(...args);
    });

  // 本页自己的标签 id：只有"被激活的是管理页自己"才补刷新，避免切到同窗口的普通标签也刷新。
  let selfTabId = null;
  let disposed = false;
  // 已注册的监听器，dispose 时逐一摘掉（页面卸载时浏览器也会回收，但管理页可能被复用，
  // 显式清理能让重复挂载不叠加监听）。
  const bound = [];

  function isVisible() {
    return doc ? doc.visibilityState === "visible" : true;
  }

  const queue = createRefreshQueue({
    refresh,
    canRefresh: () => canRefresh() && isVisible(),
    isVisible,
    delay,
    // 定时器一路透传，测试才能在 Node 里用假定时器确定性地验证防抖合并。
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
  });

  function bindEvent(target, handler, label) {
    if (!target) {
      return;
    }
    try {
      target.addListener(handler);
    } catch (error) {
      // 浏览器差异导致某个事件不可用：少一条同步路径，但不该让整个页面挂掉。
      reportError(`管理页订阅 ${label} 失败：`, String(error && error.message ? error.message : error));
      return;
    }
    bound.push(() => {
      try {
        target.removeListener(handler);
      } catch (error) {
        // 卸载阶段失败没有补救价值，静默即可。
      }
    });
  }

  /**
   * 订阅标签与窗口事件。
   * 只订阅"会改变列表展示"的事件；窗口事件用于窗口开合（onActivated 单独处理）。
   */
  function bindEvents() {
    for (const event of WATCHED_TAB_EVENTS) {
      const extract = TAB_EVENT_SOURCES[event];
      bindEvent(
        getEventTarget(chromeApi && chromeApi.tabs, event),
        (...args) => {
          if (extract(...args) === undefined) {
            // 提取函数返回 undefined = 这个事件不影响展示（例如 onUpdated 只改了 status）。
            return;
          }
          queue.schedule();
        },
        `tabs.${event}`
      );
    }

    for (const event of WATCHED_WINDOW_EVENTS) {
      const extract = WINDOW_EVENT_SOURCES[event];
      bindEvent(
        getEventTarget(chromeApi && chromeApi.windows, event),
        (...args) => {
          if (extract(...args) === undefined) {
            return;
          }
          queue.schedule();
        },
        `windows.${event}`
      );
    }

    bindEvent(
      getEventTarget(chromeApi && chromeApi.tabs, "onActivated"),
      (activeInfo) => {
        if (!isManagerSelfActivation(activeInfo, selfTabId)) {
          return;
        }
        queue.schedule(true);
      },
      "tabs.onActivated"
    );

    if (doc && typeof doc.addEventListener === "function") {
      const onVisibilityChange = () => {
        // 不可见时什么都不做：事件到达时会走 schedule，由队列自行推迟。
        queue.setVisible(isVisible());
      };
      doc.addEventListener("visibilitychange", onVisibilityChange);
      bound.push(() => doc.removeEventListener("visibilitychange", onVisibilityChange));
    }
  }

  return {
    /** 挂上全部监听。由 App 在挂载时调用一次。 */
    start() {
      if (disposed) {
        return;
      }
      bindEvents();
    },
    /**
     * 告诉同步层"管理页自己"是哪个标签页。
     * 需要异步查询（chrome.tabs.getCurrent），因此与 start() 分开，避免阻塞挂载流程。
     */
    setSelfTabId(tabId) {
      const id = Number(tabId);
      selfTabId = Number.isFinite(id) ? id : null;
    },
    /** 摘掉全部监听并清掉未执行的防抖定时器。 */
    dispose() {
      disposed = true;
      queue.dispose();
      for (const cleanup of bound.splice(0)) {
        cleanup();
      }
    },
  };
}

export {
  REFRESH_DEBOUNCE_MS,
  RELEVANT_TAB_CHANGE_KEYS,
  TAB_EVENT_SOURCES,
  WINDOW_EVENT_SOURCES,
  createRefreshQueue,
  isManagerSelfActivation,
  useWindowsSync,
};
