import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { tenants, tenantMembers, users, workers } from '../db/schema';
import { requireUser } from '../auth/middleware';
import { requireTenant } from '../services/tenantContext';
import { requireRole } from '../auth/rbac';
import { logEvent } from '../services/audit';
import { deleteAllSessionsForUser } from '../auth/session';

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

const r = new Hono();
r.use('*', requireUser);
r.use('*', requireTenant);

// GET /api/tenant
r.get('/', async (c) => {
  const tenantId = c.get('tenantId') as string;
  const rows = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const t = rows[0];
  if (!t) return c.json({ error: 'Not found' }, 404);
  return c.json({
    id: t.id,
    slug: t.slug,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  });
});

// PUT /api/tenant — admin only
r.put('/', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId') as string;
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name : null;
  if (!name) return c.json({ error: 'Missing name' }, 400);

  await db.update(tenants).set({ name, updatedAt: new Date() }).where(eq(tenants.id, tenantId));

  await logEvent({
    action: 'tenant_settings_update',
    userId,
    artifactId: `tenant:${tenantId}`,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  const t = (await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0]!;
  return c.json({
    id: t.id,
    slug: t.slug,
    name: t.name,
    updatedAt: t.updatedAt.toISOString(),
  });
});

// GET /api/tenant/members
r.get('/members', async (c) => {
  const tenantId = c.get('tenantId') as string;
  const rows = await db
    .select({
      userId: tenantMembers.userId,
      role: tenantMembers.role,
      email: users.email,
      revokedAt: tenantMembers.revokedAt,
      createdAt: tenantMembers.createdAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(tenantMembers.userId, users.id))
    .where(eq(tenantMembers.tenantId, tenantId));

  return c.json({
    members: rows.map((m) => ({
      userId: m.userId,
      email: m.email,
      role: m.role,
      active: m.revokedAt == null,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

// POST /api/tenant/members — admin; invite existing user by email
r.post('/members', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId') as string;
  const sessionUserId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body?.role === 'admin' ? 'admin' : 'caregiver';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Invalid email' }, 400);

  const urows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  const target = urows[0];
  if (!target) return c.json({ error: 'User must register before joining a tenant' }, 400);

  const existing = await db
    .select()
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, target.id)))
    .limit(1);

  if (existing[0]?.revokedAt == null && existing[0]) {
    return c.json({ error: 'User is already a member' }, 409);
  }

  if (existing[0]) {
    await db
      .update(tenantMembers)
      .set({ role, revokedAt: null })
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, target.id)));
  } else {
    await db.insert(tenantMembers).values({ tenantId, userId: target.id, role });
    const hasWorker = await db
      .select({ id: workers.id })
      .from(workers)
      .where(and(eq(workers.tenantId, tenantId), eq(workers.userId, target.id)))
      .limit(1);
    if (!hasWorker[0]) {
      await db.insert(workers).values({
        tenantId,
        userId: target.id,
        name: '',
        homeAddress: '',
      });
    }
  }

  await logEvent({
    action: 'member_invite',
    userId: sessionUserId,
    artifactId: `${tenantId}:${target.id}`,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ success: true });
});

// PATCH /api/tenant/members/:userId/role
r.patch('/members/:userId/role', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId') as string;
  const sessionUserId = c.get('userId') as string;
  const targetId = c.req.param('userId');
  const body = await c.req.json().catch(() => null);
  const role = body?.role === 'admin' ? 'admin' : body?.role === 'caregiver' ? 'caregiver' : null;
  if (!role) return c.json({ error: 'Invalid role' }, 400);

  const admins = await db
    .select()
    .from(tenantMembers)
    .where(
      and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, 'admin'), isNull(tenantMembers.revokedAt)),
    );

  if (targetId === sessionUserId && role !== 'admin' && admins.length === 1 && admins[0].userId === sessionUserId) {
    return c.json({ error: 'Cannot demote the only admin' }, 400);
  }

  await db
    .update(tenantMembers)
    .set({ role })
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, targetId)));

  await logEvent({
    action: 'member_role_change',
    userId: sessionUserId,
    artifactId: `${tenantId}:${targetId}:${role}`,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ success: true });
});

// DELETE /api/tenant/members/:userId
r.delete('/members/:userId', requireRole('admin'), async (c) => {
  const tenantId = c.get('tenantId') as string;
  const sessionUserId = c.get('userId') as string;
  const targetId = c.req.param('userId');

  const admins = await db
    .select()
    .from(tenantMembers)
    .where(
      and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, 'admin'), isNull(tenantMembers.revokedAt)),
    );

  const targetRow = await db
    .select()
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, targetId)))
    .limit(1);

  if (!targetRow[0] || targetRow[0].revokedAt) return c.json({ error: 'Not an active member' }, 404);

  if (targetRow[0].role === 'admin' && admins.length === 1) {
    return c.json({ error: 'Cannot remove the only admin' }, 400);
  }

  await db
    .update(tenantMembers)
    .set({ revokedAt: new Date() })
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, targetId)));

  await deleteAllSessionsForUser(targetId);

  await logEvent({
    action: 'member_revoke',
    userId: sessionUserId,
    artifactId: `${tenantId}:${targetId}`,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ success: true });
});

export { r as tenantsRouter };
