import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/admin-release.test.ts", "test/url-fetch-release.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    sequence: { concurrent: false },
  },
});
