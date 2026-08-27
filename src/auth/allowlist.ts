import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { allowedEmails } from "../db/schema";
import type * as schema from "../db/schema";

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Pure allow-list check — no I/O, so it's trivial to unit test (see
 * tests/auth/allowlist.test.ts) and safe to reuse anywhere (server, tests,
 * scripts) without a DB connection. `ownerEmail` and every entry in
 * `allowed` are compared case-insensitively and with surrounding
 * whitespace trimmed, since that's how a human is likely to type or paste
 * an email address into `.env.local` or the admin UI.
 */
export function isEmailAllowedPure(
  email: string,
  opts: { ownerEmail: string | null | undefined; allowed: string[] },
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  if (opts.ownerEmail && opts.ownerEmail.trim().toLowerCase() === normalized) {
    return true;
  }

  return opts.allowed.some((a) => a.trim().toLowerCase() === normalized);
}

/**
 * DB-backed allow-list check for use in the auth callback and anywhere else
 * server code needs to gate on invite status. `OWNER_EMAIL` always passes
 * (the owner never needs to be added to `allowed_emails`); otherwise looks
 * up `email` in `allowed_emails` case-insensitively (an index-friendly
 * targeted query, not a full table scan) and delegates the actual decision
 * to `isEmailAllowedPure` so both paths share one rule.
 */
export async function isEmailAllowed(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ email: allowedEmails.email })
    .from(allowedEmails)
    .where(sql`lower(${allowedEmails.email}) = lower(${email.trim()})`)
    .limit(1);

  return isEmailAllowedPure(email, {
    ownerEmail: process.env.OWNER_EMAIL,
    allowed: rows.map((r) => r.email),
  });
}
