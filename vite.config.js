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
      input: path.resolve(managerRoot, "manager.html"),
    },
  },
});
