"use client";

import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COUNTRY_OPTIONS } from "@/src/finders/country";
import type { SearchPrefsRow, SavePrefsInput } from "@/src/profile/facts";

const ROLE_OPTIONS = [
  "SWE",
  "Full-stack",
  "Backend",
  "Frontend",
  "ML/AI",
  "Data",
  "DevOps/SRE",
  "Mobile",
] as const;

const SENIORITY_OPTIONS = ["new_grad", "junior", "intern"] as const;

const REMOTE_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "Onsite" },
] as const;

const WORK_AUTH_OPTIONS = [
  { value: "canada", label: "Canadian citizen / PR" },
  { value: "us_citizen_pr", label: "US citizen / PR" },
  { value: "needs_sponsorship", label: "Needs sponsorship" },
  { value: "tn_eligible", label: "TN-eligible" },
] as const;

const NO_WORK_AUTH_VALUE = "__unset";

function ChipToggle({
  options,
  selected,
  onToggle,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={active ? "default" : "outline"}
            onClick={() => onToggle(option)}
          >
            {option}
          </Button>
        );
      })}
    </div>
  );
}

function ChipList({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const value = draft.trim();
    if (value && !values.includes(value)) onChange([...values, value]);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Badge key={value} variant="secondary" className="gap-1">
            {value}
            <button
              type="button"
              onClick={() => onChange(values.filter((v) => v !== value))}
              aria-label={`Remove ${value}`}
              className="ml-0.5 opacity-70 hover:opacity-100"
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={placeholder}
      />
    </div>
  );
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

export function PrefsForm({
  initialPrefs,
  onSaved,
  submitLabel = "Save preferences",
}: {
  initialPrefs: SearchPrefsRow | null;
  onSaved?: (prefs: SearchPrefsRow) => void;
  submitLabel?: string;
}) {
  const [roles, setRoles] = useState<string[]>(initialPrefs?.roles ?? []);
  const [locations, setLocations] = useState<string[]>(initialPrefs?.locations ?? []);
  // Defaults to CA/US for a user with no saved prefs yet — matches the
  // `search_prefs.countries` column default (src/db/schema.ts) so a brand
  // new account's ranking/filtering behaves the same before and after their
  // first explicit save.
  const [countries, setCountries] = useState<string[]>(initialPrefs?.countries ?? ["CA", "US"]);
  const [remote, setRemote] = useState<string>(initialPrefs?.remote ?? "any");
  const [seniority, setSeniority] = useState<string[]>(initialPrefs?.seniority ?? []);
  const [workAuth, setWorkAuth] = useState<string>(initialPrefs?.workAuth ?? NO_WORK_AUTH_VALUE);
  const [keywords, setKeywords] = useState<string[]>(initialPrefs?.keywords ?? []);
  const [excludedCompanies, setExcludedCompanies] = useState<string[]>(
    initialPrefs?.excludedCompanies ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggle(list: string[], set: (v: string[]) => void, value: string) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);

    const payload: SavePrefsInput = {
      roles,
      locations,
      countries,
      remote,
      seniority,
      workAuth: workAuth === NO_WORK_AUTH_VALUE ? null : workAuth,
      keywords,
      excludedCompanies,
    };

    try {
      const res = await fetch("/api/profile/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        setError(await parseErrorBody(res));
        setSaving(false);
        return;
      }

      const body = (await res.json()) as { prefs: SearchPrefsRow };
      setSaved(true);
      onSaved?.(body.prefs);
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label>Target roles</Label>
        <ChipToggle
          options={ROLE_OPTIONS}
          selected={roles}
          onToggle={(v) => toggle(roles, setRoles, v)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Locations</Label>
        <ChipList values={locations} onChange={setLocations} placeholder="Add a city or region, press Enter" />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Countries you&apos;ll work in</Label>
        <div className="flex flex-wrap gap-1.5">
          {COUNTRY_OPTIONS.map((option) => {
            const active = countries.includes(option.code);
            return (
              <Button
                key={option.code}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                title={option.name}
                onClick={() => toggle(countries, setCountries, option.code)}
              >
                {option.code}
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Remote roles restricted to a country you haven&apos;t picked are filtered out. Leave all
          unselected to allow anywhere.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Remote preference</Label>
        <Select value={remote} onValueChange={(v) => setRemote(v as string)}>
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REMOTE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Seniority</Label>
        <ChipToggle
          options={SENIORITY_OPTIONS}
          selected={seniority}
          onToggle={(v) => toggle(seniority, setSeniority, v)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Work authorization</Label>
        <Select value={workAuth} onValueChange={(v) => setWorkAuth(v as string)}>
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_WORK_AUTH_VALUE}>Prefer not to say</SelectItem>
            {WORK_AUTH_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Interests / keywords</Label>
        <ChipList values={keywords} onChange={setKeywords} placeholder="e.g. fintech, add Enter" />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Companies to exclude</Label>
        <ChipList
          values={excludedCompanies}
          onChange={setExcludedCompanies}
          placeholder="Add a company, press Enter"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && !error && <p className="text-sm text-muted-foreground">Saved.</p>}

      <Button type="button" onClick={handleSave} disabled={saving} className="self-start">
        {saving ? "Saving…" : submitLabel}
      </Button>
    </div>
  );
}
