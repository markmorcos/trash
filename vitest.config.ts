import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    // integration tests share one database and start real servers
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
