import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { profiles } from "@/src/db/schema";
import { checkContact } from "@/src/profile/contact";

const MAX_LINKS = 10;

const contactBodySchema = z.object({
  name: z.string().trim().max(200).default(""),
  email: z.string().trim().max(320).default(""),
  phone: z.string().trim().max(50).default(""),
  links: z.array(z.string().trim().max(300)).max(MAX_LINKS).default([]),
});

/**
 * `GET /api/profile/contact` — the signed-in user's resume header fields
 * (name/email/phone/links), or `{}` if never set. `POST /api/applications`
 * doesn't carry this data; it lives on `profiles.contact` (plan Task 9:
 * "Contact fields ... come from `profiles` ... edited in Settings") and
 * `app/api/jobs/[id]/pdf` reads it straight from the DB, so this route only
 * needs to exist to let Settings write it.
 *
 * Both verbs also return `problems` — `checkContact()`'s verdict on the row
 * (`src/profile/contact.ts`). That is the same call `POST /api/jobs/[id]/pdf`
 * uses to refuse a download, so the Tailor tab can warn *before* the user
 * generates a resume instead of only failing at the download, and Settings
 * can say exactly which field is still placeholder data.
 */
export async function GET() {
  const user = await requireUser();
  const [row] = await getDb()
    .select({ contact: profiles.contact })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);
  const contact = row?.contact ?? {};
  return NextResponse.json({ contact, problems: checkContact(contact) });
}

/**
 * `POST /api/profile/contact` — saves the whole contact object at once.
 *
 * Saves even when `checkContact()` objects, and reports the objections in
 * `problems` instead of rejecting: a half-filled row is a normal state to be
 * in mid-edit, and refusing the write would strand a user who has typed
 * their name but not yet their email. The hard stop lives on the download
 * route, where the consequence (a file sent to an employer) actually is.
 */
export async function POST(request: Request) {
  const user = await requireUser();

  const parsed = contactBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid contact details." }, { status: 400 });
  }

  const links = parsed.data.links.filter((link) => link.length > 0);
  const contact = { ...parsed.data, links };

  const db = getDb();
  const [row] = await db
    .update(profiles)
    .set({ contact })
    .where(eq(profiles.userId, user.id))
    .returning({ contact: profiles.contact });

  const saved = row?.contact ?? contact;
  return NextResponse.json({ contact: saved, problems: checkContact(saved) });
}
