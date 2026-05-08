import { Hono } from 'hono';
import { db } from '../db/client';
import { workspaceMembers, workspaceKeyWraps, workspaceSnapshots, users } from '../db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { requireUser } from '../auth/middleware';
import { resolveWorkspace, canManageMembers } from '../services/workspaceContext';
import { logEvent } from '../services/audit';
import { deleteAllSessionsForUser } from '../auth/session';

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

const team = new Hono();
team.use('*', requireUser);

// GET /api/workspace/members
team.get('/members', async (c) => {
  const sessionUserId = (c as any).get('userId') as string;
  const rw = await resolveWorkspace(c, sessionUserId);
  if (!rw) return c.json({ error: 'Workspace not found; set X-Workspace-Id if needed.' }, 404);

  const rows = await db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      email: users.email,
      revokedAt: workspaceMembers.revokedAt,
      createdAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, rw.workspaceId));

  return c.json({
    workspaceId: rw.workspaceId,
    role: rw.role,
    members: rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      role: r.role,
      active: r.revokedAt == null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// POST /api/workspace/members  { userId, role, wrappedWorkspaceKey }
team.post('/members', async (c) => {
  const sessionUserId = (c as any).get('userId') as string;
  const rw = await resolveWorkspace(c, sessionUserId);
  if (!rw) return c.json({ error: 'Workspace not found' }, 404);
  if (!canManageMembers(rw.role)) {
    return c.json({ error: 'Insufficient permission to invite members' }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const inviteeId = body?.userId as string | undefined;
  const role = (body?.role as string | undefined) ?? 'editor';
  const wrappedWorkspaceKey = body?.wrappedWorkspaceKey as string | undefined;

  if (!inviteeId || !wrappedWorkspaceKey) {
    return c.json({ error: 'Missing userId or wrappedWorkspaceKey' }, 400);
  }
  if (!['admin', 'editor', 'viewer'].includes(role)) {
    return c.json({ error: 'Invalid role' }, 400);
  }

  const inviteeRows = await db.select().from(users).where(eq(users.id, inviteeId)).limit(1);
  if (!inviteeRows[0]) return c.json({ error: 'User not found' }, 404);
  if (!inviteeRows[0].masterPublicKey) {
    return c.json({ error: 'Invitee must enroll a device key before joining' }, 400);
  }

  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, rw.workspaceId), eq(workspaceMembers.userId, inviteeId)))
    .limit(1);

  if (existing[0]?.revokedAt == null && existing[0]) {
    return c.json({ error: 'User is already an active member' }, 409);
  }

  const snaps = await db.select().from(workspaceSnapshots).where(eq(workspaceSnapshots.workspaceId, rw.workspaceId)).limit(1);
  const snap = snaps[0];
  if (!snap) return c.json({ error: 'Workspace missing' }, 500);

  if (existing[0]) {
    await db
      .update(workspaceMembers)
      .set({ role, revokedAt: null, invitedBy: sessionUserId })
      .where(and(eq(workspaceMembers.workspaceId, rw.workspaceId), eq(workspaceMembers.userId, inviteeId)));
  } else {
    await db.insert(workspaceMembers).values({
      workspaceId: rw.workspaceId,
      userId: inviteeId,
      role,
      invitedBy: sessionUserId,
    });
  }

  await db
    .delete(workspaceKeyWraps)
    .where(and(eq(workspaceKeyWraps.workspaceId, rw.workspaceId), eq(workspaceKeyWraps.userId, inviteeId)));

  await db.insert(workspaceKeyWraps).values({
    workspaceId: rw.workspaceId,
    userId: inviteeId,
    keyEpoch: snap.keyEpoch,
    wrappedWorkspaceKey,
  });

  await logEvent({
    action: 'member_invite',
    userId: sessionUserId,
    artifactId: `${rw.workspaceId}:${inviteeId}`,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ success: true });
});

// PATCH /api/workspace/members/:userId/role  { role }
team.patch('/members/:userId/role', async (c) => {
  const sessionUserId = (c as any).get('userId') as string;
  const targetId = c.req.param('userId');
  const rw = await resolveWorkspace(c, sessionUserId);
  if (!rw) return c.json({ error: 'Workspace not found' }, 404);
  if (!canManageMembers(rw.role)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  const role = body?.role as string | undefined;
  if (!role || !['owner', 'admin', 'editor', 'viewer'].includes(role)) {
    return c.json({ error: 'Invalid role' }, 400);
  }

  const owners = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, rw.workspaceId),
        eq(workspaceMembers.role, 'owner'),
        isNull(workspaceMembers.revokedAt),
      ),
    );

  if (targetId === sessionUserId && role !== 'owner' && owners.length === 1 && owners[0].userId === sessionUserId) {
    return c.json({ error: 'Cannot demote the only owner' }, 400);
  }

  await db
    .update(workspaceMembers)
    .set({ role })
    .where(and(eq(workspaceMembers.workspaceId, rw.workspaceId), eq(workspaceMembers.userId, targetId)));

  await logEvent({
    action: 'member_role_change',
    userId: sessionUserId,
    artifactId: `${rw.workspaceId}:${targetId}:${role}`,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ success: true });
});

