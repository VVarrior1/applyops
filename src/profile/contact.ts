/**
 * `profiles.contact` — the resume header block — and the guard that decides
 * whether it is safe to print on an application-ready document.
 *
 * ## Why this exists
 *
 * QA found the owner's live row holding seed/placeholder identity ("ApplyOps
 * Test Resume", `candidate@example.com`, `555-0100`,
 * `github.com/example-candidate`) and the app happily rendering it into a
 * downloadable PDF — right down to the document's `Title` metadata. Nothing
 * anywhere checked that the contact block was a real person before handing
 * over a file whose entire purpose is to be emailed to an employer. Sending
 * that to a recruiter is unrecoverable in a way almost nothing else in this
 * app is, so the check is a hard gate on the download route, not a lint.
 *
 * ## The shape of the check
 *
 * Three kinds of problem, deliberately distinguished because they read very
 * differently to a user:
 *   - `missing`     — the field was never filled in.
 *   - `malformed`   — there is text, but it cannot be a name/email/phone.
 *   - `placeholder` — it looks like seed data or a docs example.
 *
 * The `placeholder` patterns are intentionally narrow and literal. A false
 * positive blocks a real user from downloading their own resume, which is
 * worse than letting an odd-looking-but-real value through, so every pattern
 * here matches something that essentially cannot be a real job applicant's
 * contact detail: RFC 2606's reserved `example.*` domains, the NANP's
 * reserved `555-01xx` fictional-number range, and the literal words seed
 * scripts use ("test", "sample", "placeholder", "your name", "john doe").
 *
 * Pure and dependency-free on purpose: the same function runs in the Settings
 * editor (client), the contact API, and the PDF route, so the warning a user
 * sees and the rule that blocks the download can never drift apart.
 */

/** The `profiles.contact` JSON blob (see `src/db/schema.ts`). */
export interface ProfileContact {
  name?: string;
  email?: string;
  phone?: string;
  links?: string[];
}

export type ContactField = "name" | "email" | "phone" | "links";

export type ContactProblemKind = "missing" | "malformed" | "placeholder";

export interface ContactProblem {
  field: ContactField;
  kind: ContactProblemKind;
  /** User-facing, already written to be shown verbatim in the UI. */
  message: string;
}

/** Words a seed row / docs example uses and a real applicant's name does not. */
const PLACEHOLDER_NAME_PATTERNS: RegExp[] = [
  /\b(test|testing|sample|example|placeholder|dummy|fake|lorem|ipsum|untitled|unknown)\b/i,
  /\b(your|first|last)\s*name\b/i,
  /\bjohn\s+(doe|smith)\b/i,
  /\bjane\s+doe\b/i,
  /\bcandidate\b/i,
  /\bapplyops\b/i,
];

/**
 * Reserved-for-documentation domains (RFC 2606) plus the handful of literal
 * stand-ins seed data uses. Matched on the whole host, so a real company at
 * `examplebank.com` is unaffected.
 */
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "example.edu",
  "test.com",
  "test.test",
  "sample.com",
  "demo.com",
  "domain.com",
  "yourdomain.com",
  "mydomain.com",
  "email.com",
  "localhost",
  "invalid",
]);

const PLACEHOLDER_EMAIL_LOCALPARTS = new Set([
  "candidate",
  "test",
  "tester",
  "testuser",
  "test.user",
  "example",
  "sample",
  "demo",
  "placeholder",
  "user",
  "username",
  "you",
  "your.email",
  "youremail",
  "your-email",
  "name",
  "email",
  "foo",
  "bar",
  "changeme",
  "john.doe",
  "jane.doe",
  "firstname.lastname",
]);

/** Substrings that only appear in a made-up profile link. */
const PLACEHOLDER_LINK_PATTERNS: RegExp[] = [
  /\bexample\b/i,
  /example-candidate/i,
  /\byour[-_.]?(username|handle|name|profile)\b/i,
  /\/username\/?$/i,
  /\byourusername\b/i,
];

/** Loose on purpose — this rejects "not an address at all", not unusual TLDs. */
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/;

function digitsOf(value: string): string {
  return value.replace(/\D+/g, "");
}

/**
 * The NANP reserves `555-0100` … `555-0199` for fiction — the range the QA
 * row's `555-0100` came from. Accepts the number with or without a country
 * code and with any punctuation.
 */
