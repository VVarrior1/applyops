import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

// Scripts run outside Next.js (seed, migrate, cli, ad hoc `tsx -e ...`) need
// `.env.local` loaded explicitly; Next.js already loads it for the app, and
// re-loading here is a harmless no-op (dotenv never overwrites vars that are
// already set, and silently no-ops if the file is absent, as in production).
// Resolved relative to the repo root (not `process.cwd()`) so this works
// when invoked from anywhere. `dotenv` is a real `dependencies` entry (not
// dev-only) specifically so this import survives a production-only install
// (`npm ci --omit=dev`) of anything that pulls this module in — see
// package.json.
dotenv.config({
  path: path.resolve(fileURLToPath(import.meta.url), "../../..", ".env.local"),
  quiet: true,
});

type Schema = typeof schema;

/**
 * The database handle every server-side helper takes as its first argument
 * (`isEmailAllowed(db, …)`, `callStructured({db, …})`, …). Exported so call
 * sites and tests share one name instead of re-deriving
 * `PostgresJsDatabase<typeof schema>` in every module. Added by Task 4.
 */
export type Db = PostgresJsDatabase<Schema>;

let pooledClient: ReturnType<typeof postgres> | undefined;
let directClient: ReturnType<typeof postgres> | undefined;
let pooledDb: PostgresJsDatabase<Schema> | undefined;
let directDb: PostgresJsDatabase<Schema> | undefined;

/**
 * Pooled connection (Supabase transaction pooler, `DATABASE_URL`, port 6543).
 * `prepare: false` is required — PgBouncer transaction-mode pooling does not
 * support server-side prepared statements. Use this for all app/route code.
 */
export function getDb(): PostgresJsDatabase<Schema> {
  if (!pooledDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pooledClient = postgres(url, { prepare: false });
    pooledDb = drizzle(pooledClient, { schema });
  }
  return pooledDb;
}

/**
 * Direct connection (`DIRECT_DATABASE_URL`, port 5432, no pooler). Use this
 * for migrations and one-off scripts (seeds, admin CLI commands) — never
 * from request-scoped app code.
 */
export function getDirectDb(): PostgresJsDatabase<Schema> {
  if (!directDb) {
    const url = process.env.DIRECT_DATABASE_URL;
    if (!url) throw new Error("DIRECT_DATABASE_URL is not set");
    directClient = postgres(url);
    directDb = drizzle(directClient, { schema });
  }
  return directDb;
}

/**
 * Closes any postgres-js sockets opened by `getDb()`/`getDirectDb()` in this
 * process and resets both caches, so a later call reconnects fresh.
 *
 * postgres-js keeps its TCP socket open indefinitely once connected, which
 * otherwise stalls Node's natural exit — a one-off script or CLI command
 * that calls `getDb()`/`getDirectDb()` and then simply returns will hang
 * forever instead of letting the process exit. Call this before returning
 * from any such script/command instead of reaching for `process.exit()`
 * (which risks losing not-yet-flushed stdout when piped/redirected).
 */
export async function closeDb(): Promise<void> {
  await Promise.all([pooledClient?.end(), directClient?.end()]);
  pooledClient = undefined;
  directClient = undefined;
  pooledDb = undefined;
  directDb = undefined;
}
