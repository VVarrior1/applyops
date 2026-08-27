import { eq } from "drizzle-orm";
import type { Command } from "commander";
import { closeDb, getDirectDb } from "../../src/db/client";
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

      // cli/index.ts only calls process.exit() on the error path (see its
      // `.catch()`), and postgres-js keeps its socket open indefinitely
      // once connected, so without closing it here a successful run would
      // never return control to the shell. closeDb() (rather than
      // process.exit()) lets Node exit naturally once the socket is
      // closed, which also guarantees stdout is flushed first — piping
      // this command's output (`| tee log.txt`) or redirecting it
      // (`> out.txt`) won't lose the success line the way an immediate
      // `process.exit()` can.
      await closeDb();
    });
}
