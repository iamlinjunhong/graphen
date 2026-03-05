import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      GRAPH_SYNC_ENABLED: "false",
      RUNTIME_PG_REQUIRED: "false",
      PG_AUTO_BOOTSTRAP: "false"
    },
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
