import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Built assets are copied into the native host and served from a virtual host
// (https://app.lou.local) by WebView2, so all paths are relative.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../src/Lou.App/wwwroot",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  server: { port: 5173, strictPort: true },
  test: {
    name: "ui",
    environment: "jsdom",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
