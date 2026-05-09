import { Hono } from 'hono';
import { and, eq, desc, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { scheduleDays, schedules, scheduleVisits } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);

function tenantId(c: { get: (k: string) => unknown }) {
  return c.get('tenantId') as string;
}

// GET /api/schedules
r.get('/', async (c) => {
  const tid = tenantId(c);
  const rows = await db.select().from(schedules).where(eq(schedules.tenantId, tid)).orderBy(desc(schedules.createdAt));
  return c.json({
    schedules: rows.map((s) => ({
      id: s.id,
      weekStartDate: s.weekStartDate,
      isCurrent: s.isCurrent,
      isSaved: s.isSaved,
      savedName: s.savedName,
      savedAt: s.savedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
  });
});

// GET /api/schedules/current
r.get('/current', async (c) => {
  const tid = tenantId(c);
  const rows = await db.select().from(schedules).where(and(eq(schedules.tenantId, tid), eq(schedules.isCurrent, true))).limit(1);
  const s = rows[0];
  if (!s) return c.json({ schedule: null });
  const full = await loadScheduleDetail(s.id);
  return c.json({ schedule: full });
});

// GET /api/schedules/:id
r.get('/:id', async (c) => {
  const tid = tenantId(c);
  const id = c.req.param('id');
  const rows = await db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.tenantId, tid))).limit(1);
  const s = rows[0];
  if (!s) return c.json({ error: 'Not found' }, 404);
  const full = await loadScheduleDetail(s.id);
  return c.json(full);
});

// POST /api/schedules
r.post('/', async (c) => {
  const tid = tenantId(c);
  const body = await c.req.json().catch(() => null);
  if (!body?.weekSchedule) return c.json({ error: 'Expected weekSchedule' }, 400);
  const ws = body.weekSchedule;
  const makeCurrent = Boolean(body.isCurrent);
  const isSaved = Boolean(body.isSaved);
  const savedName = typeof body.savedName === 'string' ? body.savedName : null;

  if (makeCurrent) {
    await db.update(schedules).set({ isCurrent: false }).where(and(eq(schedules.tenantId, tid), eq(schedules.isCurrent, true)));
  }

  const [sch] = await db
    .insert(schedules)
    .values({
      tenantId: tid,
      weekStartDate: String(ws.weekStartDate),
      totalTravelMinutes: Number(ws.totalTravelMinutes ?? 0),
      totalTimeAwayMinutes: Number(ws.totalTimeAwayMinutes ?? 0),
      clientGroups: ws.clientGroups ?? null,
      unmetVisits: ws.unmetVisits ?? null,
      recommendedDrops: ws.recommendedDrops ?? null,
      isCurrent: makeCurrent,
      isSaved,
      savedName,
      savedAt: isSaved ? new Date() : null,
    })
    .returning();

  const days = Array.isArray(ws.days) ? ws.days : [];
  for (let di = 0; di < days.length; di++) {
    const d = days[di] as Record<string, unknown>;
    const [dayRow] = await db
      .insert(scheduleDays)
      .values({
        scheduleId: sch.id,
        day: String(d.day ?? ''),
        date: String(d.date ?? ''),
        totalTravelMinutes: Number(d.totalTravelMinutes ?? 0),
        leaveHomeTime: String(d.leaveHomeTime ?? ''),
        arriveHomeTime: String(d.arriveHomeTime ?? ''),
      })
      .returning();

    const visits = Array.isArray(d.visits) ? d.visits : [];
    let si = 0;
    for (const v of visits as Record<string, unknown>[]) {
      await db.insert(scheduleVisits).values({
        scheduleDayId: dayRow.id,
        clientId: String(v.clientId),
        startTime: String(v.startTime ?? ''),
        endTime: String(v.endTime ?? ''),
        travelTimeFromPrev: Number(v.travelTimeFromPrev ?? 0),
        travelDistanceMiFromPrev:
          typeof v.travelDistanceMiFromPrev === 'number' ? v.travelDistanceMiFromPrev : null,
        manuallyPlaced: Boolean(v.manuallyPlaced),
        sortOrder: si++,
      });
    }
  }

  const full = await loadScheduleDetail(sch.id);
  return c.json(full, 201);
});

