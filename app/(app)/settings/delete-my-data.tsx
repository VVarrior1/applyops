"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/src/auth/browser";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/**
 * Settings' "Delete my data" flow — plan Task 6 Step 4: "confirm dialog →
 * deleteUserData → sign out". The confirm button is a plain button (not a
 * `DialogClose`), so an error keeps the dialog open with the message
 * visible instead of silently dismissing.
 */
export function DeleteMyData() {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch("/api/profile/delete", { method: "POST" });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        setDeleting(false);
        return;
      }

      const supabase = createSupabaseBrowserClient();
      await supabase.auth.signOut();
      router.push("/login");
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
      setDeleting(false);
    }
  }

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Delete my data</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete all your data?</DialogTitle>
          <DialogDescription>
            This permanently deletes your confirmed facts, preferences, applications, outcome
            history, and uploaded resumes. This cannot be undone. You&apos;ll be signed out
            immediately after.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" disabled={deleting} onClick={handleDelete}>
            {deleting ? "Deleting…" : "Delete everything"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
