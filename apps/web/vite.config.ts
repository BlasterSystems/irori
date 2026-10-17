import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/api": { target: "http://localhost:3947", changeOrigin: false, ws: false },
    },
  },
  test: {
    environment: "node",
  },
});
