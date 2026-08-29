/**
 * Turns a validated `DigestPayload` into the two bodies Resend wants: an HTML
 * part and a plain-text fallback.
 *
 * Constraints that shaped this, all of them email-client rather than taste:
 *
 * - **Inline styles only.** Gmail strips `<style>` blocks in some contexts and
 *   ignores most selectors; every rule here rides on the element.
 * - **No dark-mode media queries.** Gmail's dark mode recolours backgrounds on
 *   its own and inverts unpredictably, so the mail commits to a light palette
 *   with explicit colours on every text node rather than inheriting anything.
 * - **Tables, not flexbox.** Outlook renders through Word's engine, which has
 *   no flex support at all.
 *
 * The one thing this deliberately does NOT do is trust its input to be safe
 * HTML: every interpolated string goes through `esc()`. The payload is written
 * by a model reading arbitrary careers pages, so a posting whose title
 * contains `<script>` or a stray `"` must not be able to break the markup.
 */
import type { DigestJob, DigestPayload } from "./schema";

/** HTML-escape. Applied to every model-supplied string without exception. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";
const CARD = "#ffffff";
const PAGE = "#f3f4f6";

/** Highest scores first — the owner reads top-down and applies until time runs out. */
function byScoreDesc(a: DigestJob, b: DigestJob): number {
  return b.score - a.score;
}

function bulletList(items: string[], color: string): string {
  if (items.length === 0) return "";
  const lis = items
    .map(
      (item) =>
        `<li style="margin:0 0 4px 0;color:${color};font-size:14px;line-height:1.5;">${esc(item)}</li>`,
    )
    .join("");
  return `<ul style="margin:6px 0 0 0;padding-left:18px;">${lis}</ul>`;
}

function jobCard(job: DigestJob): string {
  const meta = [job.location, job.postedAt].filter((part) => part.length > 0).map(esc).join(" &middot; ");

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${RULE};border-radius:10px;margin:0 0 14px 0;">
  <tr><td style="padding:18px 20px;">
    <div style="font-size:17px;font-weight:700;color:${INK};line-height:1.35;">${esc(job.title)}</div>
    <div style="font-size:14px;font-weight:600;color:${INK};margin-top:3px;">${esc(job.company)}</div>
    ${meta ? `<div style="font-size:13px;color:${MUTED};margin-top:3px;">${meta}</div>` : ""}

    <p style="margin:12px 0 0 0;font-size:14px;line-height:1.55;color:${INK};">${esc(job.summary)}</p>

    ${
      job.whyYouQualify.length > 0
        ? `<div style="margin-top:14px;"><div style="font-size:12px;font-weight:700;color:#047857;text-transform:uppercase;letter-spacing:.4px;">Why you qualify</div>${bulletList(job.whyYouQualify, INK)}</div>`
        : ""
    }
    ${
      job.gaps.length > 0
        ? `<div style="margin-top:12px;"><div style="font-size:12px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:.4px;">Gaps</div>${bulletList(job.gaps, MUTED)}</div>`
        : ""
    }

    <div style="margin-top:16px;">
      <a href="${esc(job.url)}" style="display:inline-block;background:${INK};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:6px;">Apply &rarr;</a>
    </div>
    <div style="margin-top:8px;font-size:12px;color:${MUTED};word-break:break-all;">${esc(job.url)}</div>
  </td></tr>
</table>`;
}

/** Subject line. Says the count up front so the inbox list alone tells you whether to open it. */
export function digestSubject(payload: DigestPayload): string {
  const n = payload.jobs.length;
  const date = payload.date?.trim() || new Date().toISOString().slice(0, 10);
  if (n === 0) return `No new entry-level postings — ${date}`;
  const top = [...payload.jobs].sort(byScoreDesc)[0];
  return n === 1
    ? `1 new role: ${top.title} at ${top.company}`
    : `${n} new roles — top: ${top.title} at ${top.company}`;
}

export function renderDigestHtml(payload: DigestPayload): string {
  const jobs = [...payload.jobs].sort(byScoreDesc);
  const date = payload.date?.trim() || new Date().toISOString().slice(0, 10);

  const cards = jobs.map(jobCard).join("");

  const footerBits = [`Checked ${payload.checked} careers page${payload.checked === 1 ? "" : "s"}.`];
  if (payload.unreachable.length > 0) {
    // Named, not just counted: a page that silently stops parsing is how a
    // watcher quietly goes blind, and the owner can only fix what they can see.
    footerBits.push(`Could not read: ${payload.unreachable.map(esc).join(", ")}.`);
  }

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${PAGE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      <tr><td style="padding:0 4px 18px 4px;">
        <div style="font-size:20px;font-weight:800;color:${INK};">Entry-level roles posted today</div>
        <div style="font-size:13px;color:${MUTED};margin-top:4px;">${esc(date)} &middot; straight from company careers pages</div>
      </td></tr>
      <tr><td>
        ${
          jobs.length > 0
            ? cards
            : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${RULE};border-radius:10px;"><tr><td style="padding:24px 20px;font-size:14px;color:${MUTED};">Nothing new cleared the bar today.</td></tr></table>`
        }
      </td></tr>
      <tr><td style="padding:8px 4px 0 4px;border-top:1px solid ${RULE};">
        <div style="font-size:12px;color:${MUTED};line-height:1.6;margin-top:10px;">${footerBits.join(" ")}</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export function renderDigestText(payload: DigestPayload): string {
  const jobs = [...payload.jobs].sort(byScoreDesc);
  const date = payload.date?.trim() || new Date().toISOString().slice(0, 10);

  const lines: string[] = [`Entry-level roles posted today — ${date}`, ""];

  if (jobs.length === 0) {
    lines.push("Nothing new cleared the bar today.", "");
  }

  for (const job of jobs) {
    lines.push(`${job.title} — ${job.company}`);
    const meta = [job.location, job.postedAt].filter((p) => p.length > 0).join(" · ");
    if (meta) lines.push(meta);
    lines.push("", job.summary, "");
    if (job.whyYouQualify.length > 0) {
      lines.push("Why you qualify:");
      for (const item of job.whyYouQualify) lines.push(`  - ${item}`);
      lines.push("");
    }
    if (job.gaps.length > 0) {
      lines.push("Gaps:");
      for (const item of job.gaps) lines.push(`  - ${item}`);
      lines.push("");
    }
    lines.push(`Apply: ${job.url}`, "", "---", "");
  }

  lines.push(`Checked ${payload.checked} careers page${payload.checked === 1 ? "" : "s"}.`);
  if (payload.unreachable.length > 0) {
    lines.push(`Could not read: ${payload.unreachable.join(", ")}.`);
  }
  return lines.join("\n");
}
