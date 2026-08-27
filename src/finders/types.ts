/**
 * Shared vocabulary for the finders (spec §6).
 *
 * A "finder" is one ATS vendor's public job-board API wrapped so that the rest
 * of the system never has to know the vendor's JSON/XML shape: it hands back
 * `RawJob`s and nothing else. `src/finders/run.ts` is the only place that
 * knows *which* finders exist; everything downstream (filters, ranking, the
 * apply agent) works off `RawJob` / the `jobs` table.
 *
 * The two enum-backed unions are derived from the Drizzle enums (type-only
 * import, so importing this module pulls in no runtime DB code) — that keeps
 * `AtsVendor` from drifting away from the `ats_vendor` Postgres enum.
 */
import type { atsVendorEnum, workAuthSignalEnum } from "../db/schema";

export type AtsVendor = (typeof atsVendorEnum.enumValues)[number];
export type WorkAuthSignal = (typeof workAuthSignalEnum.enumValues)[number];

/**
 * One posting exactly as the vendor published it — no filtering, no scoring,
 * no company attribution (the caller already knows which company slug it
 * asked for).
 *
 * - `externalId` is the vendor's own id for the posting. It is stored so a
 *   later run can tell "the same posting, re-listed at a new URL" from "a new
 *   posting"; the upsert key is still `url` (spec §4).
 * - `description` is **plain text**, already stripped of HTML/entities, so the
 *   filters and the `analyze` step never see markup.
 * - `postedAt` is null when the board does not publish one (several do not).
 */
export type RawJob = {
  externalId: string;
  url: string;
  title: string;
  location: string | null;
  remote: boolean;
  description: string;
  postedAt: Date | null;
};

/**
 * `fetchJobs` takes the company's slug on that vendor's board (`companies.
 * ats_slug`) and returns every currently-listed posting. It throws on a
 * transport/parse failure — `runFinders` catches per company so one dead board
 * never aborts a run (spec §12).
 */
export interface Finder {
  vendor: AtsVendor;
  fetchJobs(slug: string): Promise<RawJob[]>;
}

/** Vendor-level failure that is a configuration problem, not a dead board. */
export class VendorRequiresKeyError extends Error {
  constructor(
    readonly vendor: AtsVendor,
    readonly status: number,
  ) {
    super(
      `${vendor}: public listing endpoint returned ${status} (requires_key) — skipping vendor`,
    );
    this.name = "VendorRequiresKeyError";
  }
}
