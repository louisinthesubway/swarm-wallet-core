import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The live integration test dials mainnet and is skipped unless
    // SWARM_WALLET_CORE_LIVE=1, so the default run needs no network at all.
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
