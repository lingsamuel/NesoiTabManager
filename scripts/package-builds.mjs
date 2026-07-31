import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const BUILD_TARGETS = ["chrome", "firefox"];
const ARCHIVE_VERSION_RETENTION_LIMIT = 3;
const ARCHIVE_NAME_PATTERN = /^nesoi-tab-manager-(chrome|firefox)-(.+)\.zip$/;

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

async function packageTarget(projectRoot, version, target) {
  const targetDir = resolve(projectRoot, "dist", target);
  const archivePath = resolve(projectRoot, "dist", `nesoi-tab-manager-${target}-${version}.zip`);
  const entries = (await readdir(targetDir)).sort();

  if (entries.length === 0) {
    throw new Error(`构建产物目录为空，无法打包: ${targetDir}`);
  }

  // 先删除旧压缩包，避免 zip 在已有文件上追加旧条目。
  await rm(archivePath, { force: true });
  // 在产物目录内部执行打包，确保 zip 根层直接是扩展文件，无多余顶层目录。
  await runZip(["-qr", archivePath, ...entries], targetDir);
}

function compareVersionPart(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumber = Number.isInteger(leftNumber) && String(leftNumber) === left;
  const rightIsNumber = Number.isInteger(rightNumber) && String(rightNumber) === right;

  if (leftIsNumber && rightIsNumber) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right, "en");
}

function compareVersions(left, right) {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const result = compareVersionPart(leftPart, rightPart);

    if (result !== 0) {
      return result;
    }
  }

  return 0;
}

async function pruneOldArchives(projectRoot) {
  const distDir = resolve(projectRoot, "dist");
  const entries = await readdir(distDir, { withFileTypes: true });
  const archivesByVersion = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = ARCHIVE_NAME_PATTERN.exec(entry.name);
    if (!match) {
      continue;
    }

    const [, , version] = match;
    const archivePaths = archivesByVersion.get(version) ?? [];
    archivePaths.push(resolve(distDir, entry.name));
    archivesByVersion.set(version, archivePaths);
  }

  const versions = [...archivesByVersion.keys()].sort(compareVersions).reverse();
  const versionsToDelete = versions.slice(ARCHIVE_VERSION_RETENTION_LIMIT);

  for (const version of versionsToDelete) {
    const archivePaths = archivesByVersion.get(version) ?? [];

    // 以版本为单位整体删除，避免只保留半套浏览器产物。
    for (const archivePath of archivePaths) {
      await rm(archivePath, { force: true });
    }
  }
}

async function main() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(
    await readFile(resolve(projectRoot, "package.json"), "utf8")
  );
  const version = packageJson.version;

  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("package.json 缺少合法 version，无法生成发布压缩包");
  }

  for (const target of BUILD_TARGETS) {
    await packageTarget(projectRoot, version, target);
  }

  await pruneOldArchives(projectRoot);
}

await main();
