import { defineConfig } from "drizzle-kit";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

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
