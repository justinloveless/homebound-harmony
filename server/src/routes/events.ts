import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { sql, and, eq, gt, asc } from 'drizzle-orm';
import { db } from '../db/client';
import { domainEvents, tenantDomainChain } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { hashIp } from '../services/ipHash';
import { resolveTenantForRequest } from '../services/tenantContext';
import { subscribeTenantEventSends, notifyDomainEventAppend } from '../services/tenantEventSse';

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

const events = new Hono();
events.use('*', requireUser);

events.post('/', async (c) => {
  const sessionUserId = (c as { get: (k: string) => unknown }).get('userId') as string;
  const rt = await resolveTenantForRequest(c, sessionUserId);
  if (!rt) return c.json({ error: 'Tenant not found; set X-Tenant-Id or use tenant subdomain.' }, 404);

  const tenantId = rt.tenantId;
  const body = await c.req.json().catch(() => null);
  if (!body?.events || !Array.isArray(body.events)) {
    return c.json({ error: 'Invalid request: expected { events: [...] }' }, 400);
  }

  const ip = getClientIp(c);
  const ipHash = ip && ip !== 'unknown' ? await hashIp(ip) : null;
  const accepted: { clientEventId: string; seq: number; serverReceivedAt: string }[] = [];

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT tenant_id FROM tenant_domain_chain WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`);

      const chainRows = await tx.select().from(tenantDomainChain).where(eq(tenantDomainChain.tenantId, tenantId));
      let head = chainRows[0];
      if (!head) {
        await tx.insert(tenantDomainChain).values({ tenantId, headSeq: 0 });
        head = { tenantId, headSeq: 0 };
      }

      for (const raw of body.events as Record<string, unknown>[]) {
        const clientEventId = raw.clientEventId;
        const clientClaimedAt = raw.clientClaimedAt;
        const kind = raw.kind;
        const payload = raw.payload ?? {};
        const isClinical = Boolean(raw.isClinical);
        if (typeof clientEventId !== 'string' || !clientEventId) {
          throw Object.assign(new Error('bad_event'), { status: 400 });
        }
        if (typeof clientClaimedAt !== 'string') {
          throw Object.assign(new Error('bad_event'), { status: 400 });
        }
        if (typeof kind !== 'string' || !kind) {
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
          .from(domainEvents)
          .where(and(eq(domainEvents.tenantId, tenantId), eq(domainEvents.clientEventId, clientEventId)))
          .limit(1);

        if (existing.length > 0) {
          const row = existing[0];
          accepted.push({
            clientEventId: row.clientEventId,
            seq: row.seq,
            serverReceivedAt: row.serverReceivedAt.toISOString(),
          });
          continue;
        }

        const newSeq = head.headSeq + 1;
        const serverReceivedAt = new Date();
        const serverIso = serverReceivedAt.toISOString();

        await tx.insert(domainEvents).values({
          tenantId,
          authorUserId: sessionUserId,
          clientEventId,
          seq: newSeq,
          kind,
          payload: payload as Record<string, unknown>,
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
          .update(tenantDomainChain)
          .set({ headSeq: newSeq })
          .where(eq(tenantDomainChain.tenantId, tenantId));

        head = { tenantId, headSeq: newSeq };
        accepted.push({
          clientEventId,
          seq: newSeq,
          serverReceivedAt: serverIso,
        });
      }
    });
  } catch (e: unknown) {
    const err = e as { message?: string; code?: string };
    if (err?.message === 'clinical_gps') {
      return c.json({ error: 'Clinical events require gpsLat and gpsLon' }, 422);
    }
    if (err?.message === 'bad_event') {
      return c.json({ error: 'Invalid event payload' }, 400);
    }
    if (err?.code === '23505') {
      return c.json({ error: 'Duplicate clientEventId in batch' }, 409);
    }
    console.error('POST /api/events', e);
    return c.json({ error: 'Transaction failed' }, 500);
  }

  for (const row of accepted) {
    notifyDomainEventAppend(tenantId, row.seq);
  }

  return c.json({ accepted });
});

events.get('/', async (c) => {
  const sessionUserId = (c as { get: (k: string) => unknown }).get('userId') as string;
  const rt = await resolveTenantForRequest(c, sessionUserId);
  if (!rt) return c.json({ error: 'Tenant not found; pass tenantId query or X-Tenant-Id header.' }, 404);

  const since = Number(c.req.query('since') ?? '0');
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? '100')));

  const rows = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.tenantId, rt.tenantId), gt(domainEvents.seq, since)))
    .orderBy(asc(domainEvents.seq))
    .limit(limit);

  return c.json({
    events: rows.map((r) => ({
      clientEventId: r.clientEventId,
      seq: r.seq,
      kind: r.kind,
      payload: r.payload,
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

events.get('/stream', (c) => {
  const sessionUserId = (c as { get: (k: string) => unknown }).get('userId') as string;

  return streamSSE(c, async (stream) => {
    const rt = await resolveTenantForRequest(c, sessionUserId);
    if (!rt) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'tenant not found' }) });
      return;
    }
    const tenantId = rt.tenantId;

    const send = (msg: { seq: number }) => {
      stream.writeSSE({ event: 'update', data: JSON.stringify(msg) }).catch(() => {});
    };

    const unsub = subscribeTenantEventSends(tenantId, send);

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {});
    }, 25000);

    stream.onAbort(() => {
      clearInterval(heartbeat);
      unsub();
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 24 * 60 * 60 * 1000);
    });
  });
});

export { events as eventsRouter };
