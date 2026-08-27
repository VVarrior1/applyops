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
 *
 * `deleteUserData` runs its Storage cleanup before touching the database and
 * lets a genuine failure there (bad service key, network, permissions)
 * propagate rather than swallowing it. Catch that here and report it as an
 * error instead of the old unconditional `{ok:true}`: nothing has been
 * deleted at this point (the DB transaction never started), so the account
 * is fully intact and "try again" is a real, safe instruction — the client
 * (`DeleteMyData`) already keeps its confirm dialog open and shows this
 * message instead of signing the user out on any non-2xx response.
 */
export async function POST() {
  const user = await requireUser();
  try {
    await deleteUserData(getDb(), user.id);
  } catch (err) {
    console.error(
      `[profile/delete] failed for user ${user.id}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "Couldn't delete your data. Nothing was removed — try again." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
