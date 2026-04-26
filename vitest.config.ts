import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/freeze-clock.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    silent: "passed-only",
  },
});
