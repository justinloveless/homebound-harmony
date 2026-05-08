import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db/client';
import { dataEvents, userEventChain } from '../db/schema';
import { and, eq, gt, asc, sql } from 'drizzle-orm';
import { requireUser } from '../auth/middleware';
import { hashIp } from '../services/ipHash';
import { computeEventHash, type HashEnvelopeInput } from '../services/eventChain';
import { resolveWorkspace, resolveWorkspaceFromQuery, canPostEvents } from '../services/workspaceContext';

const sseEventConnections = new Map<string, Set<(msg: { seq: number; hash: string }) => void>>();

export function notifyEventAppend(workspaceId: string, seq: number, hash: string) {
  const conns = sseEventConnections.get(workspaceId);
  if (conns) for (const send of conns) send({ seq, hash });
}

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

const events = new Hono();
events.use('*', requireUser);

// POST /api/events
events.post('/', async (c) => {
  const sessionUserId = (c as any).get('userId') as string;
  const rw = await resolveWorkspace(c, sessionUserId);
  if (!rw) {
    return c.json({ error: 'Workspace not found; set X-Workspace-Id if you belong to several.' }, 404);
  }
  if (!canPostEvents(rw.role)) {
    return c.json({ error: 'Insufficient permission to append events' }, 403);
  }

  const workspaceId = rw.workspaceId;
  const body = await c.req.json().catch(() => null);
  if (!body?.events || !Array.isArray(body.events)) {
    return c.json({ error: 'Invalid request: expected { events: [...] }' }, 400);
  }

  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  const accepted: { clientEventId: string; seq: number; hash: string; serverReceivedAt: string }[] = [];

  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT workspace_id FROM user_event_chain WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`,
      );

      for (const raw of body.events as Record<string, unknown>[]) {
        const clientEventId = raw.clientEventId;
        const clientClaimedAt = raw.clientClaimedAt;
        const isClinical = Boolean(raw.isClinical);
        const ciphertext = raw.ciphertext;
        const iv = raw.iv;
        if (typeof clientEventId !== 'string' || !clientEventId) {
          throw Object.assign(new Error('bad_event'), { status: 400 });
        }
        if (typeof clientClaimedAt !== 'string') {
          throw Object.assign(new Error('bad_event'), { status: 400 });
        }
        if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
          throw Object.assign(new Error('bad_event'), { status: 400 });
        }

        const gpsLat = typeof raw.gpsLat === 'number' ? raw.gpsLat : raw.gpsLat === null ? null : undefined;
        const gpsLon = typeof raw.gpsLon === 'number' ? raw.gpsLon : raw.gpsLon === null ? null : undefined;
        const gpsAccuracyM = typeof raw.gpsAccuracyM === 'number' ? raw.gpsAccuracyM : null;
        const gpsCapturedAt = typeof raw.gpsCapturedAt === 'string' ? raw.gpsCapturedAt : null;
        const gpsStaleSeconds = typeof raw.gpsStaleSeconds === 'number' ? raw.gpsStaleSeconds : null;

        if (isClinical && (gpsLat == null || gpsLon == null)) {
          throw Object.assign(new Error('clinical_gps'), { status: 422 });
        }

        const existing = await tx
          .select()
          .from(dataEvents)
          .where(and(eq(dataEvents.workspaceId, workspaceId), eq(dataEvents.clientEventId, clientEventId)))
          .limit(1);

        if (existing.length > 0) {
          const row = existing[0];
          accepted.push({
            clientEventId: row.clientEventId,
            seq: row.seq,
            hash: row.hash,
            serverReceivedAt: row.serverReceivedAt.toISOString(),
          });
          continue;
        }

        const chainRows = await tx.select().from(userEventChain).where(eq(userEventChain.workspaceId, workspaceId));
        let head = chainRows[0];
        if (!head) {
          await tx.insert(userEventChain).values({ workspaceId, headSeq: 0, headHash: '' });
          head = { workspaceId, headSeq: 0, headHash: '' };
        }

        const newSeq = head.headSeq + 1;
        const prevHash = head.headHash;
        const serverReceivedAt = new Date();
        const serverIso = serverReceivedAt.toISOString();

        // Hash chain scope uses `userId` field name in JSON for backwards compatibility; value is workspace id.
        const envelope: HashEnvelopeInput = {
          userId: workspaceId,
          clientEventId,
          seq: newSeq,
          serverReceivedAt: serverIso,
          ipHash,
          gpsLat: gpsLat ?? null,
          gpsLon: gpsLon ?? null,
          gpsAccuracyM: gpsAccuracyM ?? null,
          gpsCapturedAt: gpsCapturedAt ?? null,
          isClinical,
          ciphertext,
          iv,
        };

        const hash = computeEventHash(prevHash, envelope);

        await tx.insert(dataEvents).values({
          workspaceId,
          authorUserId: sessionUserId,
          clientEventId,
          seq: newSeq,
          prevHash,
          hash,
          ciphertext,
          iv,
          clientClaimedAt: new Date(clientClaimedAt),
          serverReceivedAt,
          ipHash,
          gpsLat: gpsLat ?? null,
          gpsLon: gpsLon ?? null,
          gpsAccuracyM: gpsAccuracyM ?? null,
          gpsCapturedAt: gpsCapturedAt ? new Date(gpsCapturedAt) : null,
          gpsStaleSeconds: gpsStaleSeconds ?? null,
          isClinical,
        });

        await tx
          .update(userEventChain)
          .set({ headSeq: newSeq, headHash: hash })
          .where(eq(userEventChain.workspaceId, workspaceId));

        accepted.push({
          clientEventId,
          seq: newSeq,
          hash,
          serverReceivedAt: serverIso,
        });
      }
    });
  } catch (e: any) {
    if (e?.message === 'clinical_gps') {
      return c.json({ error: 'Clinical events require gpsLat and gpsLon' }, 422);
    }
    if (e?.message === 'bad_event') {
      return c.json({ error: 'Invalid event payload' }, 400);
    }
    if (e?.code === '23505') {
      return c.json({ error: 'Duplicate clientEventId in batch' }, 409);
    }
    console.error('POST /api/events', e);
    return c.json({ error: 'Transaction failed' }, 500);
  }

  for (const row of accepted) {
    notifyEventAppend(workspaceId, row.seq, row.hash);
  }

  return c.json({ accepted });
});

// GET /api/events?since=0&limit=500&workspaceId=...
events.get('/', async (c) => {
  const sessionUserId = (c as any).get('userId') as string;
  const rw = await resolveWorkspaceFromQuery(c, sessionUserId);
  if (!rw) {
    return c.json({ error: 'Workspace not found; pass workspaceId query or X-Workspace-Id header.' }, 404);
  }

  const since = Number(c.req.query('since') ?? '0');
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? '100')));

  const rows = await db
    .select()
    .from(dataEvents)
    .where(and(eq(dataEvents.workspaceId, rw.workspaceId), gt(dataEvents.seq, since)))
    .orderBy(asc(dataEvents.seq))
    .limit(limit);

  return c.json({
    events: rows.map((r) => ({
      clientEventId: r.clientEventId,
      seq: r.seq,
      prevHash: r.prevHash,
      hash: r.hash,
      ciphertext: r.ciphertext,
      iv: r.iv,
      clientClaimedAt: r.clientClaimedAt.toISOString(),
      serverReceivedAt: r.serverReceivedAt.toISOString(),
      isClinical: r.isClinical,
      authorUserId: r.authorUserId,
      gpsLat: r.gpsLat,
      gpsLon: r.gpsLon,
      gpsAccuracyM: r.gpsAccuracyM,
      gpsCapturedAt: r.gpsCapturedAt?.toISOString() ?? null,
      gpsStaleSeconds: r.gpsStaleSeconds,
    })),
  });
});

// GET /api/events/stream?workspaceId=...
events.get('/stream', (c) => {
  const sessionUserId = (c as any).get('userId') as string;

  return streamSSE(c, async (stream) => {
    const rw = await resolveWorkspaceFromQuery(c, sessionUserId);
    if (!rw) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'workspace not found' }) });
      return;
    }
    const workspaceId = rw.workspaceId;

    const send = (msg: { seq: number; hash: string }) => {
      stream.writeSSE({ event: 'update', data: JSON.stringify(msg) }).catch(() => {});
    };

    if (!sseEventConnections.has(workspaceId)) sseEventConnections.set(workspaceId, new Set());
    sseEventConnections.get(workspaceId)!.add(send);

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {});
    }, 25000);

    stream.onAbort(() => {
      clearInterval(heartbeat);
      sseEventConnections.get(workspaceId)?.delete(send);
    });

    await new Promise<void>(resolve => {
      setTimeout(resolve, 24 * 60 * 60 * 1000);
    });
  });
});

export { events as eventsRouter };
