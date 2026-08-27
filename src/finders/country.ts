/**
 * Country detection for job locations.
 *
 * ATS location strings are free text: "Remote - Mexico", "Calgary, AB",
 * "San Francisco, CA", "Remote (US or Canada)", "Poland - Remote". This module
 * maps them to ISO-3166 alpha-2 codes so a user's `countries` preference can
 * exclude remote roles that are actually restricted to another country.
 *
 * Returns an ordered, de-duplicated list; `[]` means "unknown / anywhere"
 * (bare "Remote", "EMEA", "Worldwide"). Callers treat unknown as *allowed*
 * so genuinely global remote roles are not hidden.
 */

export type CountryCode = string; // ISO-3166 alpha-2

export const COUNTRY_OPTIONS: ReadonlyArray<{ code: CountryCode; name: string }> = [
  { code: "CA", name: "Canada" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "DE", name: "Germany" },
  { code: "NL", name: "Netherlands" },
  { code: "FR", name: "France" },
  { code: "ES", name: "Spain" },
  { code: "PT", name: "Portugal" },
  { code: "IT", name: "Italy" },
  { code: "CH", name: "Switzerland" },
  { code: "AT", name: "Austria" },
  { code: "BE", name: "Belgium" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "DK", name: "Denmark" },
  { code: "FI", name: "Finland" },
  { code: "PL", name: "Poland" },
  { code: "CZ", name: "Czechia" },
  { code: "RO", name: "Romania" },
  { code: "HU", name: "Hungary" },
  { code: "UA", name: "Ukraine" },
  { code: "GR", name: "Greece" },
  { code: "BG", name: "Bulgaria" },
  { code: "RS", name: "Serbia" },
  { code: "HR", name: "Croatia" },
  { code: "LT", name: "Lithuania" },
  { code: "LV", name: "Latvia" },
  { code: "EE", name: "Estonia" },
  { code: "TR", name: "Türkiye" },
  { code: "IL", name: "Israel" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "IN", name: "India" },
  { code: "PK", name: "Pakistan" },
  { code: "BD", name: "Bangladesh" },
  { code: "SG", name: "Singapore" },
  { code: "MY", name: "Malaysia" },
  { code: "PH", name: "Philippines" },
  { code: "VN", name: "Vietnam" },
  { code: "ID", name: "Indonesia" },
  { code: "TH", name: "Thailand" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "TW", name: "Taiwan" },
  { code: "HK", name: "Hong Kong" },
  { code: "CN", name: "China" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "MX", name: "Mexico" },
  { code: "BR", name: "Brazil" },
  { code: "AR", name: "Argentina" },
  { code: "CO", name: "Colombia" },
  { code: "CL", name: "Chile" },
  { code: "PE", name: "Peru" },
  { code: "UY", name: "Uruguay" },
  { code: "CR", name: "Costa Rica" },
  { code: "NI", name: "Nicaragua" },
  { code: "GT", name: "Guatemala" },
  { code: "DO", name: "Dominican Republic" },
  { code: "ZA", name: "South Africa" },
  { code: "NG", name: "Nigeria" },
  { code: "KE", name: "Kenya" },
  { code: "EG", name: "Egypt" },
];

// Lower-cased alias → code. Multi-word aliases are matched as whole phrases.
const NAME_ALIASES: Record<string, CountryCode> = {
  canada: "CA",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  "u.s": "US",
  "puerto rico": "US",
  "united kingdom": "GB",
  uk: "GB",
  "u.k.": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  "great britain": "GB",
  "czech republic": "CZ",
  czechia: "CZ",
  turkey: "TR",
  türkiye: "TR",
  "south korea": "KR",
  korea: "KR",
  "hong kong": "HK",
  "new zealand": "NZ",
  "costa rica": "CR",
  "dominican republic": "DO",
  "south africa": "ZA",
  "united arab emirates": "AE",
  uae: "AE",
  dubai: "AE",
  netherlands: "NL",
  "the netherlands": "NL",
  holland: "NL",
  vietnam: "VN",
  "viet nam": "VN",
  ...Object.fromEntries(
    COUNTRY_OPTIONS.filter((o) => !["Türkiye", "United Kingdom", "United States", "Czechia", "South Korea", "Hong Kong", "New Zealand", "Costa Rica", "Dominican Republic", "South Africa", "United Arab Emirates", "Netherlands"].includes(o.name)).map((o) => [o.name.toLowerCase(), o.code]),
  ),
};

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};
const CA_PROVINCES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador",
  NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island",
  QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};

