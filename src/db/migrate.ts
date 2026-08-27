import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

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
