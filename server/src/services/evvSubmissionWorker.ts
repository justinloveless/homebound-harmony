import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { evvSubmissionQueue, evvVisits } from '../db/schema';
import { buildEvvPayload, submitToAggregator, type EvvPayload } from './evvAggregatorClient';
import { validateAndSave } from './visitValidation';

type QueueRow = typeof evvSubmissionQueue.$inferSelect;

const POLL_INTERVAL_MS = 30_000;
const MAX_CONCURRENT = 5;

/** Exponential backoff: 2^attempts * 30s, capped at 1 hour. */
function nextRetryDelay(attempts: number): number {
  return Math.min(Math.pow(2, attempts) * 30_000, 3_600_000);
}

async function processEntry(entry: QueueRow): Promise<void> {
  const now = new Date();

  await db
    .update(evvSubmissionQueue)
    .set({ status: 'processing', lastAttemptAt: now, attempts: entry.attempts + 1 })
    .where(eq(evvSubmissionQueue.id, entry.id));

  try {
    let payload: EvvPayload;
    if (entry.payload && Object.keys(entry.payload as object).length > 0) {
      payload = entry.payload as EvvPayload;
    } else {
      payload = await buildEvvPayload(entry.tenantId, entry.evvVisitId);
      await db
        .update(evvSubmissionQueue)
        .set({ payload: payload as unknown as Record<string, unknown> })
        .where(eq(evvSubmissionQueue.id, entry.id));
    }

    const result = await submitToAggregator(entry.tenantId, payload);

    if (result.accepted) {
      await db
        .update(evvVisits)
        .set({
          evvStatus: 'accepted',
          evvExternalId: result.externalId ?? null,
          evvResponseAt: now,
          updatedAt: now,
        })
        .where(eq(evvVisits.id, entry.evvVisitId));

      await db
        .update(evvSubmissionQueue)
        .set({ status: 'submitted', errorMessage: null })
        .where(eq(evvSubmissionQueue.id, entry.id));

      console.log(`[EVV worker] Visit ${entry.evvVisitId} accepted (externalId=${result.externalId})`);
    } else {
      await db
        .update(evvVisits)
        .set({
          evvStatus: 'rejected',
          evvRejectionReason: result.rejectionReason ?? 'Rejected',
          evvResponseAt: now,
          updatedAt: now,
        })
        .where(eq(evvVisits.id, entry.evvVisitId));

      await db
        .update(evvSubmissionQueue)
        .set({
          status: 'rejected',
          errorMessage: result.rejectionReason ?? 'Rejected by aggregator',
        })
        .where(eq(evvSubmissionQueue.id, entry.id));

      console.warn(`[EVV worker] Visit ${entry.evvVisitId} rejected: ${result.rejectionReason}`);
    }

    // Re-validate billing after EVV status changes
    await validateAndSave(entry.tenantId, entry.evvVisitId).catch((err) =>
      console.error('[EVV worker] validateAndSave failed:', err),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const newAttempts = entry.attempts + 1;
    const isDead = newAttempts >= entry.maxAttempts;
    const retryAt = isDead ? null : new Date(Date.now() + nextRetryDelay(newAttempts));

    await db
      .update(evvSubmissionQueue)
      .set({
        status: isDead ? 'dead_letter' : 'retrying',
        errorMessage: message,
        nextRetryAt: retryAt,
      })
      .where(eq(evvSubmissionQueue.id, entry.id));

    if (isDead) {
      console.error(`[EVV worker] Visit ${entry.evvVisitId} dead-lettered after ${newAttempts} attempts: ${message}`);
    } else {
      console.warn(`[EVV worker] Visit ${entry.evvVisitId} attempt ${newAttempts} failed, retry at ${retryAt?.toISOString()}: ${message}`);
    }
  }
}

async function processQueue(): Promise<void> {
  try {
    const now = new Date();
    const entries = await db
      .select()
      .from(evvSubmissionQueue)
      .where(
        and(
          inArray(evvSubmissionQueue.status, ['pending', 'retrying']),
          or(isNull(evvSubmissionQueue.nextRetryAt), lte(evvSubmissionQueue.nextRetryAt, now)),
        ),
      )
      .limit(MAX_CONCURRENT);

    if (entries.length === 0) return;

    await Promise.allSettled(entries.map(processEntry));
  } catch (err) {
    console.error('[EVV worker] processQueue error:', err);
  }
}

export function startEvvSubmissionWorker(): void {
  void processQueue();
  setInterval(() => void processQueue(), POLL_INTERVAL_MS);
  console.log(`[EVV worker] Started (poll interval: ${POLL_INTERVAL_MS / 1000}s)`);
}

/** Enqueue a completed visit for EVV submission. Idempotent — silently ignores duplicate. */
export async function enqueueForSubmission(tenantId: string, evvVisitId: string): Promise<void> {
  await db
    .insert(evvSubmissionQueue)
    .values({ tenantId, evvVisitId })
    .onConflictDoNothing();
}

/** Reset dead-letter entries to pending for immediate retry. */
export async function retryDeadLetters(tenantId: string, ids?: string[]): Promise<number> {
  const baseCondition = and(
    eq(evvSubmissionQueue.tenantId, tenantId),
    eq(evvSubmissionQueue.status, 'dead_letter'),
  );
  const condition = ids && ids.length > 0
    ? and(baseCondition, inArray(evvSubmissionQueue.id, ids))
    : baseCondition;

  const rows = await db
    .update(evvSubmissionQueue)
    .set({ status: 'pending', nextRetryAt: null, errorMessage: null })
    .where(condition)
    .returning({ id: evvSubmissionQueue.id });

  return rows.length;
}

/** Status counts for the admin pipeline view. */
export async function getPipelineStatus(tenantId: string): Promise<{
  counts: Record<string, number>;
  deadLetters: QueueRow[];
}> {
  const rows = await db
    .select({
      status: evvSubmissionQueue.status,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(evvSubmissionQueue)
    .where(eq(evvSubmissionQueue.tenantId, tenantId))
    .groupBy(evvSubmissionQueue.status);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;

  const deadLetters = await db
    .select()
    .from(evvSubmissionQueue)
    .where(and(eq(evvSubmissionQueue.tenantId, tenantId), eq(evvSubmissionQueue.status, 'dead_letter')))
    .limit(50);

  return { counts, deadLetters };
}
