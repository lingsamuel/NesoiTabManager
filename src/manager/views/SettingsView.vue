<template>
  <section class="view view-settings">
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
      <div class="settings-grid">
        <div class="form-row full">
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
        <div class="form-row checkbox-row full">
          <label>
            <input type="checkbox" v-model="aiConfig.includeListTitles" />
            发送已有列表标题/描述作为参考
          </label>
        </div>
        <div class="form-row full">
          <button class="primary btn-icon" @click="onSaveAiConfig">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
              </svg>
            </span>
            保存配置
          </button>
        </div>
        <div class="form-row full">
          <div class="status" :class="settingsStatus.type">{{ settingsStatus.message }}</div>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <h2>自动冻结</h2>
      </div>
      <div class="settings-grid">
        <div class="form-row checkbox-row full">
          <label>
            <input type="checkbox" v-model="discardConfig.enabled" />
            启用自动冻结（闲置时自动 discard）
          </label>
        </div>
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
        <div class="form-row">
          <label for="discard-history-limit">最大冻结历史记录数（0 不限制）</label>
          <input
            id="discard-history-limit"
            type="number"
            min="0"
            v-model.number="discardConfig.historyLimit"
          />
        </div>
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
        <div class="form-row full">
          <label for="discard-whitelist">白名单（每行一条，命中后不自动冻结）</label>
          <textarea
            id="discard-whitelist"
            rows="5"
            placeholder="例如：github.com\nnotion.so"
            v-model="discardConfig.whitelist"
          ></textarea>
        </div>
        <div class="form-row full">
          <button class="primary btn-icon" @click="onSaveDiscardConfig">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 20h12V8l-4-4H6zM9 20v-6h6v6" />
              </svg>
            </span>
            保存配置
          </button>
        </div>
        <div class="form-row full">
          <div class="status" :class="discardConfigStatus.type">{{ discardConfigStatus.message }}</div>
        </div>
      </div>
    </section>
  </section>
</template>

<script setup>
defineProps({
  aiConfig: {
    type: Object,
    default: () => ({}),
  },
  discardConfig: {
    type: Object,
    default: () => ({}),
  },
  settingsStatus: {
    type: Object,
    default: () => ({ message: "", type: "" }),
  },
  discardConfigStatus: {
    type: Object,
    default: () => ({ message: "", type: "" }),
  },
  onSaveAiConfig: {
    type: Function,
    default: null,
  },
  onSaveDiscardConfig: {
    type: Function,
    default: null,
  },
});
</script>
