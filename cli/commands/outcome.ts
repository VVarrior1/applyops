import { eq } from "drizzle-orm";
import type { Command } from "commander";
import { closeDb, getDirectDb } from "../../src/db/client";
import { applications } from "../../src/db/schema";
import { logOutcome } from "../../src/funnel/outcomes";
import type { OutcomeEventType } from "../../src/funnel/derive";
import { createManualApplication, type ManualApplicationStatus } from "../../src/funnel/manual-application";
import { resolveUserId } from "../user-lookup";

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

function parseAt(value: string | undefined, flag: string = "--at"): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${flag} "${value}" is not a valid ISO date/time.`);
  }
  return date;
}

const MANUAL_STATUSES: readonly ManualApplicationStatus[] = [
  "applied",
  "responded",
  "interviewing",
  "offer",
  "rejected",
];

function parseManualStatus(value: string | undefined): ManualApplicationStatus | undefined {
  if (!value) return undefined;
  if ((MANUAL_STATUSES as readonly string[]).includes(value)) {
    return value as ManualApplicationStatus;
  }
  throw new Error(`Unknown status "${value}". Expected one of: ${MANUAL_STATUSES.join(", ")}`);
}

interface OutcomeAddOptions {
  company?: string;
  title?: string;
  location?: string;
  appliedAt?: string;
  notes?: string;
  status?: string;
  user?: string;
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
 *
 * `outcome add <url>` is a sibling subcommand for tracking an application
 * made OUTSIDE the app entirely (no existing `applications` row to point
 * at) — it shares `createManualApplication` with
 * `POST /api/applications/manual` (src/funnel/manual-application.ts).
 * Commander resolves `applyops outcome <applicationId> <type>` and
 * `applyops outcome add <url>` unambiguously: `add` only ever matches the
 * subcommand, and a real applicationId (a uuid) never collides with it.
 */
export function register(program: Command): void {
  const outcomeCommand = program
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

  outcomeCommand
    .command("add <url>")
    .description(
      "Track an application made outside the app (creates the job/company row if the URL is new).",
    )
    .option("--company <name>", "company name (fetched from the posting if omitted)")
    .option("--title <title>", "job title (fetched from the posting if omitted)")
    .option("--location <location>", "job location (fetched from the posting if omitted)")
    .option("--applied-at <iso>", "when you applied (ISO 8601 date/time); defaults to now")
    .option("--notes <text>", "free-text note to attach to the founding 'applied' event")
    .option(
      "--status <status>",
      `application status if you already know more (${MANUAL_STATUSES.join(", ")}); default "applied"`,
    )
    .option("-u, --user <email>", "whose application this is (default: OWNER_EMAIL)")
    .action(async (url: string, options: OutcomeAddOptions) => {
      const { userId } = await resolveUserId(options.user);
      const appliedAt = parseAt(options.appliedAt, "--applied-at");
      const status = parseManualStatus(options.status);

      const db = getDirectDb();
      const result = await createManualApplication(db, userId, {
        url,
        company: options.company,
        title: options.title,
        location: options.location,
        appliedAt,
        notes: options.notes,
        status,
      });

      console.log(
        result.existing
          ? `Already tracking this application (id ${result.id}).`
          : `Tracked application ${result.id}.`,
      );

      await closeDb();
    });
}
