import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = resolve(projectRoot, "icons");
const SVG_SOURCE = resolve(ICON_DIR, "icon.svg");
// 16/32 用于浏览器工具栏与扩展管理页，48/96/128 用于扩展页与 AMO 商品页，
// 64 单独导出是因为 AMO 商品页要求 32x32 与 64x64 两档位图。
const SIZES = [16, 32, 48, 64, 96, 128];

// rsvg-convert 由 librsvg 提供，是唯一在本机可用的矢量渲染器；
// PNG 结果会提交进仓库，因此普通构建（npm run build）不需要安装它。
function renderSize(size) {
  const outfile = resolve(ICON_DIR, `icon-${size}.png`);
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", outfile, SVG_SOURCE], {
    stdio: "inherit"
  });
  return outfile;
}

async function main() {
  await access(SVG_SOURCE);
  await readFile(SVG_SOURCE, "utf8");

  for (const size of SIZES) {
    renderSize(size);
  }

  console.log(`已导出图标：${SIZES.map((size) => `icon-${size}.png`).join(", ")}`);
}

await main();
