"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

export interface AllowedEmailRow {
  email: string;
  addedBy: string | null;
  createdAt: string;
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function AllowedEmailsManager({
  initialEmails,
}: {
  initialEmails: AllowedEmailRow[];
}) {
  const [emails, setEmails] = useState(initialEmails);
  const [newEmail, setNewEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function addEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = newEmail.trim();
    if (!email) return;
    setError(null);

    startTransition(async () => {
      const res = await fetch("/api/admin/allowed-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }

      const { email: added } = (await res.json()) as { email: AllowedEmailRow };
      setEmails((prev) => [added, ...prev.filter((r) => r.email !== added.email)]);
      setNewEmail("");
    });
  }

  function removeEmail(email: string) {
    setError(null);

    startTransition(async () => {
      const res = await fetch("/api/admin/allowed-emails", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }

      setEmails((prev) => prev.filter((r) => r.email !== email));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={addEmail} className="flex gap-2">
        <Input
          type="email"
          placeholder="new-user@example.com"
          value={newEmail}
          onChange={(event) => setNewEmail(event.target.value)}
          required
        />
        <Button type="submit" disabled={isPending}>
          Add
        </Button>
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Added by</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {emails.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-muted-foreground">
                No invited emails yet.
              </TableCell>
            </TableRow>
          )}
          {emails.map((row) => (
            <TableRow key={row.email}>
              <TableCell>{row.email}</TableCell>
              <TableCell className="text-muted-foreground">
                {row.addedBy ?? "—"}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => removeEmail(row.email)}
                >
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