function isFictionalPhone(digits: string): boolean {
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length === 10) {
    return national.slice(3, 6) === "555" && national.slice(6, 8) === "01";
  }
  if (national.length === 7) {
    return national.slice(0, 3) === "555" && national.slice(3, 5) === "01";
  }
  return false;
}

/**
 * The other numbers nobody's phone actually is. Kept as an exact-match list
 * rather than a "is it sequential" rule: a real seven-digit line like
 * 456-7890 *is* a run of consecutive digits, and blocking a real applicant's
 * number is a worse failure than letting an odd one through.
 */
const FILLER_PHONES = new Set([
  "1234567890",
  "11234567890",
  "0123456789",
  "9876543210",
  "1234567",
  "0000000",
]);

function isFillerPhone(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true; // 0000000000, 1111111111
  return FILLER_PHONES.has(digits);
}

/**
 * Every reason this contact block is not safe to print on a resume, in the
 * order the fields appear on the page. Empty array ⇒ good to render.
 *
 * `phone` and `links` are optional (plenty of real resumes omit a phone
 * number), so they only produce a problem when they are present *and* fake.
 * `name` and `email` are required: a resume header without them is not a
 * resume anyone can reply to.
 */
export function checkContact(contact: ProfileContact | null | undefined): ContactProblem[] {
  const problems: ContactProblem[] = [];
  const name = contact?.name?.trim() ?? "";
  const email = contact?.email?.trim() ?? "";
  const phone = contact?.phone?.trim() ?? "";
  const links = (contact?.links ?? []).map((link) => link.trim()).filter(Boolean);

  if (!name) {
    problems.push({
      field: "name",
      kind: "missing",
      message: "Add the name that should appear at the top of your resume.",
    });
  } else if (name.length < 2 || !/\p{L}/u.test(name)) {
    problems.push({
      field: "name",
      kind: "malformed",
      message: `“${name}” doesn't look like a name.`,
    });
  } else if (PLACEHOLDER_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    problems.push({
      field: "name",
      kind: "placeholder",
      message: `“${name}” looks like placeholder data, not your real name.`,
    });
  }

  if (!email) {
    problems.push({
      field: "email",
      kind: "missing",
      message: "Add the email address an employer should reply to.",
    });
  } else if (!EMAIL_SHAPE.test(email)) {
    problems.push({
      field: "email",
      kind: "malformed",
      message: `“${email}” isn't a valid email address.`,
    });
  } else {
    const at = email.lastIndexOf("@");
    const localPart = email.slice(0, at).toLowerCase();
    const domain = email.slice(at + 1).toLowerCase();
    if (PLACEHOLDER_EMAIL_DOMAINS.has(domain) || PLACEHOLDER_EMAIL_LOCALPARTS.has(localPart)) {
      problems.push({
        field: "email",
        kind: "placeholder",
        message: `“${email}” is a placeholder address — an employer can't reach you there.`,
      });
    }
  }

  if (phone) {
    const digits = digitsOf(phone);
    if (digits.length < 7) {
      problems.push({
        field: "phone",
        kind: "malformed",
        message: `“${phone}” isn't enough digits for a phone number.`,
      });
    } else if (isFictionalPhone(digits) || isFillerPhone(digits)) {
      problems.push({
        field: "phone",
        kind: "placeholder",
        message: `“${phone}” is a placeholder phone number.`,
      });
    }
  }

  for (const link of links) {
    if (PLACEHOLDER_LINK_PATTERNS.some((pattern) => pattern.test(link))) {
      problems.push({
        field: "links",
        kind: "placeholder",
        message: `“${link}” is a placeholder link.`,
      });
    }
  }

  return problems;
}

/** True when `checkContact` found nothing — i.e. safe to render onto a PDF. */
export function contactIsUsable(contact: ProfileContact | null | undefined): boolean {
  return checkContact(contact).length === 0;
}

/**
 * One sentence for an API error body / a banner headline. Keeps the fix in
 * the same breath as the complaint — the only place a user can act on this
 * is Settings.
 */
export function contactProblemSummary(problems: ContactProblem[]): string {
  if (problems.length === 0) return "";
  return (
    "Your resume contact info isn't ready to send to an employer: " +
    problems.map((problem) => problem.message).join(" ") +
    " Fix it in Settings → Resume contact info, then download again."
  );
}
