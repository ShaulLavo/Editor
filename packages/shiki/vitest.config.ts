import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    browser: {
      headless: true,
      provider: "playwright",
      instances: [{ browser: "chromium" }],
    },
    include: ["test/**/*.test.ts"],
  },
});
