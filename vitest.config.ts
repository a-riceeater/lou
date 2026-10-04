import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/*/test/**/*.test.ts", "apps/server/test/**/*.test.ts"],
          environment: "node",
        },
      },
      "apps/windows/frontend",
    ],
  },
});
