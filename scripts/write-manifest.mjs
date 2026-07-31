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
// 必须改用 background.scripts（event page）；同时补充 AMO 签名所需的 gecko 元数据。
// Chromium 目标保持基础清单原样，避免引入无关字段。
function buildManifest(baseManifest, target) {
  if (target === "chrome") {
    return baseManifest;
  }

  const backgroundScript = baseManifest.background?.service_worker || "background.js";

  return {
    ...baseManifest,
    background: {
      scripts: [backgroundScript],
      type: "module"
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
