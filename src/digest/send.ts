/**
 * Resend transport for the daily digest.
 *
 * Deliberately a bare `fetch` against Resend's REST API rather than the
 * `resend` npm package: this is one POST to one endpoint, and the SDK would
 * add a dependency to a project that already talks to four HTTP APIs by hand
 * (see `src/finders/http.ts`).
 *
 * The sending domain is `cydsoccer.com`, which is verified in Resend and is
 * also a live business domain. That is why the API key lives only in Vercel's
 * encrypted env and never in the scheduled agent's config: the agent holds a
 * secret that can send *this one digest to one hardcoded address*, so a
 * leaked routine config cannot be used to send mail as the business.
 */

/** A `from` on the verified domain, distinct from CYD's own `notifications@` so the owner can filter it separately. */
const FROM = process.env.DIGEST_FROM_EMAIL ?? "ApplyOps <jobs@cydsoccer.com>";

export interface SendResult {
  id: string;
}

export class DigestSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DigestSendError";
  }
}

export async function sendDigestEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new DigestSendError("RESEND_API_KEY is not configured.", 500);
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });

  const body = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;

  if (!response.ok || !body?.id) {
    // Resend's own message is the useful part (unverified domain, bad
    // recipient, rate limit); pass it through rather than flattening every
    // failure into "send failed".
    throw new DigestSendError(body?.message ?? `Resend returned ${response.status}.`, 502);
  }

  return { id: body.id };
}
