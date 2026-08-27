import { requireUser } from "@/src/auth/require";
import { PendingApprovals } from "@/components/applications/PendingApprovals";

/**
 * Applications dashboard.
 *
 * NOTE FOR THE INTEGRATOR: Task 10 owns the body of this page (plan line 254:
 * `app/(app)/applications/page.tsx` + `components/applications/OutcomeButtons.tsx`),
 * so this file will conflict as a whole. Task 15 only contributes the
 * `<PendingApprovals />` panel above the list — when merging, keep Task 10's
 * page body and add exactly the two lines that import and render the panel:
 *
 *   import { PendingApprovals } from "@/components/applications/PendingApprovals";
 *   <PendingApprovals userId={user.id} />
 */
export default async function ApplicationsPage() {
  const user = await requireUser();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Applications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything you have applied to, and anything the apply agent is waiting on.
        </p>
      </div>

      <PendingApprovals userId={user.id} />
    </div>
  );
}
