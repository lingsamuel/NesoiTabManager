import { reactive, ref } from "vue";
import { getBaseDomain } from "../utils/helpers.js";

function useAiGrouping({
  request,
  lists,
  getSelectedTabs,
  loadLists,
  loadWindows,
  settingsStatus,
}) {
  const aiConfig = reactive({
    endpoint: "",
    apiKey: "",
    model: "gpt-4.1-mini",
    apiMode: "responses",
    maxTabs: 120,
    includeListTitles: true,
  });

  const aiStatus = reactive({ message: "", type: "" });
  const aiTags = reactive({});
  const aiGroups = ref([]);

  function setAiStatus(message, type) {
    aiStatus.message = message;
    aiStatus.type = type || "";
  }

  function setSettingsStatus(message, type) {
    if (!settingsStatus) {
      setAiStatus(message, type);
      return;
    }
    settingsStatus.message = message;
    settingsStatus.type = type || "";
  }

  function clearAiTags() {
    Object.keys(aiTags).forEach((key) => delete aiTags[key]);
  }

  function resetAiTags() {
    clearAiTags();
    aiGroups.value = [];
    setAiStatus("", "");
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

  async function loadAiConfig() {
    const response = await request("getAiConfig");
    if (!response.ok) {
      setSettingsStatus(response.error || "AI 配置加载失败。", "error");
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
      setSettingsStatus("请填写 API 端点与 Key。", "error");
      return;
    }
    const response = await request("saveAiConfig", { config: aiConfig });
    if (!response.ok) {
      setSettingsStatus(response.error || "保存失败。", "error");
      return;
    }
    setSettingsStatus("AI 配置已保存。", "ok");
  }

  async function runAiGrouping() {
    const selectedTabs = getSelectedTabs();
    if (selectedTabs.length === 0) {
      setAiStatus("请先选择需要分组的标签页。", "error");
      return;
    }
    if (!aiConfig.endpoint || !aiConfig.apiKey || !aiConfig.model) {
      setAiStatus("请先在设置中配置 AI 端点、Key 和模型。", "error");
      return;
    }
    const items = buildAiItems(selectedTabs);
    setAiStatus("AI 分组中...", "");
    const response = await request("aiGroupTabs", { items });
    if (!response.ok) {
      setAiStatus(response.error || "AI 分组失败。", "error");
      return;
    }
    aiGroups.value = response.result ? response.result.groups || [] : [];
    if (aiGroups.value.length === 0) {
      setAiStatus("未生成有效分组。", "error");
      return;
    }
    applyTags(aiGroups.value);
    const truncated = response.result && response.result.truncated ? response.result.truncated : 0;
    const suffix = truncated > 0 ? `（已截断 ${truncated} 个标签页）` : "";
    setAiStatus(`已生成 ${aiGroups.value.length} 组标签。${suffix}`, "ok");
  }

  async function applyAiGrouping() {
    if (aiGroups.value.length === 0) {
      setAiStatus("请先执行 AI 分组。", "error");
      return;
    }
    setAiStatus("正在生成新列表...", "");
    const response = await request("saveGroupedTabs", { groups: aiGroups.value });
    if (!response.ok) {
      setAiStatus(response.error || "生成新列表失败。", "error");
      return;
    }
    const created = response.result ? response.result.created : 0;
    setAiStatus(`已生成 ${created} 个新列表。`, "ok");
    await loadLists();
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
      setAiStatus(response.error || "保存到分组失败。", "error");
      return;
    }
    const actionText = closeTab ? "保存并关闭" : "保存";
    setAiStatus(`已${actionText}到列表：${label}`, "ok");
    await loadLists();
    if (closeTab) {
      await loadWindows();
    }
  }

  return {
    aiConfig,
    aiStatus,
    aiTags,
    aiGroups,
    resetAiTags,
    setAiStatus,
    loadAiConfig,
    saveAiConfig,
    runAiGrouping,
    applyAiGrouping,
    saveTabToAiGroup,
  };
}

export { useAiGrouping };
