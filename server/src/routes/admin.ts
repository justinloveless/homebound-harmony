import { Hono } from 'hono';
import { db } from '../db/client';
import {
  users,
  workspaceSnapshots,
  userEventChain,
  auditEvents,
  dataEvents,
  workspaceMembers,
} from '../db/schema';
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

// GET /api/admin/users?q=&limit=&offset=
admin.get('/users', async (c) => {
  const operatorId = (c as any).get('userId') as string;
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
    const snaps = await db
      .select({
        workspaceId: workspaceSnapshots.workspaceId,
        version: workspaceSnapshots.version,
        snapshotSeq: workspaceSnapshots.snapshotSeq,
        updatedAt: workspaceSnapshots.updatedAt,
        keyEpoch: workspaceSnapshots.keyEpoch,
      })
      .from(workspaceSnapshots)
      .innerJoin(workspaceMembers, eq(workspaceSnapshots.workspaceId, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, u.id), isNull(workspaceMembers.revokedAt)));

    const chains = await db
      .select({ workspaceId: userEventChain.workspaceId, headSeq: userEventChain.headSeq })
      .from(userEventChain)
      .innerJoin(workspaceMembers, eq(userEventChain.workspaceId, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, u.id), isNull(workspaceMembers.revokedAt)));

    const headByWs = new Map(chains.map((r) => [r.workspaceId, r.headSeq]));
    out.push({
      ...u,
      workspaces: snaps.map((s) => ({
        workspaceId: s.workspaceId,
        version: s.version,
        snapshotSeq: s.snapshotSeq,
        headSeq: headByWs.get(s.workspaceId) ?? 0,
        updatedAt: s.updatedAt.toISOString(),
        keyEpoch: s.keyEpoch,
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

// GET /api/admin/users/:id
admin.get('/users/:id', async (c) => {
  const operatorId = (c as any).get('userId') as string;
  const id = c.req.param('id');

  const userRows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const u = userRows[0];
  if (!u) return c.json({ error: 'Not found' }, 404);

  const memberships = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, id));

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
      workspaceId: m.workspaceId,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
      revokedAt: m.revokedAt?.toISOString() ?? null,
    })),
  });
});

// GET /api/admin/audit?userId=&limit=&offset=
admin.get('/audit', async (c) => {
  const operatorId = (c as any).get('userId') as string;
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

// GET /api/admin/data-events?workspaceId=&authorUserId=&limit=&offset=
// Metadata only (no ciphertext) — cross-workspace event timeline for admins.
admin.get('/data-events', async (c) => {
  const operatorId = (c as any).get('userId') as string;
  const workspaceId = c.req.query('workspaceId')?.trim();
  const authorUserId = c.req.query('authorUserId')?.trim();
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '50')));
  const offset = Math.max(0, Number(c.req.query('offset') ?? '0'));

  const predicates = [];
  if (workspaceId) predicates.push(eq(dataEvents.workspaceId, workspaceId));
  if (authorUserId) predicates.push(eq(dataEvents.authorUserId, authorUserId));
  const combined = predicates.length ? and(...predicates) : undefined;

  const countBase = db.select({ total: count() }).from(dataEvents);
  const [countRow] = combined
    ? await countBase.where(combined)
    : await countBase;
  const total = Number(countRow?.total ?? 0);

  const q = db
    .select({
      workspaceId: dataEvents.workspaceId,
      seq: dataEvents.seq,
      clientEventId: dataEvents.clientEventId,
      serverReceivedAt: dataEvents.serverReceivedAt,
      clientClaimedAt: dataEvents.clientClaimedAt,
      isClinical: dataEvents.isClinical,
      authorUserId: dataEvents.authorUserId,
      authorEmail: users.email,
      gpsLat: dataEvents.gpsLat,
      gpsLon: dataEvents.gpsLon,
    })
    .from(dataEvents)
    .leftJoin(users, eq(dataEvents.authorUserId, users.id));

  const rows = combined
    ? await q
        .where(combined)
        .orderBy(desc(dataEvents.serverReceivedAt))
        .limit(limit)
        .offset(offset)
    : await q.orderBy(desc(dataEvents.serverReceivedAt)).limit(limit).offset(offset);

  await logEvent({
    action: 'admin_data_events_list',
    userId: operatorId,
    artifactId: workspaceId ?? authorUserId ?? undefined,
    ip: getClientIp(c),
    userAgent: getUa(c),
  });

  return c.json({
    total,
    limit,
    offset,
    events: rows.map((r) => ({
      workspaceId: r.workspaceId,
      seq: r.seq,
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

// GET /api/admin/workspaces/:workspaceId/event-log?sinceSeq=&limit=
admin.get('/workspaces/:workspaceId/event-log', async (c) => {
  const operatorId = (c as any).get('userId') as string;
  const workspaceId = c.req.param('workspaceId');
  const sinceSeq = Number(c.req.query('sinceSeq') ?? '0');
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? '100')));

  const rows = await db
    .select({
      seq: dataEvents.seq,
      clientEventId: dataEvents.clientEventId,
      serverReceivedAt: dataEvents.serverReceivedAt,
      isClinical: dataEvents.isClinical,
      authorUserId: dataEvents.authorUserId,
      gpsLat: dataEvents.gpsLat,
      gpsLon: dataEvents.gpsLon,
    })
    .from(dataEvents)
    .where(and(eq(dataEvents.workspaceId, workspaceId), gt(dataEvents.seq, sinceSeq)))
    .orderBy(asc(dataEvents.seq))
    .limit(limit);

  await logEvent({
    action: 'admin_event_log_list',
    userId: operatorId,
    artifactId: workspaceId,
    ip: getClientIp(c),
    userAgent: getUa(c),
  });

  return c.json({
    events: rows.map((r) => ({
      seq: r.seq,
      clientEventId: r.clientEventId,
      serverReceivedAt: r.serverReceivedAt.toISOString(),
      isClinical: r.isClinical,
      authorUserId: r.authorUserId,
      gpsLat: r.gpsLat,
      gpsLon: r.gpsLon,
    })),
  });
});

// POST /api/admin/users/:id/revoke-sessions
admin.post('/users/:id/revoke-sessions', async (c) => {
  const operatorId = (c as any).get('userId') as string;
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
