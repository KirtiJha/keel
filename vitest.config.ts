import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Gate/hook tests shell out to git and python; give them room without
    // hiding a genuine hang.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**/*.ts"],
      // Reported, never gated. See keel-plan.md: mutation score, not coverage.
      thresholds: undefined,
    },
  },
});
