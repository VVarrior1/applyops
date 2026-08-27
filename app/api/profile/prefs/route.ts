import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { getPrefs, upsertPrefs } from "@/src/profile/facts";

const stringChips = z.array(z.string().trim().min(1)).max(50).default([]);

const prefsBodySchema = z.object({
  roles: stringChips,
  locations: stringChips,
  remote: z.enum(["any", "remote", "hybrid", "onsite"]).default("any"),
  seniority: stringChips,
  workAuth: z
    .enum(["canada", "us_citizen_pr", "needs_sponsorship", "tn_eligible"])
    .nullable()
    .optional(),
  keywords: stringChips,
  excludedCompanies: stringChips,
});

/** `GET /api/profile/prefs` — the signed-in user's search prefs, or `null`. */
export async function GET() {
  const user = await requireUser();
  const prefs = await getPrefs(getDb(), user.id);
  return NextResponse.json({ prefs });
}

/** `POST /api/profile/prefs` — plan Task 6 Step 3: saves the prefs form. */
export async function POST(request: Request) {
  const user = await requireUser();

  const parsed = prefsBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid preferences." }, { status: 400 });
  }

  const prefs = await upsertPrefs(getDb(), user.id, {
    ...parsed.data,
    workAuth: parsed.data.workAuth ?? null,
  });
  return NextResponse.json({ prefs });
}
