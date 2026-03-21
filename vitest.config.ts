import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "bun:sqlite": path.resolve(__dirname, "tests/__mocks__/bun-sqlite.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
  },
});
