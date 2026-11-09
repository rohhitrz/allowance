import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;
/** A transaction handle has the same query API as the db. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Conn = DB | Tx;

let client: ReturnType<typeof postgres> | null = null;
let instance: DB | null = null;

/** Lazily connect, so scripts can load .env before first use. */
export function db(): DB {
  if (instance) return instance;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing env var DATABASE_URL");
  client = postgres(url, { max: 10, onnotice: () => {} });
  instance = drizzle(client, { schema });
  return instance;
}

export async function closeDb() {
  await client?.end({ timeout: 5 });
  client = null;
  instance = null;
}

export { schema };
