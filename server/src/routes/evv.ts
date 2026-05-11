import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { evvVisits, clients } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';
import { requireRole } from '../auth/rbac';
import { hashIp } from '../services/ipHash';
import { appendDomainEvent } from '../services/appendDomainEvent';
import {
  checkIn,
  checkOut,
  getActiveVisit,
  getVisit,
  cancelVisit,
  getWorkerIdForUser,
} from '../services/evvVisitService';
import {
  getNotesForVisit,
  upsertDraftNote,
  signNote,
} from '../services/visitNoteService';
import { getPipelineStatus, retryDeadLetters } from '../services/evvSubmissionWorker';

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

r.post('/check-in', async (c) => {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');

  const body = await c.req.json().catch(() => null);
  if (!body?.clientId) return c.json({ error: 'clientId required' }, 400);

  const workerId = await getWorkerIdForUser(tenantId, userId);
  if (!workerId) return c.json({ error: 'No worker profile found' }, 400);

  const gps = body.gps;
  if (!gps?.lat || !gps?.lon) return c.json({ error: 'GPS data required' }, 400);

  try {
    const result = await checkIn({
      tenantId,
      workerId,
      clientId: body.clientId,
      scheduleVisitId: body.scheduleVisitId,
      verificationMethod: body.verificationMethod ?? 'gps',
      lat: gps.lat,
      lon: gps.lon,
      accuracyM: gps.accuracyM ?? 0,
      serviceCode: body.serviceCode,
    });

    const ip = getClientIp(c);
    const ipHash = ip !== 'unknown' ? await hashIp(ip) : null;
    await appendDomainEvent({
      tenantId,
      authorUserId: userId,
      kind: 'evv_check_in',
      payload: {
        evvVisitId: result.id,
        clientId: body.clientId,
        scheduleVisitId: body.scheduleVisitId,
        verificationMethod: body.verificationMethod ?? 'gps',
        dayDate: body.dayDate ?? null,
        visitIndex: body.visitIndex ?? null,
      },
      ipHash,
      isClinical: true,
      gpsLat: gps.lat,
      gpsLon: gps.lon,
      gpsAccuracyM: gps.accuracyM,
      gpsCapturedAt: gps.capturedAt ? new Date(gps.capturedAt) : new Date(),
      gpsStaleSeconds: gps.staleSeconds ?? null,
    });

    return c.json({ id: result.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Check-in failed';
    return c.json({ error: msg }, 409);
  }
});

r.post('/:visitId/check-out', async (c) => {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const visitId = c.req.param('visitId');

  const body = await c.req.json().catch(() => null);
  const gps = body?.gps;
  if (!gps?.lat || !gps?.lon) return c.json({ error: 'GPS data required' }, 400);

  try {
    const result = await checkOut({
      tenantId,
      evvVisitId: visitId,
      lat: gps.lat,
      lon: gps.lon,
      accuracyM: gps.accuracyM ?? 0,
    });

    const ip = getClientIp(c);
    const ipHash = ip !== 'unknown' ? await hashIp(ip) : null;
    await appendDomainEvent({
      tenantId,
      authorUserId: userId,
      kind: 'evv_check_out',
      payload: {
        evvVisitId: visitId,
        clientId: (await getVisit(tenantId, visitId))?.clientId ?? '',
        durationMinutes: result.durationMinutes,
        billableUnits: result.billableUnits,
        dayDate: body?.dayDate ?? null,
        visitIndex: body?.visitIndex ?? null,
      },
      ipHash,
      isClinical: true,
      gpsLat: gps.lat,
      gpsLon: gps.lon,
      gpsAccuracyM: gps.accuracyM,
      gpsCapturedAt: gps.capturedAt ? new Date(gps.capturedAt) : new Date(),
      gpsStaleSeconds: gps.staleSeconds ?? null,
    });

    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Check-out failed';
    return c.json({ error: msg }, 409);
  }
});

r.get('/active', async (c) => {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');

  const workerId = await getWorkerIdForUser(tenantId, userId);
  if (!workerId) return c.json({ visit: null });

  const visit = await getActiveVisit(tenantId, workerId);
  if (!visit) return c.json({ visit: null });

  const clientRows = await db
    .select({ name: clients.name, address: clients.address })
    .from(clients)
    .where(eq(clients.id, visit.clientId))
    .limit(1);

  return c.json({
    visit: {
      ...visit,
      clientName: clientRows[0]?.name ?? '',
      clientAddress: clientRows[0]?.address ?? '',
    },
  });
});

r.get('/visits', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const offset = Number(c.req.query('offset') ?? 0);

  const rows = await db
    .select()
    .from(evvVisits)
    .where(eq(evvVisits.tenantId, tenantId))
    .orderBy(desc(evvVisits.checkInAt))
    .limit(limit)
    .offset(offset);

  return c.json({ visits: rows });
});

r.get('/visits/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const visitId = c.req.param('id');

  const visit = await getVisit(tenantId, visitId);
  if (!visit) return c.json({ error: 'Not found' }, 404);

  const clientRows = await db
    .select({ name: clients.name, address: clients.address })
    .from(clients)
    .where(eq(clients.id, visit.clientId))
    .limit(1);

  return c.json({
    visit: {
      ...visit,
      clientName: clientRows[0]?.name ?? '',
      clientAddress: clientRows[0]?.address ?? '',
    },
  });
});

