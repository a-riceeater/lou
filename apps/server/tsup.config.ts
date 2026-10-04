import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

const banner = [
  "#!/usr/bin/env node",
  // Some bundled CommonJS code calls require(); give the ESM output a real one.
  'import { createRequire as __louCreateRequire } from "node:module";',
  "const require = __louCreateRequire(import.meta.url);",
].join("\n");

// Bundles the server and the workspace packages into dist/; npm dependencies
// (fastify, better-sqlite3, …) stay external and are installed on the host.
export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: [/^@lou\//],
  external: ["yaml", "zod", "openai"],
  banner: { js: banner },
  onSuccess: async () => {
    cpSync("drizzle", "dist/drizzle", { recursive: true });
  },
});
