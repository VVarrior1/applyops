import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// This module deliberately does NOT load `.env.local` itself. `dotenv` is a
// devDependency (drizzle-kit/tsx tooling only) — a production install
// (`npm ci --omit=dev`, a slim Docker stage) would not have it, and this
// module is imported from Next.js server code (which loads its own env) as
// well as standalone scripts. Every standalone entrypoint that imports this
// file (src/db/migrate.ts, src/db/seed-v1.ts, cli/index.ts, ...) calls
// `dotenv.config()` itself before importing `getDb`/`getDirectDb` — by the
// time those functions run and read `process.env`, the vars are already set.
type Schema = typeof schema;

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
    const client = postgres(url, { prepare: false });
    pooledDb = drizzle(client, { schema });
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
    const client = postgres(url);
    directDb = drizzle(client, { schema });
  }
  return directDb;
}
