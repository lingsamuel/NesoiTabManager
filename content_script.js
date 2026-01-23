(() => {
  const WIDGET_ID = "nesoi-tab-manager-widget";

  if (document.getElementById(WIDGET_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.textContent = `
    #${WIDGET_ID} {
      position: fixed;
      bottom: 18px;
      left: 18px;
      z-index: 2147483647;
      font-family: "Space Grotesk", "Segoe UI", Tahoma, sans-serif;
      color: #1e1b16;
      pointer-events: auto;
    }

    #${WIDGET_ID} .ntm-handle {
      padding: 8px 14px;
      background: linear-gradient(135deg, #0f766e 0%, #2b9a86 55%, #f6c453 100%);
      color: #fffdf7;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.3px;
      box-shadow: 0 10px 24px rgba(15, 118, 110, 0.35);
      cursor: default;
      user-select: none;
    }

    #${WIDGET_ID} .ntm-panel {
      position: absolute;
      left: 0;
      bottom: 46px;
      width: 220px;
      max-height: 280px;
      overflow: hidden;
      opacity: 0;
      transform: translateY(12px);
      background: #fffdf7;
      border-radius: 16px;
      box-shadow: 0 16px 28px rgba(34, 26, 16, 0.2);
      border: 1px solid rgba(230, 221, 207, 0.8);
      pointer-events: none;
      transition: all 0.18s ease;
    }

    #${WIDGET_ID}.open .ntm-panel {
      opacity: 1;
      transform: translateY(0);
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
  `;
  document.head.appendChild(style);

  const widget = document.createElement("div");
  widget.id = WIDGET_ID;
  widget.innerHTML = `
    <div class="ntm-handle">Save tab</div>
    <div class="ntm-panel">
      <div class="ntm-panel-header">Quick save</div>
      <div class="ntm-lists"></div>
    </div>
  `;
  document.body.appendChild(widget);

  const panel = widget.querySelector(".ntm-panel");
  const listsContainer = widget.querySelector(".ntm-lists");
  const handle = widget.querySelector(".ntm-handle");

  function request(action, data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action, ...data }, (response) => {
        resolve(response || { ok: false, error: "No response" });
      });
    });
  }

  function renderLists(lists) {
    listsContainer.innerHTML = "";
    if (!lists.length) {
      const empty = document.createElement("div");
      empty.className = "ntm-empty";
      empty.textContent = "No lists yet. Use the popup to create one.";
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
      saveButton.textContent = "Save";
      saveButton.dataset.listId = list.id;
      saveButton.dataset.action = "save";

      const saveCloseButton = document.createElement("button");
      saveCloseButton.className = "ntm-action";
      saveCloseButton.textContent = "Save+Close";
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

  widget.addEventListener("mouseenter", () => {
    widget.classList.add("open");
    loadLists();
  });

  widget.addEventListener("mouseleave", () => {
    widget.classList.remove("open");
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
      flashHandle(closeTab ? "Saved + closed" : "Saved");
    } else {
      flashHandle("Save failed");
    }
  });
})();
