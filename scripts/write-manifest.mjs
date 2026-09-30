import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = new Set(["chrome", "firefox"]);
// AMO 上架后扩展 ID 不可更改，因此这里用发布者自己的 github.io 命名空间而不是 example.com 占位域名。
const GECKO_ID = "nesoi-tab-manager@lingsamuel.github.io";
// 最低版本定为 140：Firefox 140 起才内置「数据收集与传输同意」体验。
// 只要兼容 139 及更早版本，就必须自行实现「安装后立即弹出、不可忽略、单页」的同意流程
// （见 AMO 政策 6.2.2 与 docs/publish_firefox.md），因此这里直接收窄到 140。
const FIREFOX_MIN_VERSION = "140.0";

// Firefox 内置同意系统使用的数据分类（AMO 政策 6.2.1 / MDN data_collection_permissions）。
// required=["none"]：扩展默认不向任何地方传输数据，纯本地管理标签页。
// optional：只有用户主动点「AI 分组」时才会把标签标题与基础域名 POST 到**用户自己配置**的 AI 端点，
//   属于「浏览活动」（域名/URL）与「网站内容」（页面标题）。
//   这两项必须放在 optional 而不是 required：不启用 AI 的用户的安装体验不应被数据提示打扰。
//   UI 侧在真正发起请求前会调用 permissions.request({ data_collection }) 取同意，
//   见 src/manager/utils/data_collection.js。
const DATA_COLLECTION_PERMISSIONS = {
  required: ["none"],
  optional: ["browsingActivity", "websiteContent"]
};

function resolveTarget(rawTarget) {
  if (TARGETS.has(rawTarget)) {
    return rawTarget;
  }
  throw new Error(`不支持的构建目标: ${rawTarget ?? "(empty)"}，仅支持 chrome/firefox`);
}

// Firefox 不支持 MV3 的 background.service_worker（参见 Firefox bug 1573659），
// 必须改用 background.scripts（event page）；同时补充 AMO 签名所需的 gecko 元数据与侧边栏声明。
// Chromium 目标保持基础清单原样，避免引入无关字段（尤其是 sidebar_action 这种 Firefox 专有键）。
function buildManifest(baseManifest, target) {
  if (target === "chrome") {
    return baseManifest;
  }

  const backgroundScript = baseManifest.background?.service_worker || "background.js";
  // `menus.overrideContext` 是 Firefox 专有必需权限：侧边栏右键标签时用它把上下文切到 "tab"，
  // 从而由 Firefox 原生菜单控件渲染我们注册的标签菜单项。Chrome 不认识这个权限，因此只加在 Firefox 目标上。
  const permissions = Array.isArray(baseManifest.permissions) ? baseManifest.permissions.slice() : [];
  if (!permissions.includes("menus.overrideContext")) {
    permissions.push("menus.overrideContext");
  }

  return {
    ...baseManifest,
    permissions,
    background: {
      scripts: [backgroundScript],
      type: "module"
    },
    // 原生侧边栏面板：Firefox 会把它列进「视图 → 侧边栏」菜单。
    // 每个窗口各有一份独立的面板文档实例，因此面板自身就能确定"自己属于哪个窗口"。
    sidebar_action: {
      default_title: "Nesoi 标签侧边栏",
      default_panel: "ui/sidebar.html"
    },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        data_collection_permissions: DATA_COLLECTION_PERMISSIONS
      }
    }
  };
}

async function main() {
  const target = resolveTarget(process.argv[2]);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = resolve(projectRoot, "manifest.json");
  const distManifestPath = resolve(projectRoot, "dist", target, "manifest.json");

  const baseManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = buildManifest(baseManifest, target);

  await mkdir(dirname(distManifestPath), { recursive: true });
  await writeFile(distManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

await main();
