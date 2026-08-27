/**
 * Deterministic ATS fast path — spec §10.
 *
 * Before the LLM tool loop (`tool-loop.ts`) spends a single token, this module
 * fills the fields whose location on a Greenhouse / Lever / Ashby form is
 * *known*, using nothing but a selector → value table. Two reasons that table
 * is worth having:
 *
 *   1. Cost and latency. Name/email/phone/links are ~80% of a typical form and
 *      cost nothing to fill deterministically; handing them to a model means
 *      several screenshots and tool round-trips per field.
 *   2. Truthfulness. A model asked to "fill in the candidate's phone number"
 *      can hallucinate one. A table cannot: every value here comes from the
 *      `ApplicantData` the caller built from `profiles.contact` and
 *      `search_prefs` (see `buildApplicantData`), and a field with no value is
 *      simply reported as `remaining` for the tool loop (and ultimately the
 *      human) to deal with.
 *
 * Ported from v1 `scripts/apply-now.ts` (`applyGreenhouse` / `applyLever` /
 * `applyAshby`), with three deliberate deletions:
 *   - the hardcoded `ME` object — PII now comes from the database;
 *   - the canned "why do you want to join" / cover-letter essays — writing
 *     prose in the candidate's voice is not something a selector table should
 *     be doing, and the v1 versions asserted experience the profile may not
 *     have. Open-text questions are `remaining` work for the tool loop, which
 *     is instructed to answer only from the profile;
 *   - the cover-letter upload path, which pointed at one hardcoded PDF.
 *
 * Everything here is written against `FastPathPage` — a structural subset of
 * Playwright's `Page` — so the whole fast path is unit-testable with a fake
 * page that records `fill` calls (`tests/agent/fastpath.test.ts`) instead of
 * needing a browser and a live job posting.
 */

/** The ATS families the fast path knows selectors for. */
export type AtsKind = "greenhouse" | "lever" | "ashby" | "generic";

/**
 * Which ATS is behind this posting URL?
 *
 * Matching is on the whole lowercased URL rather than the hostname because
 * embedded boards hide the vendor in the query string (`?gh_jid=`) or in a
 * path segment, and v1 learned that the hard way. `generic` is a real answer,
 * not a failure: the tool loop can still drive an unknown form, it just gets
 * no head start. Never throws — a malformed URL is `generic`.
 */
export function detectAts(url: string): AtsKind {
  const u = (url ?? "").toLowerCase();
  if (
    u.includes("greenhouse.io") ||
    u.includes("gh_jid") ||
    u.includes("grnh.se")
  ) {
    return "greenhouse";
  }
  if (u.includes("lever.co")) return "lever";
  if (u.includes("ashbyhq.com") || u.includes("jobs.ashby")) return "ashby";
  return "generic";
}

/**
 * Everything the agent is allowed to type into a form.
 *
 * This is the *only* channel for personal data in `src/agent/**`: no module
 * here reads a name, email or phone number from anywhere else, so "where could
 * this value have come from?" has exactly one answer — the signed-in user's
 * own `profiles.contact` row. `"unknown"` is a first-class answer for the work
 * authorisation questions; the agent is told to leave those blank and ask for
 * a human rather than guess (guessing wrong on "are you authorised to work
 * in..." is a materially false statement on an application).
 */
export interface ApplicantData {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  linkedin: string | null;
  github: string | null;
  website: string | null;
  /** City only (forms ask for a city, prefs store "Toronto, ON"). */
  city: string | null;
  /** Current employer/school, for Lever's "Current company" field. */
  currentOrg: string | null;
  /**
   * The answers to "are you authorised to work here / do you need
   * sponsorship" — but only for the country named in {@link workAuthRegion}.
   * A posting anywhere else must be treated as `unknown`.
   */
  workAuthorized: "yes" | "no" | "unknown";
  requiresSponsorship: "yes" | "no" | "unknown";
  /** The country those two answers are true of, e.g. "Canada". */
  workAuthRegion: string | null;
  /** One honest sentence about the user's status, for the agent's prompt. */
  workAuthLabel: string | null;
}

/** The two DB rows `buildApplicantData` reads, narrowed to what it uses. */
export interface ApplicantSources {
  contact: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    links?: string[] | null;
  } | null;
  prefs: {
    locations?: string[] | null;
    workAuth?: string | null;
  } | null;
}

