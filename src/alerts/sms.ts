/**
 * Twilio SMS for the urgent tier.
 *
 * A text is the one channel the owner will see within minutes, which is the
 * whole point of this tier — but it is also the most intrusive, so the
 * threshold that gets here is deliberately high and the body is deliberately
 * short. The message has to answer "is this worth stopping for?" on a lock
 * screen: role, company, location, score, link. The reasoning lives in the
 * email digest.
 *
 * Credentials come from the CYD Twilio account (the sending number is a
 * Calgary 587 line, so the text reads as local rather than as spam).
 */

export class SmsError extends Error {}

/** Twilio hard-fails a body over 1600 chars; well under it, but truncate rather than throw. */
const MAX_BODY = 1500;

export interface SmsJob {
  company: string;
  title: string;
  location: string;
  score: number;
  url: string;
}

/**
 * One job per text. Batching two roles into one message saves a cent and
 * costs the thing that makes this tier useful — a text that means exactly one
 * thing: go apply to this.
 */
export function renderSms(job: SmsJob): string {
  const location = job.location.trim();
  const head = `${job.title} — ${job.company}`;
  const meta = [location, `fit ${job.score}/100`].filter(Boolean).join(" · ");
  return `New entry-level match\n${head}\n${meta}\n${job.url}`.slice(0, MAX_BODY);
}

export async function sendSms(
  args: { to: string; body: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ sid: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    throw new SmsError("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER are not all set.");
  }

  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: args.to, From: from, Body: args.body }).toString(),
  });

  const payload = (await response.json().catch(() => null)) as { sid?: string; message?: string } | null;
  if (!response.ok || !payload?.sid) {
    throw new SmsError(payload?.message ?? `Twilio returned ${response.status}.`);
  }
  return { sid: payload.sid };
}
