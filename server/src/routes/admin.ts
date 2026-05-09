import { Hono } from 'hono';
import { db } from '../db/client';
import { auditEvents, domainEvents, tenantMembers, tenants, users } from '../db/schema';
import { and, asc, count, desc, eq, gt, ilike, isNull } from 'drizzle-orm';
import { requireUser, requireAdmin } from '../auth/middleware';
import { deleteAllSessionsForUser } from '../auth/session';
import { logEvent } from '../services/audit';
import { isMfaDisabledEmail } from '../auth/mfaBypass';

const admin = new Hono();
admin.use('*', requireUser);
admin.use('*', requireAdmin);

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

function getUa(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  return c.req.header('user-agent');
}

admin.get('/users', async (c) => {
  const operatorId = (c as { get: (k: string) => unknown }).get('userId') as string;
  const q = c.req.query('q')?.trim();
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? '50')));
  const offset = Math.max(0, Number(c.req.query('offset') ?? '0'));

  const emailFilter = q ? ilike(users.email, `%${q.replace(/%/g, '')}%`) : undefined;

  const userRows = emailFilter
    ? await db
        .select({
          id: users.id,
          email: users.email,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(emailFilter)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset)
    : await db
        .select({
          id: users.id,
          email: users.email,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);

  const out = [];
  for (const u of userRows) {
    const memberships = await db
      .select({
        tenantId: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
      .where(and(eq(tenantMembers.userId, u.id), isNull(tenantMembers.revokedAt)));

    out.push({
      ...u,
      tenants: memberships.map((m) => ({
        tenantId: m.tenantId,
        slug: m.slug,
        name: m.name,
        role: m.role,
      })),
    });
  }

  await logEvent({
    action: 'admin_users_list',
    userId: operatorId,
    ip: getClientIp(c),
    userAgent: getUa(c),
  });

  return c.json({ users: out });
});

admin.get('/users/:id', async (c) => {
  const operatorId = (c as { get: (k: string) => unknown }).get('userId') as string;
  const id = c.req.param('id');

  const userRows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const u = userRows[0];
  if (!u) return c.json({ error: 'Not found' }, 404);

  const memberships = await db
    .select()
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, id));

  await logEvent({
    action: 'admin_user_detail',
    userId: operatorId,
    artifactId: id,
    ip: getClientIp(c),
    userAgent: getUa(c),
  });

  return c.json({
    id: u.id,
    email: u.email,
    createdAt: u.createdAt.toISOString(),
    mfaDisabled: u.mfaDisabled || isMfaDisabledEmail(u.email),
    memberships: memberships.map((m) => ({
      tenantId: m.tenantId,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
      revokedAt: m.revokedAt?.toISOString() ?? null,
    })),
  });
});

admin.get('/audit', async (c) => {
  const operatorId = (c as { get: (k: string) => unknown }).get('userId') as string;
  const filterUserId = c.req.query('userId');
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '50')));
  const offset = Math.max(0, Number(c.req.query('offset') ?? '0'));

  const auditFilter = filterUserId ? eq(auditEvents.userId, filterUserId) : undefined;

  const [countRow] = auditFilter
    ? await db.select({ total: count() }).from(auditEvents).where(auditFilter)
    : await db.select({ total: count() }).from(auditEvents);
  const total = Number(countRow?.total ?? 0);

  const base = db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      occurredAt: auditEvents.occurredAt,
      userId: auditEvents.userId,
      userEmail: users.email,
      artifactId: auditEvents.artifactId,
      userAgent: auditEvents.userAgent,
      ipHash: auditEvents.ipHash,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.userId, users.id));

  const rows = auditFilter
    ? await base
        .where(auditFilter)
        .orderBy(desc(auditEvents.occurredAt))
        .limit(limit)
        .offset(offset)
    : await base.orderBy(desc(auditEvents.occurredAt)).limit(limit).offset(offset);

  await logEvent({
    action: 'admin_audit_list',
    userId: operatorId,
    ip: getClientIp(c),
    userAgent: getUa(c),
  });

  return c.json({
    total,
    limit,
    offset,
    events: rows.map((r) => ({
      id: r.id,
      action: r.action,
      occurredAt: r.occurredAt.toISOString(),
      userId: r.userId,
      userEmail: r.userEmail,
      artifactId: r.artifactId,
      userAgent: r.userAgent,
      hasIpHash: !!r.ipHash,
    })),
  });
});

