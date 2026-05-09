import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { travelTimes } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);

function tid(c: { get: (k: string) => unknown }) {
  return c.get('tenantId') as string;
}

function normalizePair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

// GET /api/travel-times — matrix + errors records
r.get('/', async (c) => {
  const tenantId = tid(c);
  const rows = await db.select().from(travelTimes).where(eq(travelTimes.tenantId, tenantId));
  const matrix: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const row of rows) {
    const key = `${row.locationAId}|${row.locationBId}`;
    matrix[key] = row.minutes;
    if (row.error) errors[key] = row.error;
  }
  return c.json({ travelTimes: matrix, travelTimeErrors: errors });
});

// PUT /api/travel-times
r.put('/', async (c) => {
  const tenantId = tid(c);
  const body = await c.req.json().catch(() => null);
  const matrix = body?.travelTimes as Record<string, number> | undefined;
  const errMap = body?.travelTimeErrors as Record<string, string> | undefined;
  if (!matrix || typeof matrix !== 'object') return c.json({ error: 'Expected travelTimes object' }, 400);

  await db.delete(travelTimes).where(eq(travelTimes.tenantId, tenantId));

  for (const [key, minutes] of Object.entries(matrix)) {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) continue;
    const parts = key.split('|');
    if (parts.length !== 2) continue;
    const [a, b] = normalizePair(parts[0], parts[1]);
    await db.insert(travelTimes).values({
      tenantId,
      locationAId: a,
      locationBId: b,
      minutes: Math.round(minutes),
      error: errMap?.[key] ?? null,
    });
  }

  return c.json({ success: true });
});

export { r as travelTimesRouter };
