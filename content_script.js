(() => {
  const WIDGET_ID = "nesoi-tab-manager-widget";

  if (document.getElementById(WIDGET_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.textContent = `
    #${WIDGET_ID} {
      position: fixed;
      bottom: 14px;
      left: 0;
      z-index: 2147483647;
      font-family: "Space Grotesk", "Segoe UI", Tahoma, sans-serif;
      color: #1e1b16;
      pointer-events: auto;
      width: 72px;
      height: 72px;
      transform: translateX(0);
      transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
    }

    #${WIDGET_ID}.expanded {
      transform: translateX(12px);
    }

    #${WIDGET_ID} .ntm-hotzone {
      width: 72px;
      height: 72px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      padding-left: 0;
      border-radius: 999px;
      background: transparent;
    }

    #${WIDGET_ID} .ntm-handle {
      position: relative;
      width: 36px;
      height: 32px;
      background: #ffffff;
      color: #6b7280;
      border-radius: 0 16px 16px 0;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.3px;
      border: 1px solid #d1d5db;
      box-shadow: 0 6px 14px rgba(17, 24, 39, 0.12);
      cursor: default;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, border-radius 0.2s ease, width 0.2s ease, height 0.2s ease;
    }

    #${WIDGET_ID} .ntm-hotzone:hover .ntm-handle {
      transform: translateX(6px) scale(1.03);
      box-shadow: 0 8px 16px rgba(17, 24, 39, 0.16);
    }

    #${WIDGET_ID}.expanded .ntm-handle {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      transform: translateX(8px) scale(1.04);
      box-shadow: 0 10px 18px rgba(17, 24, 39, 0.16);
    }

    #${WIDGET_ID} .ntm-panel {
      position: absolute;
      left: 0;
      bottom: 78px;
      width: 220px;
      max-height: 280px;
      overflow: hidden;
      opacity: 0;
      transform: translateY(10px) scale(0.96);
      transform-origin: bottom left;
      background: rgba(255, 255, 255, 0.96);
      border-radius: 16px;
      box-shadow: none;
      border: 1px solid rgba(217, 235, 227, 0.9);
      backdrop-filter: blur(10px);
      pointer-events: none;
      transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
      will-change: transform, opacity;
    }

    #${WIDGET_ID}.open .ntm-panel {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }

    #${WIDGET_ID} .ntm-panel-header {
      padding: 10px 12px 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: #6d6256;
      border-bottom: 1px solid #efe7da;
      background: #faf3e6;
    }

    #${WIDGET_ID} .ntm-lists {
      max-height: 220px;
      overflow-y: auto;
    }

    #${WIDGET_ID} .ntm-list {
      padding: 10px 12px;
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 6px;
      align-items: center;
      border-bottom: 1px dashed #efe7da;
    }

    #${WIDGET_ID} .ntm-list:last-child {
      border-bottom: none;
    }

    #${WIDGET_ID} .ntm-list-name {
      font-size: 12px;
    }

    #${WIDGET_ID} .ntm-action {
      border: none;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      background: #f0e7d9;
      color: #1e1b16;
    }

    #${WIDGET_ID} .ntm-action.primary {
      background: #0f766e;
      color: #fffdf7;
    }

    #${WIDGET_ID} .ntm-empty {
      padding: 12px;
      font-size: 12px;
      color: #6d6256;
    }

    #nesoi-recent-bubble {
      position: fixed;
      top: 16px;
      left: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px 8px 12px;
      border-radius: 12px;
      border: 1px solid #d1d5db;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 10px 20px rgba(15, 23, 42, 0.16);
      font-family: "Space Grotesk", "Segoe UI", Tahoma, sans-serif;
      color: #1f2937;
      cursor: pointer;
      transition: transform 0.18s ease, opacity 0.18s ease;
    }

    #nesoi-recent-bubble.hidden {
      opacity: 0;
      pointer-events: none;
      transform: translateY(-6px);
    }

    #nesoi-recent-bubble .ntm-bubble-count {
      font-weight: 700;
      font-size: 13px;
      color: #0f766e;
    }

    #nesoi-recent-bubble .ntm-bubble-message {
      font-size: 12px;
      line-height: 1.4;
    }

    #nesoi-recent-bubble .ntm-bubble-close {
      border: none;
      background: transparent;
      color: #6b7280;
      font-size: 14px;
      cursor: pointer;
      padding: 0 4px;
    }

    #nesoi-recent-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: none;
      font-family: "Space Grotesk", "Segoe UI", Tahoma, sans-serif;
    }

    #nesoi-recent-overlay.active {
      display: block;
    }

    #nesoi-recent-overlay .ntm-overlay-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(15, 23, 42, 0.2);
    }

    #nesoi-recent-overlay .ntm-overlay-panel {
      position: absolute;
      top: 56px;
      left: 20px;
      width: min(620px, 92vw);
      height: min(760px, calc(100vh - 80px));
      background: #ffffff;
      border-radius: 18px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      box-shadow: 0 20px 48px rgba(15, 23, 42, 0.24);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    #nesoi-recent-overlay .ntm-overlay-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      font-size: 12px;
      font-weight: 600;
      color: #1f2937;
    }

    #nesoi-recent-overlay .ntm-overlay-close {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 14px;
      color: #6b7280;
      padding: 4px 6px;
    }

    #nesoi-recent-overlay .ntm-overlay-frame {
      border: none;
      width: 100%;
      flex: 1;
    }

  `;
  document.head.appendChild(style);

  const widget = document.createElement("div");
  widget.id = WIDGET_ID;
  widget.innerHTML = `
    <div class="ntm-hotzone">
      <div class="ntm-handle">存</div>
    </div>
    <div class="ntm-panel">
      <div class="ntm-panel-header">快捷保存</div>
      <div class="ntm-lists"></div>
    </div>
  `;
  document.body.appendChild(widget);

  const panel = widget.querySelector(".ntm-panel");
  const listsContainer = widget.querySelector(".ntm-lists");
  const handle = widget.querySelector(".ntm-handle");

  const bubble = document.createElement("div");
  bubble.id = "nesoi-recent-bubble";
  bubble.className = "hidden";
  bubble.innerHTML = `
    <div class="ntm-bubble-message">
      过去 <span class="ntm-bubble-minutes"></span>新增未关闭标签页：
      <span class="ntm-bubble-count">0</span>
    </div>
    <button class="ntm-bubble-close" aria-label="关闭">×</button>
  `;
  document.body.appendChild(bubble);

  const overlay = document.createElement("div");
  overlay.id = "nesoi-recent-overlay";
  overlay.innerHTML = `
    <div class="ntm-overlay-backdrop"></div>
    <div class="ntm-overlay-panel">
      <div class="ntm-overlay-header">
        <span>近期标签页</span>
        <button class="ntm-overlay-close" aria-label="关闭">×</button>
      </div>
      <iframe class="ntm-overlay-frame" title="近期标签页面板"></iframe>
    </div>
  `;
  document.body.appendChild(overlay);

  const bubbleMinutes = bubble.querySelector(".ntm-bubble-minutes");
  const bubbleCount = bubble.querySelector(".ntm-bubble-count");
  const bubbleClose = bubble.querySelector(".ntm-bubble-close");
  const overlayBackdrop = overlay.querySelector(".ntm-overlay-backdrop");
  const overlayClose = overlay.querySelector(".ntm-overlay-close");
  const overlayFrame = overlay.querySelector(".ntm-overlay-frame");
  const overlayPanel = overlay.querySelector(".ntm-overlay-panel");
  const overlayUrl = chrome.runtime.getURL("ui/manager.html?mode=overlay");
  const reminderState = { active: false, durationText: "", count: 0 };
  const bubblePosition = { left: 16, top: 16 };
  const dragState = {
    pointerId: null,
    startX: 0,
    startY: 0,
    originLeft: 0,
    originTop: 0,
    moved: false,
    active: false,
  };
  const interactionState = {
    suppressBubbleClick: false,
    suppressCloseClick: false,
  };
  const DRAG_THRESHOLD = 4;
  const BUBBLE_MARGIN = 8;
  const PANEL_MARGIN = 8;
  const PANEL_GAP = 8;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getBubbleSize() {
    const rect = bubble.getBoundingClientRect();
    return {
      width: rect.width > 0 ? rect.width : 220,
      height: rect.height > 0 ? rect.height : 40,
    };
  }

  function getOverlayPanelSize() {
    const rect = overlayPanel.getBoundingClientRect();
    const fallbackWidth = Math.min(620, window.innerWidth * 0.92);
    const fallbackHeight = Math.min(760, Math.max(120, window.innerHeight - 80));
    return {
      width: rect.width > 0 ? rect.width : fallbackWidth,
      height: rect.height > 0 ? rect.height : fallbackHeight,
    };
  }

  function clampBubblePosition(left, top) {
    const bubbleSize = getBubbleSize();
    const minLeft = BUBBLE_MARGIN;
    const minTop = BUBBLE_MARGIN;
    const maxLeft = Math.max(minLeft, window.innerWidth - bubbleSize.width - BUBBLE_MARGIN);
    const maxTop = Math.max(minTop, window.innerHeight - bubbleSize.height - BUBBLE_MARGIN);
    return {
      left: clamp(left, minLeft, maxLeft),
      top: clamp(top, minTop, maxTop),
    };
  }

  function updateOverlayPosition(left, top) {
    if (!overlayPanel) {
      return;
    }
    const bubbleSize = getBubbleSize();
    const panelSize = getOverlayPanelSize();
    const desiredLeft = left;
    const desiredTop = top + bubbleSize.height + PANEL_GAP;
    const minLeft = PANEL_MARGIN;
    const minTop = PANEL_MARGIN;
    const maxLeft = Math.max(minLeft, window.innerWidth - panelSize.width - PANEL_MARGIN);
    const maxTop = Math.max(minTop, window.innerHeight - panelSize.height - PANEL_MARGIN);
    overlayPanel.style.left = `${clamp(desiredLeft, minLeft, maxLeft)}px`;
    overlayPanel.style.top = `${clamp(desiredTop, minTop, maxTop)}px`;
  }

  /**
   * 统一更新气泡与浮层位置。
   * 约束：调用方传入的坐标是视口坐标，这里会做边界裁剪后再应用。
   */
  function applyBubblePosition(nextLeft, nextTop) {
    const clamped = clampBubblePosition(nextLeft, nextTop);
    bubblePosition.left = clamped.left;
    bubblePosition.top = clamped.top;
    bubble.style.left = `${clamped.left}px`;
    bubble.style.top = `${clamped.top}px`;
    updateOverlayPosition(clamped.left, clamped.top);
  }

  /**
   * 仅在页面初始化时读取一次全局位置记忆。
   * 这样可以满足“新页面读到新位置，已打开页面保持原位”的交互要求。
   */
  async function loadBubblePosition() {
    const response = await request("getRecentBubblePosition");
    const position = response && response.ok ? response.position : null;
    const left = position && Number.isFinite(Number(position.left))
      ? Number(position.left)
      : bubblePosition.left;
    const top = position && Number.isFinite(Number(position.top))
      ? Number(position.top)
      : bubblePosition.top;
    applyBubblePosition(left, top);
  }

  function saveBubblePosition() {
    chrome.runtime.sendMessage(
      {
        action: "saveRecentBubblePosition",
        position: {
          left: bubblePosition.left,
          top: bubblePosition.top,
          updatedAt: Date.now(),
        },
      },
      () => {}
    );
  }

  function handleBubblePointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    dragState.pointerId = event.pointerId;
    dragState.startX = event.clientX;
    dragState.startY = event.clientY;
    dragState.originLeft = bubblePosition.left;
    dragState.originTop = bubblePosition.top;
    dragState.moved = false;
    dragState.active = true;
    bubble.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handleBubblePointerMove(event) {
    if (!dragState.active || event.pointerId !== dragState.pointerId) {
      return;
    }
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (!dragState.moved && (Math.abs(dx) >= DRAG_THRESHOLD || Math.abs(dy) >= DRAG_THRESHOLD)) {
      dragState.moved = true;
      interactionState.suppressBubbleClick = true;
      interactionState.suppressCloseClick = true;
    }
    if (!dragState.moved) {
      return;
    }
    applyBubblePosition(dragState.originLeft + dx, dragState.originTop + dy);
  }

  function finishBubbleDrag(event) {
    if (!dragState.active || event.pointerId !== dragState.pointerId) {
      return;
    }
    if (bubble.hasPointerCapture(event.pointerId)) {
      bubble.releasePointerCapture(event.pointerId);
    }
    const moved = dragState.moved;
    dragState.pointerId = null;
    dragState.active = false;
    dragState.moved = false;
    if (moved) {
      saveBubblePosition();
      setTimeout(() => {
        interactionState.suppressBubbleClick = false;
        interactionState.suppressCloseClick = false;
      }, 0);
    }
  }

  function hideBubble() {
    bubble.classList.add("hidden");
  }

  function showBubble(durationText, count) {
    if (bubbleMinutes) {
      bubbleMinutes.textContent = durationText;
    }
    if (bubbleCount) {
      bubbleCount.textContent = String(count);
    }
    bubble.classList.remove("hidden");
  }

  function openOverlay() {
    overlay.classList.add("active");
    if (overlayFrame && overlayFrame.src !== overlayUrl) {
      overlayFrame.src = overlayUrl;
    }
  }

  function closeOverlay() {
    overlay.classList.remove("active");
    if (reminderState.active) {
      showBubble(reminderState.durationText, reminderState.count);
    }
  }

  applyBubblePosition(bubblePosition.left, bubblePosition.top);
  loadBubblePosition();
  window.addEventListener("resize", () => {
    applyBubblePosition(bubblePosition.left, bubblePosition.top);
  });
  bubble.addEventListener("pointerdown", handleBubblePointerDown);
  bubble.addEventListener("pointermove", handleBubblePointerMove);
  bubble.addEventListener("pointerup", finishBubbleDrag);
  bubble.addEventListener("pointercancel", finishBubbleDrag);

  let isOpen = false;
  let isExpanded = false;
  let rafId = null;
  let closeTimer = null;
  const CLOSE_DELAY = 650;

  function request(action, data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action, ...data }, (response) => {
        resolve(response || { ok: false, error: "无响应" });
      });
    });
  }

  function renderLists(lists) {
    listsContainer.innerHTML = "";
    if (!lists.length) {
      const empty = document.createElement("div");
      empty.className = "ntm-empty";
      empty.textContent = "暂无列表，请先在弹窗中创建。";
      listsContainer.appendChild(empty);
      return;
    }

    lists.forEach((list) => {
      const row = document.createElement("div");
      row.className = "ntm-list";

      const name = document.createElement("div");
      name.className = "ntm-list-name";
      name.textContent = list.name;

      const saveButton = document.createElement("button");
      saveButton.className = "ntm-action primary";
      saveButton.textContent = "保存";
      saveButton.dataset.listId = list.id;
      saveButton.dataset.action = "save";

      const saveCloseButton = document.createElement("button");
      saveCloseButton.className = "ntm-action";
      saveCloseButton.textContent = "保存并关闭";
      saveCloseButton.dataset.listId = list.id;
      saveCloseButton.dataset.action = "save-close";

      row.appendChild(name);
      row.appendChild(saveButton);
      row.appendChild(saveCloseButton);
      listsContainer.appendChild(row);
    });
  }

  async function loadLists() {
    const response = await request("getLists");
    if (!response.ok) {
      renderLists([]);
      return;
    }
    renderLists(response.lists || []);
  }

  function flashHandle(message) {
    const original = handle.textContent;
    handle.textContent = message;
    setTimeout(() => {
      handle.textContent = original;
    }, 1200);
  }

  function setExpanded(nextExpanded) {
    if (isExpanded === nextExpanded) {
      return;
    }
    isExpanded = nextExpanded;
    widget.classList.toggle("expanded", nextExpanded);
  }

  function setOpen(nextOpen) {
    if (isOpen === nextOpen) {
      return;
    }
    isOpen = nextOpen;
    widget.classList.toggle("open", nextOpen);
    if (nextOpen) {
      setExpanded(true);
      loadLists();
    }
  }

  function clearCloseTimer() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function scheduleCollapse() {
    if (closeTimer) {
      return;
    }
    closeTimer = setTimeout(() => {
      closeTimer = null;
      const hoveringWidget = widget.matches(":hover") || panel.matches(":hover");
      if (hoveringWidget) {
        return;
      }
      setExpanded(false);
    }, CLOSE_DELAY);
  }

  function scheduleCheck() {
    if (rafId) {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = null;
      const hoveringWidget = widget.matches(":hover") || panel.matches(":hover");
      if (hoveringWidget) {
        clearCloseTimer();
        setExpanded(true);
        setOpen(true);
      } else {
        setOpen(false);
        scheduleCollapse();
      }
    });
  }

  document.addEventListener("mousemove", () => {
    scheduleCheck();
  });

  panel.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const listId = button.dataset.listId;
    const action = button.dataset.action;
    const closeTab = action === "save-close";
    const response = await request("saveCurrentTab", { listId, closeTab });
    if (response.ok) {
      flashHandle(closeTab ? "已保存并关闭" : "已保存");
    } else {
      flashHandle("保存失败");
    }
  });

  bubbleClose.addEventListener("click", (event) => {
    event.stopPropagation();
    if (interactionState.suppressCloseClick) {
      interactionState.suppressCloseClick = false;
      return;
    }
    hideBubble();
    reminderState.active = false;
    reminderState.durationText = "";
    reminderState.count = 0;
    chrome.runtime.sendMessage({ action: "snoozeRecentReminder" }, () => {});
  });

  bubble.addEventListener("click", () => {
    if (interactionState.suppressBubbleClick) {
      interactionState.suppressBubbleClick = false;
      return;
    }
    openOverlay();
    hideBubble();
  });

  overlayBackdrop.addEventListener("click", () => {
    closeOverlay();
  });

  overlayClose.addEventListener("click", () => {
    closeOverlay();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.action !== "recentReminder") {
      return;
    }
    const count = Number(message.count) || 0;
    const durationText = String(message.durationText || "").trim();
    if (count <= 0 || !durationText) {
      reminderState.active = false;
      reminderState.durationText = "";
      reminderState.count = 0;
      hideBubble();
      return;
    }
    reminderState.active = true;
    reminderState.durationText = durationText;
    reminderState.count = count;
    if (!overlay.classList.contains("active")) {
      showBubble(durationText, count);
    } else {
      hideBubble();
    }
  });
})();
