import { eq } from "drizzle-orm";
import type { Command } from "commander";
import { getDirectDb } from "../../src/db/client";
import { applications } from "../../src/db/schema";
import { logOutcome } from "../../src/funnel/outcomes";
import type { OutcomeEventType } from "../../src/funnel/derive";

const OUTCOME_TYPES: readonly OutcomeEventType[] = [
  "applied",
  "viewed",
  "response",
  "oa",
  "phone_screen",
  "interview",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
];

function parseOutcomeType(value: string): OutcomeEventType {
  if ((OUTCOME_TYPES as readonly string[]).includes(value)) {
    return value as OutcomeEventType;
  }
  throw new Error(`Unknown outcome type "${value}". Expected one of: ${OUTCOME_TYPES.join(", ")}`);
}

function parseAt(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--at "${value}" is not a valid ISO date/time.`);
  }
  return date;
}

/**
 * `applyops outcome <applicationId> <type> [--at ISO] [--notes]` — plan
 * Task 10: the operator-CLI equivalent of clicking an outcome button in
 * `/applications`. Runs against `getDirectDb()` (a one-off script, not
 * request-scoped app code — see src/db/client.ts) and shares
 * `logOutcome`/`currentStage` with the web route, so a CLI-logged event
 * updates `applications.status` exactly the same way. There is no session
 * here, so ownership is resolved from the application row itself rather
 * than an authenticated caller — this CLI is the owner's own operator tool
 * (spec §2: runs on the owner's Mac), not exposed to invited users.
 */
export function register(program: Command): void {
  program
    .command("outcome <applicationId> <type>")
    .description(
      `Log an outcome event for an application (type: ${OUTCOME_TYPES.join(", ")}).`,
    )
    .option("--at <iso>", "when the event occurred (ISO 8601); defaults to now")
    .option("--notes <text>", "free-text note to attach to the event")
    .action(async (applicationId: string, type: string, options: { at?: string; notes?: string }) => {
      const eventType = parseOutcomeType(type);
      const occurredAt = parseAt(options.at);

      const db = getDirectDb();
      const [application] = await db
        .select({ userId: applications.userId })
        .from(applications)
        .where(eq(applications.id, applicationId))
        .limit(1);
      if (!application) {
        throw new Error(`No application found with id "${applicationId}".`);
      }

      const result = await logOutcome(db, application.userId, {
        applicationId,
        type: eventType,
        occurredAt,
        notes: options.notes,
      });
      if (!result) {
        throw new Error(`No application found with id "${applicationId}".`);
      }

      console.log(
        `Logged "${result.event.type}" for application ${applicationId} at ${result.event.occurredAt.toISOString()}. Status is now "${result.status}".`,
      );

      // postgres-js keeps its socket open after this resolves, and
      // cli/index.ts only calls process.exit() on the error path (see its
      // `.catch()`), so without this a successful run never returns
      // control to the shell. Exiting explicitly here is scoped to this
      // command rather than changing that shared entry point.
      process.exit(0);
    });
}
