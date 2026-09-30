import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = new Set(["chrome", "firefox"]);
const GECKO_ID = "nesoi-tab-manager@example.com";
const FIREFOX_MIN_VERSION = "115.0";

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
        strict_min_version: FIREFOX_MIN_VERSION
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