const US_CITIES = [
  "new york", "nyc", "san francisco", "sf bay area", "bay area", "los angeles", "seattle", "austin", "boston",
  "chicago", "denver", "atlanta", "dallas", "houston", "miami", "washington dc", "washington, d.c.", "san jose",
  "san diego", "portland", "phoenix", "philadelphia", "minneapolis", "salt lake city", "raleigh", "pittsburgh",
  "detroit", "nashville", "charlotte", "palo alto", "mountain view", "menlo park", "sunnyvale", "redmond", "bellevue",
  "cambridge, ma", "brooklyn", "santa clara", "oakland", "irvine", "boulder", "columbus", "st. louis", "kansas city",
];
const CA_CITIES = [
  "toronto", "vancouver", "montreal", "montréal", "calgary", "edmonton", "ottawa", "waterloo", "kitchener", "mississauga",
  "winnipeg", "halifax", "victoria, bc", "quebec city", "québec", "hamilton, on", "burnaby", "markham", "saskatoon", "regina",
];

// Tokens that mean "anywhere" rather than a country.
const GLOBAL_TOKENS = /\b(remote|anywhere|worldwide|global|emea|apac|latam|americas|europe|asia|international|hybrid|on-?site|flexible|distributed|multiple locations|various)\b/gi;

function addUnique(out: CountryCode[], code: CountryCode) {
  if (!out.includes(code)) out.push(code);
}

/** Detect ISO-3166 alpha-2 codes mentioned in a location string (ordered by first mention, unique). */
export function detectCountries(location: string | null | undefined, description?: string | null): CountryCode[] {
  const scan = (raw: string): CountryCode[] => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return [];
    const lower = text.toLowerCase();
    const hits: Array<{ at: number; code: CountryCode }> = [];

    // 1. Whole-phrase country names / aliases.
    for (const alias of Object.keys(NAME_ALIASES)) {
      const re = new RegExp(`(^|[^a-z])(${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^a-z])`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(lower)) !== null) hits.push({ at: m.index + m[1].length, code: NAME_ALIASES[alias] });
    }
    // 1b. Bare uppercase "US" / "USA" / "UK" tokens (case-sensitive so "us" in prose is ignored).
    for (const [tok, code] of [["US", "US"], ["USA", "US"], ["UK", "GB"]] as const) {
      const re = new RegExp(`(^|[^A-Za-z])(${tok})(?=$|[^A-Za-z])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) hits.push({ at: m.index + m[1].length, code });
    }

    // 2. State / province full names.
    for (const name of Object.values(US_STATES)) { const i = lower.search(new RegExp(`\\b${name.toLowerCase()}\\b`)); if (i >= 0) hits.push({ at: i, code: "US" }); }
    for (const name of Object.values(CA_PROVINCES)) { const i = lower.search(new RegExp(`\\b${name.toLowerCase()}\\b`)); if (i >= 0) hits.push({ at: i, code: "CA" }); }

    // 3. Two-letter state/province codes as standalone uppercase tokens after a
    //    separator (", AB", "(NY)", "- TX"). Provinces win on overlap; "CA" is
    //    always California, never Canada.
    const codeRe = /(?:^|[,(\-–—/|]\s*)([A-Z]{2})(?=\s*(?:$|[,;)\-–—/|]))/g;
    let m: RegExpExecArray | null;
    while ((m = codeRe.exec(text)) !== null) {
      const code = m[1]; const at = m.index;
      if (code in CA_PROVINCES) hits.push({ at, code: "CA" });
      else if (code in US_STATES) hits.push({ at, code: "US" });
    }

    // 4. Well-known cities.
    for (const city of US_CITIES) { const i = lower.indexOf(city); if (i >= 0) hits.push({ at: i, code: "US" }); }
    for (const city of CA_CITIES) { const i = lower.indexOf(city); if (i >= 0) hits.push({ at: i, code: "CA" }); }

    hits.sort((a, b) => a.at - b.at);
    const out: CountryCode[] = [];
    for (const h of hits) addUnique(out, h.code);
    return out;
  };

  const fromLocation = scan(location ?? "");
  if (fromLocation.length > 0 || !description) return fromLocation;
  // Only trust the description for explicit "located in <country>" style restrictions.
  const restrict = description.match(/(?:located|based|reside|residing|eligible to work|authorized to work|candidates)\s+(?:in|within)\s+(?:the\s+)?([A-Za-z .]{2,40})/i);
  return restrict ? scan(restrict[1]) : [];
}

/** Order-preserving overlap test: does the job allow any of the user's countries? Unknown ([]) → allowed. */
export function countriesAllow(jobCountries: CountryCode[] | null | undefined, wanted: CountryCode[] | null | undefined): boolean {
  if (!jobCountries || jobCountries.length === 0) return true;
  if (!wanted || wanted.length === 0) return true;
  return jobCountries.some((c) => wanted.includes(c));
}

export function isKnownCountry(code: string): boolean {
  return COUNTRY_OPTIONS.some((o) => o.code === code);
}

// Unused-alias guard so the GLOBAL_TOKENS regex stays referenced (used by finders to strip noise).
export { GLOBAL_TOKENS };
