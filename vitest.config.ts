import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "functions/**/*.test.js"],
    globals: false,
    testTimeout: 20000
  }
});
