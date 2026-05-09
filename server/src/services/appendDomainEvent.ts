import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { domainEvents, tenantDomainChain } from '../db/schema';
import { notifyDomainEventAppend } from './tenantEventSse';

export interface AppendDomainEventInput {
  tenantId: string;
  authorUserId: string;
  kind: string;
  payload: Record<string, unknown>;
  ipHash: string | null;
  isClinical?: boolean;
  gpsLat?: number | null;
  gpsLon?: number | null;
  gpsAccuracyM?: number | null;
  gpsCapturedAt?: Date | null;
  gpsStaleSeconds?: number | null;
}

/**
 * Appends one row to `domain_events` (same contract as POST /api/events) and bumps the tenant chain.
 * Used when the web app mutates data via REST so the admin audit trail stays populated.
 */
export async function appendDomainEvent(input: AppendDomainEventInput): Promise<{ seq: number }> {
  let isClinical = input.isClinical ?? false;
  if (isClinical && (input.gpsLat == null || input.gpsLon == null)) {
    isClinical = false;
  }
  const clientEventId = `srv:${crypto.randomUUID()}`;
  const claimedAt = new Date();
  let seqOut = 0;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT tenant_id FROM tenant_domain_chain WHERE tenant_id = ${input.tenantId}::uuid FOR UPDATE`,
    );
    const chainRows = await tx.select().from(tenantDomainChain).where(eq(tenantDomainChain.tenantId, input.tenantId));
    let head = chainRows[0];
    if (!head) {
      await tx.insert(tenantDomainChain).values({ tenantId: input.tenantId, headSeq: 0 });
      head = { tenantId: input.tenantId, headSeq: 0 };
    }
    const newSeq = head.headSeq + 1;
    await tx.insert(domainEvents).values({
      tenantId: input.tenantId,
      authorUserId: input.authorUserId,
      clientEventId,
      seq: newSeq,
      kind: input.kind,
      payload: input.payload,
      clientClaimedAt: claimedAt,
      serverReceivedAt: new Date(),
      ipHash: input.ipHash,
      gpsLat: input.gpsLat ?? null,
      gpsLon: input.gpsLon ?? null,
      gpsAccuracyM: input.gpsAccuracyM ?? null,
      gpsCapturedAt: input.gpsCapturedAt ?? null,
      gpsStaleSeconds: input.gpsStaleSeconds ?? null,
      isClinical,
    });
    await tx
      .update(tenantDomainChain)
      .set({ headSeq: newSeq })
      .where(eq(tenantDomainChain.tenantId, input.tenantId));
    seqOut = newSeq;
  });

  notifyDomainEventAppend(input.tenantId, seqOut);
  return { seq: seqOut };
}

/** Same as {@link appendDomainEvent}, but never throws (audit must not break primary API). */
export async function appendDomainEventBestEffort(input: AppendDomainEventInput): Promise<void> {
  try {
    await appendDomainEvent(input);
  } catch (e) {
    console.error('[appendDomainEvent]', input.kind, input.tenantId, e);
  }
}
