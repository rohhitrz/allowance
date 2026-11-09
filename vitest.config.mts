import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false, // integration tests share one database
    testTimeout: 20_000,
  },
});
