"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { ExtractFactsOutput } from "@/src/pipeline/schemas";

const MAX_RESUME_MB = 5;

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Upload failed (${res.status}).`;
  } catch {
    return `Upload failed (${res.status}).`;
  }
}

export function UploadStep({
  onExtracted,
}: {
  onExtracted: (facts: ExtractFactsOutput["facts"]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a PDF resume first.");
      return;
    }
    if (file.size > MAX_RESUME_MB * 1024 * 1024) {
      setError(`That file is over ${MAX_RESUME_MB} MB.`);
      return;
    }

    setStatus("uploading");
    setError(null);

    try {
      const formData = new FormData();
      formData.set("resume", file);
      const res = await fetch("/api/profile/upload", { method: "POST", body: formData });

      if (!res.ok) {
        setStatus("error");
        setError(await parseErrorBody(res));
        return;
      }

      const body = (await res.json()) as { facts: ExtractFactsOutput["facts"] };
      onExtracted(body.facts);
    } catch {
      setStatus("error");
      setError("Couldn't reach the server. Try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="resume"
          className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-input px-6 py-10 text-center transition-colors hover:bg-muted/50"
        >
          <span className="text-sm font-medium">
            {fileName ?? "Click to choose a PDF resume"}
          </span>
          <span className="text-xs text-muted-foreground">Up to {MAX_RESUME_MB} MB</span>
        </label>
        <input
          ref={inputRef}
          id="resume"
          name="resume"
          type="file"
          accept="application/pdf"
          className="sr-only"
          onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={status === "uploading"} className="self-start">
        {status === "uploading" ? "Reading resume…" : "Upload and extract facts"}
      </Button>
    </form>
  );
}
