// Firefox 140+ 的「数据收集与传输同意」适配层。
//
// 背景：清单里 browser_specific_settings.gecko.data_collection_permissions 声明的
// optional 数据类型，只有用户显式同意后扩展才应当真正外发。AI 分组会把标签标题与基础域名
// POST 到**用户自己配置**的 AI 端点，因此归入 browsingActivity（域名/URL）与 websiteContent（页面标题）。
//
// 使用场景：管理页「AI 分组」按钮的点击处理器内，真正发起网络请求之前调用一次。
// 前置要求：必须在用户输入处理器里**同步**调用（不能先 await 别的异步操作再调用），
// 否则 Firefox 会以 "permissions.request may only be called from a user input handler" 拒绝，
// 因此本模块内部不做任何前置 await，用 await 调用方也仍处在同一次点击的调用栈里。
const AI_DATA_COLLECTION = ["browsingActivity", "websiteContent"];

/**
 * 请求（或复用）AI 分组所需的数据传输授权。
 *
 * @returns {Promise<boolean>} true 表示可以继续外发数据；false 表示用户明确拒绝，调用方必须中止。
 *
 * 兼容性设计：
 * - Chrome 与 Firefox 139 及更早版本没有 data_collection 概念，permissions.request 会抛错或
 *   回填 runtime.lastError。这类环境一律视为 true（由商店页面与隐私政策负责披露），不阻断功能。
 * - 已授权时 Firefox 会直接返回 true 且不弹窗，所以每次点击都调用一次是安全的，
 *   也顺带覆盖了「用户在 about:addons 里撤销授权」的情况。
 */
function ensureAiDataConsent() {
  return new Promise((resolve) => {
    const permissionsApi = typeof chrome !== "undefined" ? chrome.permissions : null;

    if (!permissionsApi || typeof permissionsApi.request !== "function") {
      resolve(true);
      return;
    }

    try {
      permissionsApi.request({ data_collection: AI_DATA_COLLECTION }, (granted) => {
        // lastError 说明当前浏览器不认识 data_collection 这个字段（Chrome / 旧 Firefox）。
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(true);
          return;
        }
        resolve(Boolean(granted));
      });
    } catch (error) {
      // 清单字段校验失败会同步抛出（例如 Chrome 的 "Invalid value for argument 1"）。
      resolve(true);
    }
  });
}

export { AI_DATA_COLLECTION, ensureAiDataConsent };
