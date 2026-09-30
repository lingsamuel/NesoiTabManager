import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// AMO 要求：压缩/打包过的代码必须同时提交「可复现构建」的源码包，否则直接拒审
// （见 docs/publish_firefox.md 与 Mozilla 的 Source code submission 指南）。
// 这里显式列出要提交的源码，而不是"排除 node_modules 后全打包"，避免把 dist/、ui/ 等
// 构建产物或本地临时目录（.tmp-npm-cache）混进去，也避免评审无法区分源码与产物。
const SOURCE_FILES = [
  "manifest.json",
  "package.json",
  "package-lock.json",
  "vite.config.js",
  "background.js",
  "content_script.js",
  "popup.html",
  "popup.css",
  "popup.js"
];
const SOURCE_DIRS = ["background", "src", "scripts", "icons", "docs"];
// 构建说明放在 docs/ 下作为唯一事实来源，打包时改名为 README_BUILD.md 放到压缩包根层，
// 这样评审解压后第一眼就能看到构建步骤。
const BUILD_README_SOURCE = "docs/source_build.md";
const BUILD_README_NAME = "README_BUILD.md";

function runZip(args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("zip", args, { cwd, stdio: "inherit" });

    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`zip 执行失败，退出码: ${code ?? "(null)"}`));
    });
  });
}

async function main() {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const version = packageJson.version;

  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("package.json 缺少合法 version，无法生成源码包");
  }

  const stagingDir = resolve(projectRoot, "dist", `.source-${version}`);
  const archivePath = resolve(projectRoot, "dist", `nesoi-tab-manager-source-${version}.zip`);

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  for (const file of SOURCE_FILES) {
    await cp(resolve(projectRoot, file), resolve(stagingDir, file));
  }
  for (const dir of SOURCE_DIRS) {
    await cp(resolve(projectRoot, dir), resolve(stagingDir, dir), { recursive: true });
  }

  const buildReadme = await readFile(resolve(projectRoot, BUILD_README_SOURCE), "utf8");
  await writeFile(resolve(stagingDir, BUILD_README_NAME), buildReadme, "utf8");

  // zip 在暂存目录内执行，保证压缩包根层直接是源码，没有多余顶层目录。
  await rm(archivePath, { force: true });
  await runZip(["-qr", archivePath, "."], stagingDir);
  await rm(stagingDir, { recursive: true, force: true });

  console.log(`源码包已生成：${archivePath}`);
  console.log("上传方式：AMO 版本页面底部「Source code」→ 选择该 zip。");
}

await main();
