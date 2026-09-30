import { execFileSync, execSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = new Set(["chrome", "firefox"]);
// 两个浏览器共用的静态文件；后台与清单按目标单独处理。
const STATIC_FILES = ["content_script.js", "popup.html", "popup.css", "popup.js"];
// 图标是清单（icons / action.default_icon）直接引用的静态资源，两个目标共用同一套 PNG。
const STATIC_DIRS = ["icons"];

function resolveTargets(rawTarget) {
  if (!rawTarget) {
    return [...TARGETS];
  }
  if (TARGETS.has(rawTarget)) {
    return [rawTarget];
  }
  throw new Error(`不支持的构建目标: ${rawTarget}，仅支持 chrome/firefox`);
}

// 管理界面（ui/）由 Vite 构建，Chrome 与 Firefox 共用同一份输出。
function buildUi() {
  execSync("npx vite build --config vite.config.js", { cwd: projectRoot, stdio: "inherit" });
}

// Firefox event page 不支持拆分的 ES Module 源码（后台依赖 import 链），
// 用 esbuild 将 background.js 及其子模块打包为单文件 ESM，由 type: "module" 加载。
async function bundleFirefoxBackground(distDir) {
  await esbuild({
    entryPoints: [resolve(projectRoot, "background.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["firefox115"],
    outfile: resolve(distDir, "background.js"),
    logLevel: "info"
  });
}

async function assembleTarget(target) {
  const distDir = resolve(projectRoot, "dist", target);
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  if (target === "chrome") {
    // Chrome service worker 直接支持 ES Module，保持源码拆分便于调试。
    await cp(resolve(projectRoot, "background.js"), resolve(distDir, "background.js"));
    await cp(resolve(projectRoot, "background"), resolve(distDir, "background"), {
      recursive: true
    });
  } else {
    await bundleFirefoxBackground(distDir);
  }

  for (const file of STATIC_FILES) {
    await cp(resolve(projectRoot, file), resolve(distDir, file));
  }
  for (const dir of STATIC_DIRS) {
    await cp(resolve(projectRoot, dir), resolve(distDir, dir), { recursive: true });
  }
  await cp(resolve(projectRoot, "ui"), resolve(distDir, "ui"), { recursive: true });

  // 目标专属 manifest 统一由 write-manifest.mjs 生成。
  execFileSync("node", ["scripts/write-manifest.mjs", target], {
    cwd: projectRoot,
    stdio: "inherit"
  });
}

async function main() {
  const targets = resolveTargets(process.argv[2]);
  buildUi();
  for (const target of targets) {
    await assembleTarget(target);
  }
}

await main();