// DELETE /api/workspace/members/:userId
team.delete('/members/:userId', async (c) => {
  const sessionUserId = (c as any).get('userId') as string;
  const targetId = c.req.param('userId');
  const rw = await resolveWorkspace(c, sessionUserId);
  if (!rw) return c.json({ error: 'Workspace not found' }, 404);
  if (!canManageMembers(rw.role)) return c.json({ error: 'Forbidden' }, 403);

  const owners = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, rw.workspaceId),
        eq(workspaceMembers.role, 'owner'),
        isNull(workspaceMembers.revokedAt),
      ),
    );

  const targetRow = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, rw.workspaceId), eq(workspaceMembers.userId, targetId)))
    .limit(1);

  if (!targetRow[0] || targetRow[0].revokedAt) return c.json({ error: 'Not an active member' }, 404);

  if (targetRow[0].role === 'owner' && owners.length === 1) {
    return c.json({ error: 'Cannot remove the only owner' }, 400);
  }

  await db
    .update(workspaceMembers)
    .set({ revokedAt: new Date() })
    .where(and(eq(workspaceMembers.workspaceId, rw.workspaceId), eq(workspaceMembers.userId, targetId)));

  await db
    .delete(workspaceKeyWraps)
    .where(and(eq(workspaceKeyWraps.workspaceId, rw.workspaceId), eq(workspaceKeyWraps.userId, targetId)));

  await deleteAllSessionsForUser(targetId);

  await logEvent({
    action: 'member_revoke',
    userId: sessionUserId,
    artifactId: `${rw.workspaceId}:${targetId}`,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ success: true });
});

// POST /api/workspace/rotate-key
// { keyEpoch, wrappedWorkspaceKeyRecovery, wraps: { userId, wrappedWorkspaceKey }[] }
team.post('/rotate-key', async (c) => {
  const sessionUserId = (c as any).get('userId') as string;
  const rw = await resolveWorkspace(c, sessionUserId);
  if (!rw) return c.json({ error: 'Workspace not found' }, 404);
  if (!canManageMembers(rw.role)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  const keyEpoch = body?.keyEpoch as number | undefined;
  const wrappedWorkspaceKeyRecovery = body?.wrappedWorkspaceKeyRecovery as string | undefined;
  const wraps = body?.wraps as { userId: string; wrappedWorkspaceKey: string }[] | undefined;

  if (!Number.isFinite(keyEpoch) || !wrappedWorkspaceKeyRecovery || !Array.isArray(wraps) || wraps.length === 0) {
    return c.json({ error: 'Missing keyEpoch, wrappedWorkspaceKeyRecovery, or wraps' }, 400);
  }

  const snaps = await db.select().from(workspaceSnapshots).where(eq(workspaceSnapshots.workspaceId, rw.workspaceId)).limit(1);
  const snap = snaps[0];
  if (!snap) return c.json({ error: 'Workspace missing' }, 500);
  if (keyEpoch !== snap.keyEpoch + 1) {
    return c.json({ error: `keyEpoch must be ${snap.keyEpoch + 1}` }, 400);
  }

  const activeMembers = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, rw.workspaceId), isNull(workspaceMembers.revokedAt)));

  const activeSet = new Set(activeMembers.map((m) => m.userId));
  for (const w of wraps) {
    if (!activeSet.has(w.userId)) return c.json({ error: `Wrap for non-member ${w.userId}` }, 400);
  }
  if (activeSet.size !== wraps.length) {
    return c.json({ error: 'Must supply wraps for every active member' }, 400);
  }

  await logEvent({
    action: 'wk_rotate_start',
    userId: sessionUserId,
    artifactId: rw.workspaceId,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  await db.delete(workspaceKeyWraps).where(eq(workspaceKeyWraps.workspaceId, rw.workspaceId));

  for (const w of wraps) {
    await db.insert(workspaceKeyWraps).values({
      workspaceId: rw.workspaceId,
      userId: w.userId,
      keyEpoch,
      wrappedWorkspaceKey: w.wrappedWorkspaceKey,
    });
  }

  await db
    .update(workspaceSnapshots)
    .set({
      keyEpoch,
      wrappedWorkspaceKeyRecovery,
      updatedAt: new Date(),
    })
    .where(eq(workspaceSnapshots.workspaceId, rw.workspaceId));

  await logEvent({
    action: 'wk_rotate_complete',
    userId: sessionUserId,
    artifactId: rw.workspaceId,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ success: true, keyEpoch });
});

export { team as workspaceTeamRouter };
