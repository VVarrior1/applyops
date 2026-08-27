import { requireUser } from "@/src/auth/require";
import { PendingApprovals } from "@/components/applications/PendingApprovals";

/**
 * Applications dashboard.
 *
 * NOTE FOR THE INTEGRATOR: Task 12 owns the body of this page (the outcome
 * funnel buttons and the application list). Task 15 only contributes the
 * `<PendingApprovals />` panel above it — when merging, keep Task 12's page
 * and add the two lines that import and render the panel.
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
