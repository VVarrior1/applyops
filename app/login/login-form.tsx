"use client";

import { useState, type FormEvent } from "react";
import { createSupabaseBrowserClient } from "@/src/auth/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ERROR_MESSAGES: Record<string, string> = {
  invite_only:
    "That email isn't on the invite list yet. Ask the owner to add it in Settings → Admin.",
  auth_failed: "That sign-in link didn't work. Request a new one below.",
};

type Status = "idle" | "sending" | "sent" | "error";

export function LoginForm({ errorCode }: { errorCode?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(
    errorCode ? (ERROR_MESSAGES[errorCode] ?? "Something went wrong signing in.") : null,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    setMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });

      if (error) {
        setStatus("error");
        setMessage(error.message);
        return;
      }

      setStatus("sent");
    } catch {
      setStatus("error");
      setMessage("Couldn't reach the sign-in service. Try again in a moment.");
    }
  }

  if (status === "sent") {
    return (
      <p className="text-sm text-muted-foreground">
        Check <span className="font-medium text-foreground">{email}</span> for a
        one-time sign-in link.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      {message && <p className="text-sm text-destructive">{message}</p>}
      <Button type="submit" disabled={status === "sending"} className="w-full">
        {status === "sending" ? "Sending…" : "Send magic link"}
      </Button>
    </form>
  );
}
