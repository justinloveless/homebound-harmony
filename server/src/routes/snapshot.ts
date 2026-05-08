import { Hono } from 'hono';
import { db } from '../db/client';
import { workspaceSnapshots, userEventChain, workspaceKeyWraps } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { requireUser } from '../auth/middleware';
import { resolveWorkspace, canPutSnapshot } from '../services/workspaceContext';

const snapshot = new Hono();
snapshot.use('*', requireUser);

// GET /api/snapshot
snapshot.get('/', async (c) => {
  const sessionUserId = (c as any).get('userId') as string;
  const rw = await resolveWorkspace(c, sessionUserId);
  if (!rw) {
    return c.json({ error: 'Workspace not found; set X-Workspace-Id if you belong to several.' }, 404);
  }

  const rows = await db.select().from(workspaceSnapshots).where(eq(workspaceSnapshots.workspaceId, rw.workspaceId));
  const row = rows[0];
  if (!row) return c.json({ error: 'Not found' }, 404);

  const wrapRows = await db
    .select()
    .from(workspaceKeyWraps)
    .where(
      and(
        eq(workspaceKeyWraps.workspaceId, rw.workspaceId),
        eq(workspaceKeyWraps.userId, sessionUserId),
        eq(workspaceKeyWraps.keyEpoch, row.keyEpoch),
      ),
    )
    .limit(1);
  const wrap = wrapRows[0];
  if (!wrap) return c.json({ error: 'No key wrap for this workspace; ask an admin to re-invite you.' }, 403);

  c.header('ETag', `"${row.version}"`);
  return c.json({
    workspaceId: rw.workspaceId,
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedWorkspaceKey: wrap.wrappedWorkspaceKey,
    wrappedWorkspaceKeyRecovery: row.wrappedWorkspaceKeyRecovery,
    keyEpoch: row.keyEpoch,
    version: row.version,
    snapshotSeq: row.snapshotSeq,
  });
});

// PUT /api/snapshot — rollup encrypted workspace; optimistic concurrency on version
snapshot.put('/', async (c) => {
  const sessionUserId = (c as any).get('userId') as string;
  const rw = await resolveWorkspace(c, sessionUserId);
  if (!rw) {
    return c.json({ error: 'Workspace not found; set X-Workspace-Id if you belong to several.' }, 404);
  }
  if (!canPutSnapshot(rw.role)) {
    return c.json({ error: 'Insufficient permission to update snapshot' }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid request' }, 400);

  const { ciphertext, iv, snapshotSeq } = body;
  if (!ciphertext || !iv || typeof snapshotSeq !== 'number') {
    return c.json({ error: 'Missing fields' }, 400);
  }

  const ifMatch = c.req.header('if-match');
  const headerVersion = ifMatch ? Number(ifMatch.replace(/"/g, '')) : NaN;
  const bodyVersion = typeof body.version === 'number' ? body.version : NaN;
  const clientVersion = Number.isFinite(headerVersion) ? headerVersion : bodyVersion;
  if (!Number.isFinite(clientVersion)) {
    return c.json({ error: 'Missing version (use If-Match header)' }, 428);
  }

  const rows = await db.select().from(workspaceSnapshots).where(eq(workspaceSnapshots.workspaceId, rw.workspaceId));
  const current = rows[0];
  if (!current) return c.json({ error: 'Workspace not initialized' }, 400);

  if (current.version !== clientVersion) {
    c.header('ETag', `"${current.version}"`);
    return c.json({ error: 'Conflict', serverVersion: current.version }, 412);
  }

  const chainRows = await db.select().from(userEventChain).where(eq(userEventChain.workspaceId, rw.workspaceId));
  const headSeq = chainRows[0]?.headSeq ?? 0;
  if (snapshotSeq > headSeq) {
    return c.json({ error: `snapshotSeq (${snapshotSeq}) cannot exceed event head (${headSeq})` }, 400);
  }

  const newVersion = current.version + 1;
  await db
    .update(workspaceSnapshots)
    .set({
      ciphertext,
      iv,
      snapshotSeq,
      version: newVersion,
      updatedAt: new Date(),
    })
    .where(eq(workspaceSnapshots.workspaceId, rw.workspaceId));

  c.header('ETag', `"${newVersion}"`);
  return c.json({ version: newVersion, snapshotSeq });
});

export { snapshot as snapshotRouter };
