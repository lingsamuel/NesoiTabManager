import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

const managerRoot = path.resolve(__dirname, "src/manager");

export default defineConfig({
  root: managerRoot,
  plugins: [vue()],
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "ui"),
    emptyOutDir: true,
    rollupOptions: {
      // 两个入口都输出到 ui/ 顶层：manager.html（管理页）与 sidebar.html（Firefox 侧边栏）。
      // 侧边栏的入口 HTML 之所以必须放在 managerRoot 下，是因为 Vite 按"相对 root 的路径"决定
      // 输出位置；放在 root 之外会被输出到 ui/ 的子目录，而 sidebar_action.default_panel
      // 需要的是 ui/sidebar.html。
      input: {
        manager: path.resolve(managerRoot, "manager.html"),
        sidebar: path.resolve(managerRoot, "sidebar.html"),
      },
    },
  },
});
