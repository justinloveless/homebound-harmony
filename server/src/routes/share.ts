import { Hono } from 'hono';
import { db } from '../db/client';
import { shareArtifacts } from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { requireUser } from '../auth/middleware';
import { logEvent } from '../services/audit';

const MAX_EXPIRES_DAYS = 365;
const DEFAULT_EXPIRES_DAYS = 30;

function getClientIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

const share = new Hono();

// POST /api/share  — create artifact (authenticated)
share.post('/', requireUser, async (c) => {
  const userId = (c as any).get('userId') as string;
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid request' }, 400);

  const { ciphertext, iv, expiresInDays = DEFAULT_EXPIRES_DAYS } = body;
  if (!ciphertext || !iv) return c.json({ error: 'Missing fields' }, 400);

  const clampedDays = Math.min(Math.max(1, Number(expiresInDays)), MAX_EXPIRES_DAYS);
  const expiresAt = new Date(Date.now() + clampedDays * 24 * 60 * 60 * 1000);
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');

  await db.insert(shareArtifacts).values({ id, userId, ciphertext, iv, expiresAt });
  await logEvent({ action: 'share_create', userId, artifactId: id, ip: getClientIp(c), userAgent: c.req.header('user-agent') });

  return c.json({ id }, 201);
});

// DELETE /api/share/:id  — revoke (authenticated)
share.delete('/:id', requireUser, async (c) => {
  const userId = (c as any).get('userId') as string;
  const id = c.req.param('id');

  const rows = await db.select().from(shareArtifacts)
    .where(and(eq(shareArtifacts.id, id), eq(shareArtifacts.userId, userId)));
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);

  await db.update(shareArtifacts).set({ revokedAt: new Date() }).where(eq(shareArtifacts.id, id));
  await logEvent({ action: 'share_revoke', userId, artifactId: id, ip: getClientIp(c), userAgent: c.req.header('user-agent') });

  return c.json({ success: true });
});

// GET /api/share  — list worker's artifacts (authenticated)
share.get('/', requireUser, async (c) => {
  const userId = (c as any).get('userId') as string;
  const rows = await db.select({
    id: shareArtifacts.id,
    expiresAt: shareArtifacts.expiresAt,
    revokedAt: shareArtifacts.revokedAt,
    fetchCount: shareArtifacts.fetchCount,
    lastFetchedAt: shareArtifacts.lastFetchedAt,
    createdAt: shareArtifacts.createdAt,
  }).from(shareArtifacts).where(eq(shareArtifacts.userId, userId));
  return c.json(rows);
});

// GET /s/:id/data  — public; returns ciphertext + iv
// Registered directly on the main app (not under /api), exported separately.
export async function shareDataHandler(c: any) {
  const id = c.req.param('id');
  const rows = await db.select().from(shareArtifacts).where(eq(shareArtifacts.id, id));
  const artifact = rows[0];

  if (!artifact) return c.json({ error: 'Not found' }, 404);
  if (artifact.revokedAt) return c.json({ error: 'Revoked' }, 410);
  if (artifact.expiresAt < new Date()) return c.json({ error: 'Expired' }, 410);

  await db.update(shareArtifacts)
    .set({ fetchCount: artifact.fetchCount + 1, lastFetchedAt: new Date() })
    .where(eq(shareArtifacts.id, id));

  await logEvent({ action: 'share_fetch', artifactId: id });

  return c.json({ ciphertext: artifact.ciphertext, iv: artifact.iv });
}

export { share as shareRouter };
