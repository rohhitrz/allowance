import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, // same alias as tsconfig
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false, // integration tests share one database
    testTimeout: 20_000,
  },
});
