import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve `.env.local` relative to the repo root (not `process.cwd()`), so
// this script works when invoked from anywhere, not just the repo root.
dotenv.config({
  path: path.resolve(fileURLToPath(import.meta.url), "../../..", ".env.local"),
  quiet: true,
});

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDirectDb } from "./client";

async function main() {
  const db = getDirectDb();
  console.log("Running migrations from ./drizzle ...");
  const start = Date.now();
  await migrate(db, { migrationsFolder: "drizzle" });
  console.log(`Migrations applied in ${Date.now() - start}ms.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
