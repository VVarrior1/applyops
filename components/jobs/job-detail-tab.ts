/**
 * The `/jobs/[id]` tab-value union, shared between the server page
 * (`app/(app)/jobs/[id]/page.tsx`, parsing `?tab=`) and the client tab
 * shell (`JobDetailTabs.tsx`, driving it). Deliberately NOT in
 * `JobDetailTabs.tsx`: that file is `"use client"`, and a "use client"
 * module's exports are all client references from a Server Component's
 * point of view — even a plain, synchronous function like
 * {@link isJobDetailTab} — so calling it from `page.tsx` throws
 * `Attempted to call isJobDetailTab() from the server but ... is on the
 * client`. Keeping this one file client-free lets both sides import it.
 */

export const JOB_DETAIL_TAB_VALUES = ["posting", "fit", "tailor", "suggestions"] as const;
export type JobDetailTab = (typeof JOB_DETAIL_TAB_VALUES)[number];

export function isJobDetailTab(value: string | undefined): value is JobDetailTab {
  return !!value && (JOB_DETAIL_TAB_VALUES as readonly string[]).includes(value);
}