/**
 * `profiles.contact` + `search_prefs` → `ApplicantData`.
 *
 * Pure (no DB handle, no environment) so `run.ts` stays the only module that
 * touches the database and this mapping is testable on its own. Links are a
 * free-form `string[]` in the profile, so they're classified by hostname:
 * anything that isn't LinkedIn or GitHub becomes the "website / portfolio"
 * answer, which is what those form fields actually mean.
 */
export function buildApplicantData(src: ApplicantSources): ApplicantData {
  const fullName = (src.contact?.name ?? "").trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  // Everything after the first token is the surname: "van der Berg" is one
  // name, and splitting it would put "van" in the last-name box.
  const firstName = parts.length > 0 ? parts[0] : "";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";

  const links = (src.contact?.links ?? []).map((l) => l.trim()).filter(Boolean);
  const pick = (test: (l: string) => boolean) =>
    links.find((l) => test(l.toLowerCase())) ?? null;

  const linkedin = pick((l) => l.includes("linkedin.com"));
  const github = pick((l) => l.includes("github.com") || l.includes("gitlab.com"));
  const website =
    links.find((l) => l !== linkedin && l !== github) ?? null;

  // Prefs hold "Toronto, ON" / "Calgary, AB"; forms want the city alone.
  const firstLocation = (src.prefs?.locations ?? []).find(
    (l) => l && l.trim() && l.trim().toLowerCase() !== "remote",
  );
  const city = firstLocation ? firstLocation.split(",")[0].trim() : null;

  const auth = workAuthAnswers(src.prefs?.workAuth ?? null);

  return {
    firstName,
    lastName,
    fullName,
    email: (src.contact?.email ?? "").trim(),
    phone: (src.contact?.phone ?? "").trim(),
    linkedin,
    github,
    website,
    city: city || null,
    currentOrg: null,
    ...auth,
  };
}

/**
 * `search_prefs.work_auth` → the two questions every ATS asks, plus the
 * country those answers are actually true of.
 *
 * The prefs enum says *where* the user may work; the form question is always
 * about *this* posting's country. Collapsing the two — answering "Yes, I am
 * authorised" on an Australian posting because the user can work in Canada —
 * would be a materially false statement on a job application, so the region
 * travels with the answer and the agent is told to treat any other country as
 * unknown. Anything unrecognised (including `null`) is `unknown` throughout.
 */
function workAuthAnswers(workAuth: string | null): {
  workAuthorized: ApplicantData["workAuthorized"];
  requiresSponsorship: ApplicantData["requiresSponsorship"];
  workAuthRegion: string | null;
  workAuthLabel: string | null;
} {
  switch (workAuth) {
    case "canada":
      return {
        workAuthorized: "yes",
        requiresSponsorship: "no",
        workAuthRegion: "Canada",
        workAuthLabel: "Authorised to work in Canada without sponsorship.",
      };
    case "us_citizen_pr":
      return {
        workAuthorized: "yes",
        requiresSponsorship: "no",
        workAuthRegion: "the United States",
        workAuthLabel:
          "US citizen or permanent resident; authorised to work in the United States without sponsorship.",
      };
    case "needs_sponsorship":
      return {
        workAuthorized: "no",
        requiresSponsorship: "yes",
        workAuthRegion: null,
        workAuthLabel: "Requires visa sponsorship.",
      };
    case "tn_eligible":
      // TN status is employer-filed paperwork, not a permit the candidate
      // already holds: "not currently authorised, and yes something must be
      // filed" is the truthful pair of answers.
      return {
        workAuthorized: "no",
        requiresSponsorship: "yes",
        workAuthRegion: "the United States",
        workAuthLabel:
          "Canadian citizen, eligible for TN status in the United States — the employer must file TN paperwork.",
      };
    default:
      return {
        workAuthorized: "unknown",
        requiresSponsorship: "unknown",
        workAuthRegion: null,
        workAuthLabel: null,
      };
  }
}

/** One row of the selector table: try each selector in order, first hit wins. */
export interface FastPathField {
  /** Stable name used in `filled` / `remaining` and in the agent's prompt. */
  name: string;
  selectors: string[];
  value: string;
  kind: "text" | "file";
}

/**
 * The subset of Playwright's `Page` the fast path is allowed to use.
 *
 * Keeping this deliberately tiny is what makes the module testable, and it
 * also caps how clever the fast path can get: anything needing
 * `page.evaluate`, element handles or frame juggling is by construction the
 * tool loop's job. A real `import('playwright').Page` satisfies this
 * structurally (asserted at the `run.ts` call site by the type checker).
 */
