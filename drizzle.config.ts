import { defineConfig } from "drizzle-kit";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve `.env.local` relative to the repo root (not `process.cwd()`), so
// this config works when drizzle-kit is invoked from anywhere.
dotenv.config({
  path: path.resolve(fileURLToPath(import.meta.url), "..", ".env.local"),
  quiet: true,
});

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  throw new Error("DIRECT_DATABASE_URL is not set (check .env.local)");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
});
