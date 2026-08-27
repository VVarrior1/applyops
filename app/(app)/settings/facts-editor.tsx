"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { FACT_CATEGORIES } from "@/src/pipeline/schemas";
import type { ProfileFactRecord } from "@/src/profile/facts";

interface Row extends ProfileFactRecord {
  dirty: boolean;
  saving: boolean;
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

export function FactsEditor({ initialFacts }: { initialFacts: ProfileFactRecord[] }) {
  const [rows, setRows] = useState<Row[]>(
    initialFacts.map((f) => ({ ...f, dirty: false, saving: false })),
  );
  const [newCategory, setNewCategory] = useState<string>(FACT_CATEGORIES[0]);
  const [newText, setNewText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function patchRow(label: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.label === label ? { ...r, ...patch } : r)));
  }

  async function saveRow(label: string) {
    const row = rows.find((r) => r.label === label);
    if (!row) return;
    patchRow(label, { saving: true });
    setError(null);

    try {
      const res = await fetch("/api/profile/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: row.label,
          category: row.category,
          text: row.text,
          source: row.source,
        }),
      });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        patchRow(label, { saving: false });
        return;
      }
      patchRow(label, { dirty: false, saving: false });
    } catch {
      setError("Couldn't reach the server. Try again.");
      patchRow(label, { saving: false });
    }
  }

  async function deleteRow(label: string) {
    if (!window.confirm("Delete this fact? It will no longer be cited in generated resumes.")) {
      return;
    }
    setError(null);

    try {
      const res = await fetch("/api/profile/facts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      setRows((prev) => prev.filter((r) => r.label !== label));
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = newText.trim();
    if (!text) return;

    setAdding(true);
    setError(null);

    try {
      const res = await fetch("/api/profile/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: newCategory, text, source: "manual" }),
      });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      const body = (await res.json()) as { facts: ProfileFactRecord[] };
      setRows((prev) => [...prev, ...body.facts.map((f) => ({ ...f, dirty: false, saving: false }))]);
      setNewText("");
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Label</TableHead>
            <TableHead className="w-36">Category</TableHead>
            <TableHead>Text</TableHead>
            <TableHead className="w-24">Source</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No facts yet — upload a resume in Onboarding, or add one below.
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableCell className="align-top font-mono text-xs text-muted-foreground">
                {row.label}
              </TableCell>
              <TableCell className="align-top">
                <Select
                  value={row.category}
                  onValueChange={(value) =>
                    patchRow(row.label, { category: value as string, dirty: true })
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FACT_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {category}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="align-top">
                <Textarea
                  value={row.text}
                  rows={2}
                  onChange={(event) =>
                    patchRow(row.label, { text: event.target.value, dirty: true })
                  }
                />
              </TableCell>
              <TableCell className="align-top">
                <Badge variant="outline">{row.source === "resume_upload" ? "resume" : "manual"}</Badge>
              </TableCell>
              <TableCell className="flex flex-col items-end gap-1.5 align-top">
                {row.dirty && (
                  <Button size="sm" disabled={row.saving} onClick={() => saveRow(row.label)}>
                    {row.saving ? "Saving…" : "Save"}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => deleteRow(row.label)}>
                  Delete
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <form onSubmit={handleAdd} className="flex flex-col gap-2 rounded-lg border p-3">
        <p className="text-sm font-medium">Add a fact</p>
        <div className="flex flex-wrap items-start gap-2">
          <Select value={newCategory} onValueChange={(v) => setNewCategory(v as string)}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FACT_CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={newText}
            onChange={(event) => setNewText(event.target.value)}
            placeholder="e.g. Led a 3-person team to ship a payments API used by 5k merchants"
            rows={2}
            className="flex-1"
          />
        </div>
        <Button type="submit" size="sm" disabled={adding} className="self-start">
          {adding ? "Adding…" : "Add fact"}
        </Button>
      </form>
    </div>
  );
}