// PUT /api/schedules/:id
r.put('/:id', async (c) => {
  const tid = tenantId(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body?.weekSchedule) return c.json({ error: 'Expected weekSchedule' }, 400);

  const rows = await db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.tenantId, tid))).limit(1);
  const existing = rows[0];
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const ws = body.weekSchedule;
  const makeCurrent = Boolean(body.isCurrent);
  const isSaved = typeof body.isSaved === 'boolean' ? body.isSaved : existing.isSaved;
  const savedName = typeof body.savedName === 'string' ? body.savedName : existing.savedName;

  if (makeCurrent) {
    await db.update(schedules).set({ isCurrent: false }).where(and(eq(schedules.tenantId, tid), eq(schedules.isCurrent, true)));
  }

  await db
    .update(schedules)
    .set({
      weekStartDate: String(ws.weekStartDate),
      totalTravelMinutes: Number(ws.totalTravelMinutes ?? 0),
      totalTimeAwayMinutes: Number(ws.totalTimeAwayMinutes ?? 0),
      clientGroups: ws.clientGroups ?? null,
      unmetVisits: ws.unmetVisits ?? null,
      recommendedDrops: ws.recommendedDrops ?? null,
      isCurrent: makeCurrent || existing.isCurrent,
      isSaved,
      savedName,
      savedAt: isSaved ? new Date() : existing.savedAt,
    })
    .where(eq(schedules.id, id));

  const dayRows = await db.select({ id: scheduleDays.id }).from(scheduleDays).where(eq(scheduleDays.scheduleId, id));
  for (const dr of dayRows) {
    await db.delete(scheduleVisits).where(eq(scheduleVisits.scheduleDayId, dr.id));
  }
  await db.delete(scheduleDays).where(eq(scheduleDays.scheduleId, id));

  const days = Array.isArray(ws.days) ? ws.days : [];
  for (const d of days as Record<string, unknown>[]) {
    const [dayRow] = await db
      .insert(scheduleDays)
      .values({
        scheduleId: id,
        day: String(d.day ?? ''),
        date: String(d.date ?? ''),
        totalTravelMinutes: Number(d.totalTravelMinutes ?? 0),
        leaveHomeTime: String(d.leaveHomeTime ?? ''),
        arriveHomeTime: String(d.arriveHomeTime ?? ''),
      })
      .returning();

    const visits = Array.isArray(d.visits) ? d.visits : [];
    let si = 0;
    for (const v of visits as Record<string, unknown>[]) {
      await db.insert(scheduleVisits).values({
        scheduleDayId: dayRow.id,
        clientId: String(v.clientId),
        startTime: String(v.startTime ?? ''),
        endTime: String(v.endTime ?? ''),
        travelTimeFromPrev: Number(v.travelTimeFromPrev ?? 0),
        travelDistanceMiFromPrev:
          typeof v.travelDistanceMiFromPrev === 'number' ? v.travelDistanceMiFromPrev : null,
        manuallyPlaced: Boolean(v.manuallyPlaced),
        sortOrder: si++,
      });
    }
  }

  const full = await loadScheduleDetail(id);
  return c.json(full);
});

// POST /api/schedules/:id/activate — mark as current
r.post('/:id/activate', async (c) => {
  const tid = tenantId(c);
  const id = c.req.param('id');
  const rows = await db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.tenantId, tid))).limit(1);
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);

  await db.update(schedules).set({ isCurrent: false }).where(and(eq(schedules.tenantId, tid), eq(schedules.isCurrent, true)));
  await db.update(schedules).set({ isCurrent: true }).where(eq(schedules.id, id));

  const full = await loadScheduleDetail(id);
  return c.json(full);
});

// DELETE /api/schedules/:id
r.delete('/:id', async (c) => {
  const tid = tenantId(c);
  const id = c.req.param('id');
  const rows = await db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.tenantId, tid))).limit(1);
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  await db.delete(schedules).where(eq(schedules.id, id));
  return c.json({ success: true });
});

async function loadScheduleDetail(scheduleId: string) {
  const sch = (await db.select().from(schedules).where(eq(schedules.id, scheduleId)).limit(1))[0]!;
  const days = await db.select().from(scheduleDays).where(eq(scheduleDays.scheduleId, scheduleId));
  const outDays = [];
  for (const d of days) {
    const visits = await db
      .select()
      .from(scheduleVisits)
      .where(eq(scheduleVisits.scheduleDayId, d.id))
      .orderBy(asc(scheduleVisits.sortOrder));
    outDays.push({
      day: d.day,
      date: d.date,
      totalTravelMinutes: d.totalTravelMinutes,
      leaveHomeTime: d.leaveHomeTime,
      arriveHomeTime: d.arriveHomeTime,
      visits: visits.map((v) => ({
        clientId: v.clientId,
        startTime: v.startTime,
        endTime: v.endTime,
        travelTimeFromPrev: v.travelTimeFromPrev,
        travelDistanceMiFromPrev: v.travelDistanceMiFromPrev ?? undefined,
        manuallyPlaced: v.manuallyPlaced,
      })),
    });
  }

  return {
    id: sch.id,
    weekSchedule: {
      weekStartDate: sch.weekStartDate,
      days: outDays,
      totalTravelMinutes: sch.totalTravelMinutes,
      totalTimeAwayMinutes: sch.totalTimeAwayMinutes,
      clientGroups: sch.clientGroups ?? undefined,
      unmetVisits: sch.unmetVisits ?? undefined,
      recommendedDrops: sch.recommendedDrops ?? undefined,
    },
    isCurrent: sch.isCurrent,
    isSaved: sch.isSaved,
    savedName: sch.savedName,
    savedAt: sch.savedAt?.toISOString() ?? null,
    createdAt: sch.createdAt.toISOString(),
  };
}

export { r as schedulesRouter };
