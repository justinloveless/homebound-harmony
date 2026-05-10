import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { clientTimeWindows, clients } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';
import { appendDomainEventBestEffort } from '../services/appendDomainEvent';
import { hashIp } from '../services/ipHash';

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);

function tenantId(c: { get: (k: string) => unknown }) {
  return c.get('tenantId') as string;
}

function sessionUserId(c: { get: (k: string) => unknown }) {
  return c.get('userId') as string;
}

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? 'unknown'
  );
}

async function loadWindowsForClients(clientIds: string[]) {
  if (clientIds.length === 0) return new Map<string, typeof clientTimeWindows.$inferSelect[]>();
  const rows = await db.select().from(clientTimeWindows).where(inArray(clientTimeWindows.clientId, clientIds));
  const m = new Map<string, typeof clientTimeWindows.$inferSelect[]>();
  for (const row of rows) {
    const list = m.get(row.clientId) ?? [];
    list.push(row);
    m.set(row.clientId, list);
  }
  return m;
}

function serializeClient(
  cl: typeof clients.$inferSelect,
  windows: { day: string; startTime: string; endTime: string }[],
) {
  const sortedWindows = [...windows].sort((a, b) => {
    const day = a.day.localeCompare(b.day);
    if (day !== 0) return day;
    const start = a.startTime.localeCompare(b.startTime);
    if (start !== 0) return start;
    return a.endTime.localeCompare(b.endTime);
  });

  return {
    id: cl.id,
    name: cl.name,
    address: cl.address,
    coords: cl.lat != null && cl.lon != null ? { lat: cl.lat, lon: cl.lon } : undefined,
    visitDurationMinutes: cl.visitDurationMinutes,
    visitsPerPeriod: cl.visitsPerPeriod,
    period: cl.period,
    priority: cl.priority,
    timeWindows: sortedWindows.map((w) => ({ day: w.day, startTime: w.startTime, endTime: w.endTime })),
    notes: cl.notes,
    excludedFromSchedule: cl.excludedFromSchedule,
  };
}

