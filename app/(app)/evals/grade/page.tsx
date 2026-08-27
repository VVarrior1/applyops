import Link from "next/link";
import { requireOwner } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { gradingProgress } from "@/src/eval/golden";
import { Grader } from "@/components/evals/Grader";

/**
 * `/evals/grade` — owner-only (spec §7: "this is the owner's one manual task").
 *
 * The page itself only proves ownership and hands the client the progress
 * counter; the item, its sample and the save round-trip all go through
 * `/api/evals/grade`, so grading one item never re-renders the shell.
 */
export default async function GradePage() {
  await requireOwner();
  const progress = await gradingProgress(getDb(), "tailor");

  return (
    <div className="flex flex-col gap-4">
      <Link href="/evals" className="text-sm text-muted-foreground hover:text-foreground">
        ← Eval runs
      </Link>
      <Grader initialProgress={progress} />
    </div>
  );
}
