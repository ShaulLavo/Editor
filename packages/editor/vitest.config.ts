import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ["test/**/*.test.ts", "happy-dom"],
    ],
  },
});
