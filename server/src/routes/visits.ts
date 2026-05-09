import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { domainEvents, scheduleVisits, scheduleDays, schedules, tenantDomainChain } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';
import { hashIp } from '../services/ipHash';
import { notifyDomainEventAppend } from '../services/tenantEventSse';

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

async function assertVisitInTenant(visitId: string, tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ tid: schedules.tenantId })
    .from(scheduleVisits)
    .innerJoin(scheduleDays, eq(scheduleVisits.scheduleDayId, scheduleDays.id))
    .innerJoin(schedules, eq(scheduleDays.scheduleId, schedules.id))
    .where(eq(scheduleVisits.id, visitId))
    .limit(1);
  return rows[0]?.tid === tenantId;
}

async function appendVisitEvent(params: {
  tenantId: string;
  userId: string;
  kind: string;
  payload: Record<string, unknown>;
  ipHash: string | null;
}) {
  const { tenantId, userId, kind, payload, ipHash } = params;
  const clientEventId = crypto.randomUUID();
  const claimedAt = new Date();
  let seqOut = 0;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT tenant_id FROM tenant_domain_chain WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`);
    const chainRows = await tx.select().from(tenantDomainChain).where(eq(tenantDomainChain.tenantId, tenantId));
    let head = chainRows[0];
    if (!head) {
      await tx.insert(tenantDomainChain).values({ tenantId, headSeq: 0 });
      head = { tenantId, headSeq: 0 };
    }
    const newSeq = head.headSeq + 1;
    await tx.insert(domainEvents).values({
      tenantId,
      authorUserId: userId,
      clientEventId,
      seq: newSeq,
      kind,
      payload,
      clientClaimedAt: claimedAt,
      serverReceivedAt: new Date(),
      ipHash,
      isClinical: false,
    });
    await tx.update(tenantDomainChain).set({ headSeq: newSeq }).where(eq(tenantDomainChain.tenantId, tenantId));
    seqOut = newSeq;
  });

  notifyDomainEventAppend(tenantId, seqOut);
}

r.post('/:id/start', async (c) => {
  const tenantId = c.get('tenantId') as string;
  const userId = c.get('userId') as string;
  const id = c.req.param('id');
  if (!(await assertVisitInTenant(id, tenantId))) return c.json({ error: 'Not found' }, 404);

  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  await appendVisitEvent({
    tenantId,
    userId,
    kind: 'visit_started',
    payload: { scheduleVisitId: id },
    ipHash,
  });
  return c.json({ success: true });
});

r.post('/:id/complete', async (c) => {
  const tenantId = c.get('tenantId') as string;
  const userId = c.get('userId') as string;
  const id = c.req.param('id');
  if (!(await assertVisitInTenant(id, tenantId))) return c.json({ error: 'Not found' }, 404);

  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  await appendVisitEvent({
    tenantId,
    userId,
    kind: 'visit_completed',
    payload: { scheduleVisitId: id },
    ipHash,
  });
  return c.json({ success: true });
});

r.post('/:id/note', async (c) => {
  const tenantId = c.get('tenantId') as string;
  const userId = c.get('userId') as string;
  const id = c.req.param('id');
  if (!(await assertVisitInTenant(id, tenantId))) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const note = typeof body?.note === 'string' ? body.note : '';
  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  await appendVisitEvent({
    tenantId,
    userId,
    kind: 'visit_note',
    payload: { scheduleVisitId: id, note },
    ipHash,
  });
  return c.json({ success: true });
});

export { r as visitsRouter };
