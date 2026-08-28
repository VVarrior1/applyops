"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
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
 * `router.replace` (not `push`) so clicking between tabs doesn't pile up
 * back-button entries — the URL still reflects the active tab for a
 * refresh or a link shared mid-session, which is what the spec asks for.
 */
export function JobDetailTabs({
  jobId,
  initialTab,
  posting,
  fit,
  initialTailorGeneration,
  initialSuggestGeneration,
}: JobDetailTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<JobDetailTab>(initialTab);

  function handleTabChange(value: unknown) {
    const next = isJobDetailTab(String(value)) ? (String(value) as JobDetailTab) : "posting";
    setTab(next);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
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