admin.get('/domain-events', async (c) => {
  const operatorId = (c as { get: (k: string) => unknown }).get('userId') as string;
  const tenantId = c.req.query('tenantId')?.trim();
  const authorUserId = c.req.query('authorUserId')?.trim();
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '50')));
  const offset = Math.max(0, Number(c.req.query('offset') ?? '0'));

  const predicates = [];
  if (tenantId) predicates.push(eq(domainEvents.tenantId, tenantId));
  if (authorUserId) predicates.push(eq(domainEvents.authorUserId, authorUserId));
  const combined = predicates.length ? and(...predicates) : undefined;

  const countBase = db.select({ total: count() }).from(domainEvents);
  const [countRow] = combined ? await countBase.where(combined) : await countBase;
  const total = Number(countRow?.total ?? 0);

  const q = db
    .select({
      id: domainEvents.id,
      tenantId: domainEvents.tenantId,
      seq: domainEvents.seq,
      clientEventId: domainEvents.clientEventId,
      kind: domainEvents.kind,
      serverReceivedAt: domainEvents.serverReceivedAt,
      clientClaimedAt: domainEvents.clientClaimedAt,
      isClinical: domainEvents.isClinical,
      authorUserId: domainEvents.authorUserId,
      authorEmail: users.email,
      gpsLat: domainEvents.gpsLat,
      gpsLon: domainEvents.gpsLon,
    })
    .from(domainEvents)
    .leftJoin(users, eq(domainEvents.authorUserId, users.id));

  const rows = combined
    ? await q.where(combined).orderBy(desc(domainEvents.serverReceivedAt)).limit(limit).offset(offset)
    : await q.orderBy(desc(domainEvents.serverReceivedAt)).limit(limit).offset(offset);

  await logEvent({
    action: 'admin_data_events_list',
    userId: operatorId,
    artifactId: tenantId ?? authorUserId ?? undefined,
    ip: getClientIp(c),
    userAgent: getUa(c),
  });

  return c.json({
    total,
    limit,
    offset,
    events: rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      seq: r.seq,
      kind: r.kind,
      clientEventId: r.clientEventId,
      serverReceivedAt: r.serverReceivedAt.toISOString(),
      clientClaimedAt: r.clientClaimedAt.toISOString(),
      isClinical: r.isClinical,
      authorUserId: r.authorUserId,
      authorEmail: r.authorEmail,
      hasGps: r.gpsLat != null && r.gpsLon != null,
    })),
  });
});

admin.get('/domain-events/:id', async (c) => {
  const operatorId = (c as { get: (k: string) => unknown }).get('userId') as string;
  const id = c.req.param('id');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) return c.json({ error: 'Invalid id' }, 400);

  const rows = await db
    .select({
      id: domainEvents.id,
      tenantId: domainEvents.tenantId,
      seq: domainEvents.seq,
      clientEventId: domainEvents.clientEventId,
      kind: domainEvents.kind,
      payload: domainEvents.payload,
      serverReceivedAt: domainEvents.serverReceivedAt,
      clientClaimedAt: domainEvents.clientClaimedAt,
      isClinical: domainEvents.isClinical,
      authorUserId: domainEvents.authorUserId,
      authorEmail: users.email,
      gpsLat: domainEvents.gpsLat,
      gpsLon: domainEvents.gpsLon,
      gpsAccuracyM: domainEvents.gpsAccuracyM,
      gpsCapturedAt: domainEvents.gpsCapturedAt,
      gpsStaleSeconds: domainEvents.gpsStaleSeconds,
      ipHash: domainEvents.ipHash,
    })
    .from(domainEvents)
    .leftJoin(users, eq(domainEvents.authorUserId, users.id))
    .where(eq(domainEvents.id, id))
    .limit(1);

  const r = rows[0];
  if (!r) return c.json({ error: 'Not found' }, 404);

  await logEvent({
    action: 'admin_data_event_detail',
    userId: operatorId,
    artifactId: id,
    ip: getClientIp(c),
    userAgent: getUa(c),
  });

  return c.json({
    event: {
      id: r.id,
      tenantId: r.tenantId,
      seq: r.seq,
      clientEventId: r.clientEventId,
      kind: r.kind,
      payload: r.payload,
      serverReceivedAt: r.serverReceivedAt.toISOString(),
      clientClaimedAt: r.clientClaimedAt.toISOString(),
      isClinical: r.isClinical,
      authorUserId: r.authorUserId,
      authorEmail: r.authorEmail,
      gpsLat: r.gpsLat,
      gpsLon: r.gpsLon,
      gpsAccuracyM: r.gpsAccuracyM,
      gpsCapturedAt: r.gpsCapturedAt?.toISOString() ?? null,
      gpsStaleSeconds: r.gpsStaleSeconds,
      hasIpHash: !!r.ipHash,
    },
  });
});

admin.get('/tenants/:tenantId/event-log', async (c) => {
  const operatorId = (c as { get: (k: string) => unknown }).get('userId') as string;
  const tenantId = c.req.param('tenantId');
  const sinceSeq = Number(c.req.query('sinceSeq') ?? '0');
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? '100')));

  const rows = await db
    .select({
      seq: domainEvents.seq,
      clientEventId: domainEvents.clientEventId,
      kind: domainEvents.kind,
      serverReceivedAt: domainEvents.serverReceivedAt,
      isClinical: domainEvents.isClinical,
      authorUserId: domainEvents.authorUserId,
      gpsLat: domainEvents.gpsLat,
      gpsLon: domainEvents.gpsLon,
    })
    .from(domainEvents)
    .where(and(eq(domainEvents.tenantId, tenantId), gt(domainEvents.seq, sinceSeq)))
    .orderBy(asc(domainEvents.seq))
    .limit(limit);

  await logEvent({
    action: 'admin_event_log_list',
    userId: operatorId,
    artifactId: tenantId,
    ip: getClientIp(c),
    userAgent: getUa(c),
  });

  return c.json({
    events: rows.map((row) => ({
      seq: row.seq,
      clientEventId: row.clientEventId,
      kind: row.kind,
      serverReceivedAt: row.serverReceivedAt.toISOString(),
      isClinical: row.isClinical,
      authorUserId: row.authorUserId,
      gpsLat: row.gpsLat,
      gpsLon: row.gpsLon,
    })),
  });
});

admin.post('/users/:id/revoke-sessions', async (c) => {
  const operatorId = (c as { get: (k: string) => unknown }).get('userId') as string;
  const targetId = c.req.param('id');

  await deleteAllSessionsForUser(targetId);
  await logEvent({
    action: 'admin_sessions_revoke',
    userId: operatorId,
    artifactId: targetId,
    ip: getClientIp(c),
    userAgent: getUa(c),
  });

  return c.json({ success: true });
});

export { admin as adminRouter };
