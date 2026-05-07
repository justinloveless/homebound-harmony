import { Hono } from 'hono';
import { db } from '../db/client';
import { workspaceSnapshots, userEventChain } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '../auth/middleware';

const snapshot = new Hono();
snapshot.use('*', requireUser);

// GET /api/snapshot
snapshot.get('/', async (c) => {
  const userId = (c as any).get('userId') as string;
  const rows = await db.select().from(workspaceSnapshots).where(eq(workspaceSnapshots.userId, userId));
  const row = rows[0];
  if (!row) return c.json({ error: 'Not found' }, 404);
  c.header('ETag', `"${row.version}"`);
  return c.json({
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedWorkspaceKey: row.wrappedWorkspaceKey,
    wrappedWorkspaceKeyRecovery: row.wrappedWorkspaceKeyRecovery,
    version: row.version,
    snapshotSeq: row.snapshotSeq,
  });
});

// PUT /api/snapshot — rollup encrypted workspace; optimistic concurrency on version
snapshot.put('/', async (c) => {
  const userId = (c as any).get('userId') as string;
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

  const rows = await db.select().from(workspaceSnapshots).where(eq(workspaceSnapshots.userId, userId));
  const current = rows[0];
  if (!current) return c.json({ error: 'Workspace not initialized' }, 400);

  if (current.version !== clientVersion) {
    c.header('ETag', `"${current.version}"`);
    return c.json({ error: 'Conflict', serverVersion: current.version }, 412);
  }

  const chainRows = await db.select().from(userEventChain).where(eq(userEventChain.userId, userId));
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
    .where(eq(workspaceSnapshots.userId, userId));

  c.header('ETag', `"${newVersion}"`);
  return c.json({ version: newVersion, snapshotSeq });
});

export { snapshot as snapshotRouter };
