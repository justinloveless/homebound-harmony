import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { workerBreaks, workers } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';
import { appendDomainEventBestEffort } from '../services/appendDomainEvent';
import { hashIp } from '../services/ipHash';

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? 'unknown'
  );
}

function ctxTenant(c: { get: (k: string) => unknown }) {
  return {
    tenantId: c.get('tenantId') as string,
    userId: c.get('userId') as string,
    role: c.get('tenantRole') as 'admin' | 'caregiver',
  };
}

// GET /api/workers/me
r.get('/me', async (c) => {
  const { tenantId, userId } = ctxTenant(c);
  const rows = await db
    .select()
    .from(workers)
    .where(and(eq(workers.tenantId, tenantId), eq(workers.userId, userId)))
    .limit(1);
  const w = rows[0];
  if (!w) return c.json({ error: 'Worker profile not found' }, 404);

  const breaks = await db.select().from(workerBreaks).where(eq(workerBreaks.workerId, w.id));

  return c.json({
    id: w.id,
    ...serializeWorker(w, breaks),
  });
});

// GET /api/workers
r.get('/', async (c) => {
  const { tenantId } = ctxTenant(c);
  const rows = await db.select().from(workers).where(eq(workers.tenantId, tenantId));
  const out = [];
  for (const w of rows) {
    const breaks = await db.select().from(workerBreaks).where(eq(workerBreaks.workerId, w.id));
    out.push({ id: w.id, userId: w.userId, ...serializeWorker(w, breaks) });
  }
  return c.json({ workers: out });
});

// GET /api/workers/:id
r.get('/:id', async (c) => {
  const { tenantId, userId, role } = ctxTenant(c);
  const id = c.req.param('id');
  const rows = await db.select().from(workers).where(and(eq(workers.id, id), eq(workers.tenantId, tenantId))).limit(1);
  const w = rows[0];
  if (!w) return c.json({ error: 'Not found' }, 404);
  if (role !== 'admin' && w.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const breaks = await db.select().from(workerBreaks).where(eq(workerBreaks.workerId, w.id));
  return c.json({ id: w.id, userId: w.userId, ...serializeWorker(w, breaks) });
});

// PUT /api/workers/:id
r.put('/:id', async (c) => {
  const { tenantId, userId, role } = ctxTenant(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);

  const rows = await db.select().from(workers).where(and(eq(workers.id, id), eq(workers.tenantId, tenantId))).limit(1);
  const w = rows[0];
  if (!w) return c.json({ error: 'Not found' }, 404);
  if (role !== 'admin' && w.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const nextName = typeof body.name === 'string' ? body.name : w.name;
  const nextHome = typeof body.homeAddress === 'string' ? body.homeAddress : w.homeAddress;
  const nextLat = body.homeCoords?.lat ?? w.homeLat;
  const nextLon = body.homeCoords?.lon ?? w.homeLon;
  const ws = body.workingHours?.startTime ?? w.workStartTime;
  const we = body.workingHours?.endTime ?? w.workEndTime;
  const daysOff = Array.isArray(body.daysOff) ? body.daysOff : w.daysOff;
  const makeUpDays = Array.isArray(body.makeUpDays) ? body.makeUpDays : w.makeUpDays;
  const strat = typeof body.schedulingStrategy === 'string' ? body.schedulingStrategy : w.schedulingStrategy;

  await db
    .update(workers)
    .set({
      name: nextName,
      homeAddress: nextHome,
      homeLat: nextLat ?? null,
      homeLon: nextLon ?? null,
      workStartTime: ws,
      workEndTime: we,
      daysOff,
      makeUpDays,
      schedulingStrategy: strat,
      updatedAt: new Date(),
    })
    .where(eq(workers.id, id));

  await db.delete(workerBreaks).where(eq(workerBreaks.workerId, id));
  const br = Array.isArray(body.breaks) ? body.breaks : [];
  for (const b of br as { startTime?: string; endTime?: string; label?: string }[]) {
    if (!b?.startTime || !b?.endTime) continue;
    await db.insert(workerBreaks).values({
      workerId: id,
      startTime: b.startTime,
      endTime: b.endTime,
      label: typeof b.label === 'string' ? b.label : '',
    });
  }

  const breaks = await db.select().from(workerBreaks).where(eq(workerBreaks.workerId, id));
  const updated = (await db.select().from(workers).where(eq(workers.id, id)).limit(1))[0]!;
  const payload = serializeWorker(updated, breaks) as unknown as Record<string, unknown>;
  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  await appendDomainEventBestEffort({
    tenantId,
    authorUserId: userId,
    kind: 'worker_updated',
    payload,
    ipHash,
    isClinical: false,
  });
  return c.json({ id: updated.id, userId: updated.userId, ...serializeWorker(updated, breaks) });
});

function serializeWorker(
  w: typeof workers.$inferSelect,
  breaks: (typeof workerBreaks.$inferSelect)[],
) {
  return {
    name: w.name,
    homeAddress: w.homeAddress,
    homeCoords:
      w.homeLat != null && w.homeLon != null ? { lat: w.homeLat, lon: w.homeLon } : undefined,
    workingHours: { startTime: w.workStartTime, endTime: w.workEndTime },
    daysOff: w.daysOff ?? [],
    makeUpDays: w.makeUpDays ?? [],
    breaks: breaks.map((b) => ({ startTime: b.startTime, endTime: b.endTime, label: b.label })),
    schedulingStrategy: w.schedulingStrategy,
  };
}

export { r as workersRouter };
