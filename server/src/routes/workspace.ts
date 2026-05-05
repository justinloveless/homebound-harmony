import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db/client';
import { workspaceBlobs } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '../auth/middleware';

// In-memory SSE bus: userId → set of send functions
const sseConnections = new Map<string, Set<(version: number) => void>>();

export function notifyWorkspaceUpdate(userId: string, version: number) {
  const conns = sseConnections.get(userId);
  if (conns) for (const send of conns) send(version);
}

const workspace = new Hono();
workspace.use('*', requireUser);

// GET /api/workspace
workspace.get('/', async (c) => {
  const userId = (c as any).get('userId') as string;
  const rows = await db.select().from(workspaceBlobs).where(eq(workspaceBlobs.userId, userId));
  const blob = rows[0];
  if (!blob) return c.json({ error: 'Not found' }, 404);
  c.header('ETag', `"${blob.version}"`);
  return c.json({
    ciphertext: blob.ciphertext,
    iv: blob.iv,
    wrappedWorkspaceKey: blob.wrappedWorkspaceKey,
    wrappedWorkspaceKeyRecovery: blob.wrappedWorkspaceKeyRecovery,
    version: blob.version,
  });
});

// PUT /api/workspace
// Accepts version via `If-Match: "<n>"` header (preferred) or JSON body `version`.
workspace.put('/', async (c) => {
  const userId = (c as any).get('userId') as string;
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid request' }, 400);

  const { ciphertext, iv } = body;
  if (!ciphertext || !iv) return c.json({ error: 'Missing fields' }, 400);

  const ifMatch = c.req.header('if-match');
  const headerVersion = ifMatch ? Number(ifMatch.replace(/"/g, '')) : NaN;
  const bodyVersion = typeof body.version === 'number' ? body.version : NaN;
  const clientVersion = Number.isFinite(headerVersion) ? headerVersion : bodyVersion;
  if (!Number.isFinite(clientVersion)) {
    return c.json({ error: 'Missing version (use If-Match header)' }, 428);
  }

  const rows = await db.select().from(workspaceBlobs).where(eq(workspaceBlobs.userId, userId));
  const current = rows[0];

  if (!current) return c.json({ error: 'Workspace not initialized' }, 400);

  if (current.version !== clientVersion) {
    c.header('ETag', `"${current.version}"`);
    return c.json({ error: 'Conflict', serverVersion: current.version }, 412);
  }

  const newVersion = current.version + 1;
  await db.update(workspaceBlobs)
    .set({ ciphertext, iv, version: newVersion, updatedAt: new Date() })
    .where(eq(workspaceBlobs.userId, userId));

  notifyWorkspaceUpdate(userId, newVersion);
  c.header('ETag', `"${newVersion}"`);
  return c.json({ version: newVersion });
});

// GET /api/workspace/events  — SSE for cross-device sync
workspace.get('/events', (c) => {
  const userId = (c as any).get('userId') as string;

  return streamSSE(c, async (stream) => {
    const send = (version: number) => {
      stream.writeSSE({ event: 'update', data: JSON.stringify({ version }) }).catch(() => {});
    };

    if (!sseConnections.has(userId)) sseConnections.set(userId, new Set());
    sseConnections.get(userId)!.add(send);

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {});
    }, 25000);

    stream.onAbort(() => {
      clearInterval(heartbeat);
      sseConnections.get(userId)?.delete(send);
    });

    // Wait for 24h max before the stream is closed by the server
    await new Promise<void>(resolve => {
      setTimeout(resolve, 24 * 60 * 60 * 1000);
    });
  });
});

export { workspace as workspaceRouter };