r.post('/visits/:id/cancel', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const visitId = c.req.param('id');

  const visit = await getVisit(tenantId, visitId);
  if (!visit) return c.json({ error: 'Not found' }, 404);
  if (visit.visitStatus !== 'in_progress') {
    return c.json({ error: 'Can only cancel in-progress visits' }, 400);
  }

  await cancelVisit(tenantId, visitId);
  return c.json({ success: true });
});

r.get('/:visitId/notes', async (c) => {
  const tenantId = c.get('tenantId');
  const visitId = c.req.param('visitId');
  try {
    const notes = await getNotesForVisit(tenantId, visitId);
    return c.json({ notes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Not found';
    return c.json({ error: msg }, 404);
  }
});

r.post('/:visitId/notes', async (c) => {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const visitId = c.req.param('visitId');

  const body = await c.req.json().catch(() => ({}));
  try {
    const note = await upsertDraftNote(tenantId, visitId, userId, {
      tasksCompleted: body.tasksCompleted,
      freeText: body.freeText,
    });
    return c.json({ note });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed';
    return c.json({ error: msg }, 400);
  }
});

r.post('/:visitId/notes/:noteId/sign', async (c) => {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const visitId = c.req.param('visitId');
  const noteId = c.req.param('noteId');

  const body = await c.req.json().catch(() => null);
  if (!body?.signature) return c.json({ error: 'signature required' }, 400);

  try {
    const signed = await signNote(tenantId, noteId, visitId, body.signature);

    const ip = getClientIp(c);
    const ipHash = ip !== 'unknown' ? await hashIp(ip) : null;
    const gps = body.gps;
    const signedAt = signed.signedAt?.toISOString() ?? new Date().toISOString();

    await appendDomainEvent({
      tenantId,
      authorUserId: userId,
      kind: 'visit_note_submitted',
      payload: { evvVisitId: visitId, noteId, version: signed.version },
      ipHash,
      isClinical: false,
    });

    await appendDomainEvent({
      tenantId,
      authorUserId: userId,
      kind: 'visit_note_signed',
      payload: { evvVisitId: visitId, noteId, signedAt },
      ipHash,
      isClinical: true,
      gpsLat: gps?.lat ?? null,
      gpsLon: gps?.lon ?? null,
      gpsAccuracyM: gps?.accuracyM ?? null,
      gpsCapturedAt: gps?.capturedAt ? new Date(gps.capturedAt) : null,
      gpsStaleSeconds: gps?.staleSeconds ?? null,
    });

    return c.json({ note: signed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sign failed';
    return c.json({ error: msg }, 400);
  }
});

r.get('/admin/pipeline', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const status = await getPipelineStatus(tenantId);
  return c.json(status);
});

r.post('/admin/retry', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId');
  const body = await c.req.json().catch(() => ({}));
  const ids: string[] | undefined = Array.isArray(body?.ids) ? body.ids : undefined;
  const count = await retryDeadLetters(tenantId, ids);
  return c.json({ retried: count });
});

export { r as evvRouter };