export interface FastPathPage {
  url(): string;
  /** Presence probe. Returns a truthy handle or `null`; we only read truthiness. */
  $(selector: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  setInputFiles?(selector: string, files: string): Promise<void>;
  waitForTimeout?(ms: number): Promise<void>;
  /** Present on a real page; used to accept a typeahead's first suggestion. */
  keyboard?: { press(key: string): Promise<void> };
}

export interface FillFastPathOptions {
  /** Absolute path to the resume PDF; omitted/null → resume left to the loop. */
  resumePath?: string | null;
}

export interface FastPathResult {
  /** Field names successfully filled, in the order they were filled. */
  filled: string[];
  /** Field names this ATS has but the fast path could not complete. */
  remaining: string[];
}

const RESUME_SELECTORS = [
  "input#resume",
  'input[type="file"][name*="resume" i]',
  'input[type="file"][id*="resume" i]',
  'input[name="_systemfield_resume"]',
  'input[type="file"]',
];

/**
 * Every field name the fast path knows for an ATS, in fill order.
 *
 * `remaining` is computed against this list rather than against the fields
 * that had a value, so "no LinkedIn on file" and "LinkedIn box not found on
 * the page" both correctly land in the tool loop's to-do list.
 */
function fieldNames(ats: AtsKind): string[] {
  switch (ats) {
    case "greenhouse":
      return [
        "first_name",
        "last_name",
        "email",
        "phone",
        "location",
        "linkedin",
        "github",
        "website",
        "resume",
        "work_auth",
      ];
    case "lever":
      return [
        "full_name",
        "email",
        "phone",
        "current_org",
        "linkedin",
        "github",
        "website",
        "resume",
        "work_auth",
      ];
    case "ashby":
      return ["full_name", "email", "phone", "linkedin", "website", "resume", "work_auth"];
    case "generic":
      return [
        "first_name",
        "last_name",
        "full_name",
        "email",
        "phone",
        "linkedin",
        "website",
        "resume",
        "work_auth",
      ];
  }
}

/**
 * The selector table for one ATS, filtered to the fields that actually have a
 * value. Exported because it is pure: the CLI prints it in `--dry-run` and the
 * tests assert on it without a page.
 *
 * Selector order matters and is the ported v1 ordering: most specific first
 * (Greenhouse's `#first_name`, Lever's `name="urls[LinkedIn]"`), generic
 * attribute matches last, so a page with several text inputs does not get the
 * email typed into a search box.
 */
export function fastPathFields(
  ats: AtsKind,
  data: ApplicantData,
  opts: FillFastPathOptions = {},
): FastPathField[] {
  const resumePath = opts.resumePath ?? null;
  const text = (name: string, selectors: string[], value: string | null): FastPathField | null =>
    value && value.trim() ? { name, selectors, value: value.trim(), kind: "text" } : null;

  const resume: FastPathField | null = resumePath
    ? { name: "resume", selectors: RESUME_SELECTORS, value: resumePath, kind: "file" }
    : null;

  const linkedinSelectors = [
    'input[id*="linkedin" i]',
    'input[name*="linkedin" i]',
    'input[placeholder*="LinkedIn" i]',
  ];
  const githubSelectors = [
    'input[id*="github" i]',
    'input[name*="github" i]',
    'input[placeholder*="GitHub" i]',
  ];
  const websiteSelectors = [
    'input[id*="website" i]',
    'input[id*="portfolio" i]',
    'input[name*="website" i]',
    'input[name*="portfolio" i]',
    'input[placeholder*="Portfolio" i]',
  ];

  const fields: (FastPathField | null)[] = (() => {
    switch (ats) {
      case "greenhouse":
        return [
          text("first_name", ["input#first_name", 'input[name="job_application[first_name]"]', 'input[autocomplete="given-name"]'], data.firstName),
          text("last_name", ["input#last_name", 'input[name="job_application[last_name]"]', 'input[autocomplete="family-name"]'], data.lastName),
          text("email", ["input#email", 'input[name="job_application[email]"]', 'input[type="email"]'], data.email),
          text("phone", ["input#phone", 'input[name="job_application[phone]"]', 'input[type="tel"]'], data.phone),
          text(
            "location",
            [
              "input#candidate-location",
              "input#location",
              'input[name="job_application[location]"]',
              'input[placeholder*="City" i]',
              'input[aria-label*="city" i]',
            ],
            data.city,
          ),
          text("linkedin", linkedinSelectors, data.linkedin),
          text("github", githubSelectors, data.github),
          text("website", websiteSelectors, data.website),
          resume,
        ];
      case "lever":
        return [
          text("full_name", ['input[name="name"]', "input#name", 'input[placeholder*="Full name" i]'], data.fullName),
          text("email", ['input[name="email"]', "input#email", 'input[type="email"]'], data.email),
          text("phone", ['input[name="phone"]', "input#phone", 'input[type="tel"]'], data.phone),
          text("current_org", ['input[name="org"]', "input#org", 'input[placeholder*="Current company" i]'], data.currentOrg),
          text("linkedin", ['input[name="urls[LinkedIn]"]', ...linkedinSelectors], data.linkedin),
          text("github", ['input[name="urls[GitHub]"]', ...githubSelectors], data.github),
          text("website", ['input[name="urls[Portfolio]"]', 'input[name="urls[Other]"]', ...websiteSelectors], data.website),
          resume,
        ];
      case "ashby":
        return [
          text("full_name", ['input[name="_systemfield_name"]', 'input[name="name"]', 'input[placeholder*="Name" i]'], data.fullName),
          text("email", ['input[name="_systemfield_email"]', 'input[name="email"]', 'input[type="email"]'], data.email),
          text("phone", ['input[name="_systemfield_phone"]', 'input[name="phone"]', 'input[type="tel"]'], data.phone),
          text("linkedin", ['input[name="linkedInUrl"]', ...linkedinSelectors], data.linkedin),
          text("website", ['input[name="websiteUrl"]', ...websiteSelectors], data.website),
          resume,
        ];
      case "generic":
        return [
          text("first_name", ['input[autocomplete="given-name"]', 'input[name*="first" i]', 'input[id*="first" i]', 'input[placeholder*="First" i]'], data.firstName),
          text("last_name", ['input[autocomplete="family-name"]', 'input[name*="last" i]', 'input[id*="last" i]', 'input[placeholder*="Last" i]'], data.lastName),
          text("full_name", ['input[autocomplete="name"]', 'input[name="name"]', 'input[id="name"]'], data.fullName),
          text("email", ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]'], data.email),
          text("phone", ['input[type="tel"]', 'input[name*="phone" i]', 'input[id*="phone" i]'], data.phone),
          text("linkedin", linkedinSelectors, data.linkedin),
          text("website", websiteSelectors, data.website),
          resume,
        ];
    }
  })();

  return fields.filter((f): f is FastPathField => f !== null);
}

/**
 * Fill what can be filled deterministically; report what is left.
 *
 * Never throws: a stale selector, a detached element or a cross-origin frame
 * is a normal event on a live careers page, and the fast path is an
 * optimisation — anything it misses is simply handed to the tool loop via
 * `remaining` rather than aborting the run.
 */
export async function fillFastPath(
  page: FastPathPage,
  ats: AtsKind,
  data: ApplicantData,
  opts: FillFastPathOptions = {},
): Promise<FastPathResult> {
  const filled: string[] = [];

  for (const field of fastPathFields(ats, data, opts)) {
    for (const selector of field.selectors) {
      let present = false;
      try {
        present = Boolean(await page.$(selector));
      } catch {
        present = false;
      }
      if (!present) continue;

      try {
        if (field.kind === "file") {
          if (!page.setInputFiles) break;
          await page.setInputFiles(selector, field.value);
        } else {
          await page.fill(selector, field.value);
          if (field.name === "location") await acceptTypeahead(page);
        }
        filled.push(field.name);
      } catch {
        // Selector matched but the interaction failed (element detached,
        // readonly, obscured by an overlay). Leave it for the tool loop,
        // which can see the page and try another way.
      }
      break;
    }
  }

  const remaining = fieldNames(ats).filter((n) => !filled.includes(n));
  return { filled, remaining };
}

/**
 * Greenhouse's city box is a Google-Places typeahead: a plain `fill` puts the
 * text in but leaves the underlying value uncommitted, and the form submits
 * empty. Pressing ArrowDown+Enter accepts the first suggestion, which is what
 * a human does. Best-effort — if there is no keyboard (fake page in tests) or
 * no dropdown, the text stays typed and the tool loop can see the state.
 */
async function acceptTypeahead(page: FastPathPage): Promise<void> {
  if (!page.keyboard) return;
  try {
    await page.waitForTimeout?.(900);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
  } catch {
    // no suggestion list — leave the typed text as-is
  }
}
