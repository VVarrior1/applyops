import { NextResponse } from "next/server";
import { z } from "zod";
import { desc, sql } from "drizzle-orm";
import { requireOwner } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { allowedEmails } from "@/src/db/schema";

const emailBodySchema = z.object({ email: z.string().trim().email() });

export async function GET() {
  await requireOwner();

  const db = getDb();
  const rows = await db
    .select({
      email: allowedEmails.email,
      addedBy: allowedEmails.addedBy,
      createdAt: allowedEmails.createdAt,
    })
    .from(allowedEmails)
    .orderBy(desc(allowedEmails.createdAt));

  return NextResponse.json({
    emails: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  });
}

export async function POST(request: Request) {
  const owner = await requireOwner();

  const parsed = emailBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const email = parsed.data.email.toLowerCase();

  const db = getDb();
  const [row] = await db
    .insert(allowedEmails)
    .values({ email, addedBy: owner.email })
    .onConflictDoNothing({ target: allowedEmails.email })
    .returning({
      email: allowedEmails.email,
      addedBy: allowedEmails.addedBy,
      createdAt: allowedEmails.createdAt,
    });

  // Already present (onConflictDoNothing returns no row) — fetch it so the
  // client still gets back a row to render, keeping "add an existing email"
  // idempotent instead of an error.
  const existing =
    row ??
    (
      await db
        .select({
          email: allowedEmails.email,
          addedBy: allowedEmails.addedBy,
          createdAt: allowedEmails.createdAt,
        })
        .from(allowedEmails)
        .where(sql`lower(${allowedEmails.email}) = lower(${email})`)
        .limit(1)
    )[0];

  return NextResponse.json(
    { email: { ...existing, createdAt: existing.createdAt.toISOString() } },
    { status: 201 },
  );
}

export async function DELETE(request: Request) {
  await requireOwner();

  const parsed = emailBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  const db = getDb();
  await db
    .delete(allowedEmails)
    .where(sql`lower(${allowedEmails.email}) = lower(${parsed.data.email})`);

  return NextResponse.json({ ok: true });
}