/** Minimal RFC 4180-style CSV (quoted fields, escaped quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field.trim());
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      if (text[i] === '\n') i++;
      row.push(field.trim());
      field = '';
      if (row.some((x) => x.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    if (c === '\n') {
      row.push(field.trim());
      field = '';
      if (row.some((x) => x.length > 0)) rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field.trim());
  if (row.some((x) => x.length > 0)) rows.push(row);
  return rows;
}

function tenantRole(c: { get: (k: string) => unknown }) {
  return c.get('tenantRole') as 'admin' | 'caregiver';
}

// GET /api/clients
r.get('/', async (c) => {
  const tid = tenantId(c);
  const rows = await db.select().from(clients).where(eq(clients.tenantId, tid));
  const ids = rows.map((x) => x.id);
  const wm = await loadWindowsForClients(ids);
  return c.json({
    clients: rows.map((cl) =>
      serializeClient(
        cl,
        (wm.get(cl.id) ?? []).map((w) => ({ day: w.day, startTime: w.startTime, endTime: w.endTime })),
      ),
    ),
  });
});

// POST /api/clients/import — admin-only; JSON `{ csv }`. Header row must include `name`;
// optional: address, visitDurationMinutes, visitsPerPeriod, period, priority, notes, excludedFromSchedule.
r.post('/import', async (c) => {
  if (tenantRole(c) !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  const tid = tenantId(c);
  const body = await c.req.json().catch(() => null);
  const csvText = typeof body?.csv === 'string' ? body.csv : '';
  if (!csvText.trim()) return c.json({ error: 'Expected { csv: string }' }, 400);

  const table = parseCsv(csvText.trim());
  if (table.length < 2) {
    return c.json({ error: 'CSV must include a header row and at least one data row' }, 400);
  }

  const headers = table[0]!.map((h) => h.trim().toLowerCase());
  const col = (name: string) => headers.indexOf(name);
  const nameIdx = col('name');
  if (nameIdx < 0) return c.json({ error: 'CSV must include a "name" column' }, 400);

  const addrIdx = col('address');
  const durIdx = col('visitdurationminutes');
  const vppIdx = col('visitsperperiod');
  const periodIdx = col('period');
  const priIdx = col('priority');
  const notesIdx = col('notes');
  const exclIdx = col('excludedfromschedule');

  const insertedIds: string[] = [];

  try {
    await db.transaction(async (tx) => {
      for (let r = 1; r < table.length; r++) {
        const cells = table[r]!;
        const name = (cells[nameIdx] ?? '').trim();
        if (!name) continue;

        const address = addrIdx >= 0 ? String(cells[addrIdx] ?? '') : '';
        const visitDurationMinutes = durIdx >= 0 ? Number(cells[durIdx] || 60) : 60;
        const visitsPerPeriod = vppIdx >= 0 ? Number(cells[vppIdx] || 1) : 1;
        const period = periodIdx >= 0 ? String(cells[periodIdx] || 'week') : 'week';
        const priority = priIdx >= 0 ? String(cells[priIdx] || 'medium') : 'medium';
        const notes = notesIdx >= 0 ? String(cells[notesIdx] ?? '') : '';
        let excluded = false;
        if (exclIdx >= 0) {
          const raw = String(cells[exclIdx] ?? '').trim().toLowerCase();
          excluded = raw === 'true' || raw === '1' || raw === 'yes';
        }

        if (!Number.isFinite(visitDurationMinutes) || visitDurationMinutes < 1) {
          throw Object.assign(new Error('bad_numeric'), { field: 'visitDurationMinutes', row: r + 1 });
        }
        if (!Number.isFinite(visitsPerPeriod) || visitsPerPeriod < 1) {
          throw Object.assign(new Error('bad_numeric'), { field: 'visitsPerPeriod', row: r + 1 });
        }

        const [inserted] = await tx
          .insert(clients)
          .values({
            tenantId: tid,
            name,
            address,
            lat: null,
            lon: null,
            visitDurationMinutes: Math.floor(visitDurationMinutes),
            visitsPerPeriod: Math.floor(visitsPerPeriod),
            period,
            priority,
            notes,
            excludedFromSchedule: excluded,
          })
          .returning();
        insertedIds.push(inserted!.id);
      }
    });
  } catch (e: unknown) {
    const err = e as { message?: string; field?: string; row?: number };
    if (err?.message === 'bad_numeric') {
      return c.json(
        { error: `Invalid ${err.field ?? 'number'} in CSV (row ${err.row ?? '?'})` },
        400,
      );
    }
    console.error('POST /api/clients/import', e);
    return c.json({ error: 'Import failed' }, 500);
  }

  const userId = sessionUserId(c);
  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  if (insertedIds.length > 0) {
    const importedRows = await db
      .select()
      .from(clients)
      .where(and(eq(clients.tenantId, tid), inArray(clients.id, insertedIds)));
    const wm = await loadWindowsForClients(insertedIds);
    for (const cl of importedRows) {
      const serialized = serializeClient(
        cl,
        (wm.get(cl.id) ?? []).map((w) => ({ day: w.day, startTime: w.startTime, endTime: w.endTime })),
      ) as unknown as Record<string, unknown>;
      const hasCoords = cl.lat != null && cl.lon != null;
      await appendDomainEventBestEffort({
        tenantId: tid,
        authorUserId: userId,
        kind: 'client_added',
        payload: serialized,
        ipHash,
        isClinical: hasCoords,
        gpsLat: cl.lat,
        gpsLon: cl.lon,
        gpsCapturedAt: hasCoords ? new Date() : null,
      });
    }
  }

  return c.json({ imported: insertedIds.length, ids: insertedIds });
});

// GET /api/clients/:id
r.get('/:id', async (c) => {
  const tid = tenantId(c);
  const id = c.req.param('id');
  const rows = await db.select().from(clients).where(and(eq(clients.id, id), eq(clients.tenantId, tid))).limit(1);
  const cl = rows[0];
  if (!cl) return c.json({ error: 'Not found' }, 404);
  const wm = await loadWindowsForClients([cl.id]);
  return c.json(serializeClient(cl, (wm.get(cl.id) ?? []).map((w) => ({ day: w.day, startTime: w.startTime, endTime: w.endTime }))));
});

// POST /api/clients
r.post('/', async (c) => {
  const tid = tenantId(c);
  const userId = sessionUserId(c);
  const body = await c.req.json().catch(() => null);
  if (!body?.name && body?.name !== '') return c.json({ error: 'Missing name' }, 400);

  const [inserted] = await db
    .insert(clients)
    .values({
      tenantId: tid,
      name: String(body.name ?? ''),
      address: String(body.address ?? ''),
      lat: body.coords?.lat ?? null,
      lon: body.coords?.lon ?? null,
      visitDurationMinutes: Number(body.visitDurationMinutes ?? 60),
      visitsPerPeriod: Number(body.visitsPerPeriod ?? 1),
      period: String(body.period ?? 'week'),
      priority: String(body.priority ?? 'medium'),
      notes: String(body.notes ?? ''),
      excludedFromSchedule: Boolean(body.excludedFromSchedule),
    })
    .returning();

  const tws = Array.isArray(body.timeWindows) ? body.timeWindows : [];
  for (const tw of tws as { day?: string; startTime?: string; endTime?: string }[]) {
    if (!tw?.day || !tw?.startTime || !tw?.endTime) continue;
    await db.insert(clientTimeWindows).values({
      clientId: inserted.id,
      day: tw.day,
      startTime: tw.startTime,
      endTime: tw.endTime,
    });
  }

  const wm = await loadWindowsForClients([inserted.id]);
  const serialized = serializeClient(
    inserted,
    (wm.get(inserted.id) ?? []).map((w) => ({ day: w.day, startTime: w.startTime, endTime: w.endTime })),
  ) as unknown as Record<string, unknown>;
  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  const hasCoords = inserted.lat != null && inserted.lon != null;
  await appendDomainEventBestEffort({
    tenantId: tid,
    authorUserId: userId,
    kind: 'client_added',
    payload: serialized,
    ipHash,
    isClinical: hasCoords,
    gpsLat: inserted.lat,
    gpsLon: inserted.lon,
    gpsCapturedAt: hasCoords ? new Date() : null,
  });
  return c.json(serialized, 201);
});

// PUT /api/clients/:id
r.put('/:id', async (c) => {
  const tid = tenantId(c);
  const userId = sessionUserId(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);

  const rows = await db.select().from(clients).where(and(eq(clients.id, id), eq(clients.tenantId, tid))).limit(1);
  const cl = rows[0];
  if (!cl) return c.json({ error: 'Not found' }, 404);

  await db
    .update(clients)
    .set({
      name: typeof body.name === 'string' ? body.name : cl.name,
      address: typeof body.address === 'string' ? body.address : cl.address,
      lat: body.coords?.lat ?? cl.lat,
      lon: body.coords?.lon ?? cl.lon,
      visitDurationMinutes: Number(body.visitDurationMinutes ?? cl.visitDurationMinutes),
      visitsPerPeriod: Number(body.visitsPerPeriod ?? cl.visitsPerPeriod),
      period: typeof body.period === 'string' ? body.period : cl.period,
      priority: typeof body.priority === 'string' ? body.priority : cl.priority,
      notes: typeof body.notes === 'string' ? body.notes : cl.notes,
      excludedFromSchedule:
        typeof body.excludedFromSchedule === 'boolean' ? body.excludedFromSchedule : cl.excludedFromSchedule,
      updatedAt: new Date(),
    })
    .where(eq(clients.id, id));

  if (Array.isArray(body.timeWindows)) {
    await db.delete(clientTimeWindows).where(eq(clientTimeWindows.clientId, id));
    for (const tw of body.timeWindows as { day?: string; startTime?: string; endTime?: string }[]) {
      if (!tw?.day || !tw?.startTime || !tw?.endTime) continue;
      await db.insert(clientTimeWindows).values({
        clientId: id,
        day: tw.day,
        startTime: tw.startTime,
        endTime: tw.endTime,
      });
    }
  }

  const updated = (await db.select().from(clients).where(eq(clients.id, id)).limit(1))[0]!;
  const wm = await loadWindowsForClients([id]);
  const serialized = serializeClient(updated, (wm.get(id) ?? []).map((w) => ({ day: w.day, startTime: w.startTime, endTime: w.endTime })));
  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  const hasCoords = updated.lat != null && updated.lon != null;
  await appendDomainEventBestEffort({
    tenantId: tid,
    authorUserId: userId,
    kind: 'client_updated',
    payload: serialized as unknown as Record<string, unknown>,
    ipHash,
    isClinical: hasCoords,
    gpsLat: updated.lat,
    gpsLon: updated.lon,
    gpsCapturedAt: hasCoords ? new Date() : null,
  });
  return c.json(serialized);
});

// DELETE /api/clients/:id
r.delete('/:id', async (c) => {
  const tid = tenantId(c);
  const userId = sessionUserId(c);
  const id = c.req.param('id');
  const rows = await db.select().from(clients).where(and(eq(clients.id, id), eq(clients.tenantId, tid))).limit(1);
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  await db.delete(clients).where(eq(clients.id, id));
  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  await appendDomainEventBestEffort({
    tenantId: tid,
    authorUserId: userId,
    kind: 'client_removed',
    payload: { id },
    ipHash,
    isClinical: false,
  });
  return c.json({ success: true });
});

export { r as clientsRouter };
