import { NextResponse } from "next/server";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { deleteUserData } from "@/src/profile/facts";

export const runtime = "nodejs";

/**
 * `POST /api/profile/delete` — "Delete my data" (plan Task 6 Step 4).
 * Any signed-in user may delete their own data, owner included. Signing the
 * browser out afterward is the caller's job (see `DeleteMyData` in
 * `app/(app)/settings/`) — this route only ever touches Postgres + Storage.
 */
export async function POST() {
  const user = await requireUser();
  await deleteUserData(getDb(), user.id);
  return NextResponse.json({ ok: true });
}
