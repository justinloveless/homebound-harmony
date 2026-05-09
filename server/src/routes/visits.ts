import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { scheduleVisits, scheduleDays, schedules } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';
import { hashIp } from '../services/ipHash';
import { appendDomainEventBestEffort } from '../services/appendDomainEvent';

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

r.post('/:id/start', async (c) => {
  const tenantId = c.get('tenantId') as string;
  const userId = c.get('userId') as string;
  const id = c.req.param('id');
  if (!(await assertVisitInTenant(id, tenantId))) return c.json({ error: 'Not found' }, 404);

  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  await appendDomainEventBestEffort({
    tenantId,
    authorUserId: userId,
    kind: 'visit_started',
    payload: { scheduleVisitId: id },
    ipHash,
    isClinical: false,
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
  await appendDomainEventBestEffort({
    tenantId,
    authorUserId: userId,
    kind: 'visit_completed',
    payload: { scheduleVisitId: id },
    ipHash,
    isClinical: false,
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
  await appendDomainEventBestEffort({
    tenantId,
    authorUserId: userId,
    kind: 'visit_note',
    payload: { scheduleVisitId: id, note },
    ipHash,
    isClinical: false,
  });
  return c.json({ success: true });
});

export { r as visitsRouter };
