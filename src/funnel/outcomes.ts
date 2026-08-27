/**
 * Outcome-event logging for one application — the write side that both the
 * `/applications` UI (`app/api/applications/[id]/outcome/route.ts`) and the
 * `outcome` CLI command (`cli/commands/outcome.ts`) call into, so there is
 * exactly one place that (a) checks the application belongs to the caller
 * and (b) recomputes `applications.status` after logging an event.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { applications, outcomeEvents } from "../db/schema";
import { currentStage, type ApplicationStage, type OutcomeEventType } from "./derive";

export interface LogOutcomeInput {
  applicationId: string;
  type: OutcomeEventType;
  /** Defaults to now — pass an explicit value for backdated/CLI logging (`outcome --at`). */
  occurredAt?: Date;
  notes?: string | null;
}

export interface OutcomeEventRecord {
  id: string;
  type: OutcomeEventType;
  occurredAt: Date;
  notes: string | null;
}

export interface LogOutcomeResult {
  event: OutcomeEventRecord;
  status: ApplicationStage;
}

/**
 * Inserts an `outcome_events` row for `input.applicationId`, then
 * recomputes and persists `applications.status` from that application's
 * *entire* event history (not just the new event) via
 * {@link currentStage} — see that function's doc comment for why: a
 * backdated event doesn't necessarily become the new "current" one.
 *
 * Returns `null` (no write performed) if no application with that id is
 * owned by `userId`, so callers can 404/403 without a separate existence
 * check racing this one.
 */
export async function logOutcome(
  db: Db,
  userId: string,
  input: LogOutcomeInput,
): Promise<LogOutcomeResult | null> {
  const [owned] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, input.applicationId), eq(applications.userId, userId)))
    .limit(1);
  if (!owned) return null;

  const [event] = await db
    .insert(outcomeEvents)
    .values({
      applicationId: input.applicationId,
      type: input.type,
      occurredAt: input.occurredAt ?? new Date(),
      notes: input.notes ?? null,
    })
    .returning({
      id: outcomeEvents.id,
      type: outcomeEvents.type,
      occurredAt: outcomeEvents.occurredAt,
      notes: outcomeEvents.notes,
    });

  const allEvents = await db
    .select({ type: outcomeEvents.type, occurredAt: outcomeEvents.occurredAt })
    .from(outcomeEvents)
    .where(eq(outcomeEvents.applicationId, input.applicationId))
    .orderBy(asc(outcomeEvents.occurredAt));

  const status = currentStage(allEvents);
  await db.update(applications).set({ status }).where(eq(applications.id, input.applicationId));

  return { event, status };
}
