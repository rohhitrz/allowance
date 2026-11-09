/**
 * Runs before `next start` on Render (free web services have no pre-deploy hook):
 * apply migrations, then seed. Safe to run on every boot: the seed only upserts the catalog,
 * adds the grocery mandate if it's missing and links the demo buyer's vault from env.
 * It never wipes data; use "Demo script → Reset" in the app for a clean slate.
 */
import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, db } from "../src/server/db";
import { seed } from "../src/server/db/seed";
import { demoVault } from "../src/server/demo/script";

if (existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  await migrate(db(), { migrationsFolder: "drizzle" });
  console.log("[deploy] migrations applied");
  const vault = demoVault();
  await seed({ vault });
  console.log(`[deploy] seeded${vault ? ` (demo vault ${vault.vaultId} linked)` : " (no demo vault: PayPal popup fallback)"}`);
  await closeDb();
}

main().catch((e) => {
  console.error("[deploy] failed:", e);
  process.exit(1);
});
