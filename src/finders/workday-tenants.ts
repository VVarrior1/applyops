/**
 * Seed list of Canadian (and Canada-relevant) Workday tenants — the
 * companies that only post jobs via Workday and would otherwise never show
 * up (spec: Workday finder). Every row here was verified with a real
 * `POST …/wday/cxs/{tenant}/{site}/jobs` request on 2026-08-27 and returned a
 * `total`/`jobPostings` response.
 *
 * v1 (`Job_Auto_Apply/scripts/scrape-apis.ts`, `WORKDAY_CONFIG`) hard-coded
 * nine tenants, all on host `wd3`. Re-probing them today: only TC Energy,
 * Enbridge and Suncor still answer — Shaw's tenant turned out to be Shaw
 * *Industries* (a Georgia flooring company, not Shaw Communications), and
 * ATB Financial, Alberta Health Services, Canada Post, TELUS and AMD no
 * longer expose a `myworkdayjobs.com` board under any guessable tenant/host
 * (moved ATS, or the board is now behind a custom domain this repo can't
 * derive from search results alone). Workday also does not use one host for
 * every tenant — `wd1`, `wd3`, `wd5`, `wd8`, `wd10` and `wd12` all showed up
 * across the tenants below — which is why `workday.ts` still falls back to
 * probing all six when a tenant shows up with no entry here (e.g. a company
 * a user adds by hand via `workday probe`).
 *
 * `site` is Workday's own "career site" identifier, not a slug this repo
 * invents — it's whatever the tenant named their site (`External`,
 * `Suncor_External`, `CAREER_SITE_TC`, …), read straight out of the URL
 * their careers page redirects to.
 */

export type WorkdayTenant = {
  /** Display name stored on the `companies` row. */
  name: string;
  /** Workday tenant id — the first label of `{tenant}.{host}.myworkdayjobs.com`. */
  tenant: string;
  /** Workday "career site" id — the path segment after the (optional) locale. */
  site: string;
  /** Workday pod host — `wd1`, `wd3`, `wd5`, `wd8`, `wd10`, `wd12`, … */
  host: string;
};

export const WORKDAY_TENANTS: WorkdayTenant[] = [
  // --- v1 allow-list survivors (re-verified 2026-08-27) ---
  { name: "TC Energy", tenant: "tcenergy", site: "CAREER_SITE_TC", host: "wd3" },
  { name: "Enbridge", tenant: "enbridge", site: "enbridge_careers", host: "wd3" },
  { name: "Suncor", tenant: "suncor", site: "Suncor_External", host: "wd1" },

  // --- Energy / utilities / regulators ---
  { name: "Cenovus Energy", tenant: "cenovus", site: "careers", host: "wd3" },
  { name: "Keyera", tenant: "keyera", site: "Keyera_Careers", host: "wd10" },
  { name: "Capital Power", tenant: "capitalpower", site: "External", host: "wd10" },
  { name: "Alberta Energy Regulator", tenant: "aer", site: "AER", host: "wd3" },

  // --- Banks / financial services / insurance ---
  { name: "RBC", tenant: "rbc", site: "RBCGLOBAL1", host: "wd3" },
  { name: "TD Bank", tenant: "td", site: "TD_Bank_Careers", host: "wd3" },
  { name: "BMO", tenant: "bmo", site: "External", host: "wd3" },
  { name: "CIBC", tenant: "cibc", site: "search", host: "wd3" },
  { name: "Desjardins", tenant: "desjardins", site: "Desjardins", host: "wd10" },
  { name: "Manulife", tenant: "manulife", site: "MFCJH_Jobs", host: "wd3" },
  { name: "Sun Life", tenant: "sunlife", site: "Experienced-Jobs", host: "wd3" },
  { name: "Intact Financial", tenant: "intactfc", site: "intactfc", host: "wd3" },
  { name: "Alberta Blue Cross", tenant: "abbluecross", site: "careers", host: "wd3" },
  { name: "PwC", tenant: "pwc", site: "Global_Experienced_Careers", host: "wd3" },

  // --- Retail ---
  { name: "Loblaw", tenant: "myview", site: "loblaw_careers", host: "wd3" },
  { name: "Canadian Tire", tenant: "canadiantirecorporation", site: "Enterprise_External_Careers_Site", host: "wd3" },
  { name: "Hudson's Bay", tenant: "mywdhr", site: "HudsonsBay_Careers", host: "wd1" },

  // --- Tech ---
  { name: "Cisco", tenant: "cisco", site: "Cisco_Careers", host: "wd5" },

  // --- Construction / engineering / aerospace ---
  { name: "Ledcor", tenant: "ledcor", site: "Ledcor_External", host: "wd3" },
  { name: "Bird Construction", tenant: "bird", site: "BirdConstructionCareers", host: "wd3" },
  { name: "CAE", tenant: "cae", site: "career", host: "wd3" },
  { name: "NAV Canada", tenant: "navcanada", site: "NAV_Careers", host: "wd10" },
];

/**
 * Tenant → host, seeded from the verified list above so `workday.ts` never
 * has to probe a tenant it already knows. Not exhaustive — a tenant added
 * later (e.g. via `workday probe`) falls back to `workday.ts`'s own
 * wd1/wd3/wd5/wd8/wd10/wd12 probe.
 */
export const WORKDAY_HOST_BY_TENANT: Record<string, string> = Object.fromEntries(
  WORKDAY_TENANTS.map((t) => [t.tenant, t.host]),
);
