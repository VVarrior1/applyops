import { Badge } from "@/components/ui/badge";

export interface PostingTabProps {
  title: string;
  companyName: string | null;
  location: string | null;
  remote: boolean | null;
  url: string;
  description: string | null;
  postedAt: string | null;
}

/**
 * `/jobs/[id]`'s "Posting" tab — plan Task 8 Step 3: description, link,
 * company. Purely presentational: no fetching, no state. The page fetches
 * everything server-side and calls `ensureAnalysis()` directly before this
 * even renders, so by the time a user is looking at this tab the Fit tab's
 * "Score this job" call already has an analyzed posting to work from.
 */
export function PostingTab({
  title,
  companyName,
  location,
  remote,
  url,
  description,
  postedAt,
}: PostingTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>{companyName ?? "Unknown company"}</span>
          {location && (
            <>
              <span aria-hidden>·</span>
              <span>{location}</span>
            </>
          )}
          {remote && <Badge variant="outline">Remote</Badge>}
          {postedAt && (
            <>
              <span aria-hidden>·</span>
              <span>Posted {postedAt}</span>
            </>
          )}
        </div>
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sm text-primary underline underline-offset-2"
        >
          View the original posting ↗
        </a>
      </div>

      <div className="whitespace-pre-wrap rounded-lg border bg-card p-4 text-sm leading-relaxed">
        {description && description.trim().length > 0
          ? description
          : "No description was captured for this posting — use the link above."}
      </div>
    </div>
  );
}
