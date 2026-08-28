"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FitTab, type FitTabProps } from "./FitTab";
import { isJobDetailTab, type JobDetailTab } from "./job-detail-tab";
import { PostingTab, type PostingTabProps } from "./PostingTab";
import { SuggestionsTab, type SuggestInitialGeneration } from "./SuggestionsTab";
import { TailorTab, type TailorInitialGeneration } from "./TailorTab";

export interface JobDetailTabsProps {
  jobId: string;
  initialTab: JobDetailTab;
  posting: PostingTabProps;
  fit: Omit<FitTabProps, "jobId">;
  initialTailorGeneration: TailorInitialGeneration | null;
  initialSuggestGeneration: SuggestInitialGeneration | null;
}

/**
 * `/jobs/[id]`'s tab shell. Client-side so the active tab can be controlled
 * (and pushed into `?tab=`) — task spec point 4 — while every panel stays
 * mounted via Base UI Tabs' `keepMounted` (its equivalent of Radix's
 * `forceMount` + `hidden`) so switching tabs never unmounts `FitTab` /
 * `TailorTab` / `SuggestionsTab` and discards whatever they've generated —
 * point 2's "keep TabsContent mounted ... or lift state, pick one" is
 * satisfied here by the mount strategy rather than lifting result state,
 * since each tab's result shape (editable bullets, hallucination reports)
 * is naturally owned by that tab, not the page shell.
 *
 * The URL update on tab change is a *shallow* one (`history.replaceState`,
 * not `router.replace`) — the App Router treats a `router.replace` to a
 * new `?tab=` as a client navigation and refetches this page's RSC
 * payload (rerunning every query in the page's `Promise.all`, including
 * `getConfirmedFacts` and both `checkCitations` passes) purely to change
 * the URL, even though no tab actually consumes those refreshed props
 * (each seeds its own `useState` once from the initial props). A plain
 * history update still means the URL reflects the active tab for a
 * refresh or a link shared mid-session, without the round trip.
 * `router.refresh()` stays in each tab's own actions, where fresh server
 * props are actually wanted.
 */
export function JobDetailTabs({
  jobId,
  initialTab,
  posting,
  fit,
  initialTailorGeneration,
  initialSuggestGeneration,
}: JobDetailTabsProps) {
  const pathname = usePathname();
  const [tab, setTab] = useState<JobDetailTab>(initialTab);

  function handleTabChange(value: unknown) {
    const next = isJobDetailTab(String(value)) ? (String(value) as JobDetailTab) : "posting";
    setTab(next);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", next);
    // Shallow URL-only update — see the doc comment above for why this
    // isn't `router.replace`.
    window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
  }

  return (
    <Tabs value={tab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="posting">Posting</TabsTrigger>
        <TabsTrigger value="fit">Fit</TabsTrigger>
        <TabsTrigger value="tailor">Tailor</TabsTrigger>
        <TabsTrigger value="suggestions">Suggestions</TabsTrigger>
      </TabsList>

      <TabsContent value="posting" keepMounted>
        <PostingTab {...posting} />
      </TabsContent>

      <TabsContent value="fit" keepMounted>
        <FitTab jobId={jobId} {...fit} />
      </TabsContent>

      <TabsContent value="tailor" keepMounted>
        <TailorTab jobId={jobId} initialGeneration={initialTailorGeneration} />
      </TabsContent>

      <TabsContent value="suggestions" keepMounted>
        <SuggestionsTab jobId={jobId} initialGeneration={initialSuggestGeneration} />
      </TabsContent>
    </Tabs>
  );
}
