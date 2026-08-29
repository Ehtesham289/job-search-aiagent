import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The orchestration tests run the real DAG, renderer and PDF extractor.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Fixture runs share a temp store per file; parallel files are still safe.
    fileParallelism: true,
  },
});
