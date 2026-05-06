import { db } from '../db/client';
import { userSessions } from '../db/schema';
import { eq, lt } from 'drizzle-orm';

/**
 * Long-lived sessions for native clients (iOS): stay signed in across restarts until
 * explicit logout or app uninstall. Cookie `maxAge` must stay in sync so the client
 * keeps sending the session id for the full server-side lifetime.
 */
const TEN_YEARS_MS = Math.floor(10 * 365.25 * 24 * 60 * 60 * 1000);

export const SESSION_ABSOLUTE_MS = TEN_YEARS_MS;
/** Match absolute cap so brief gaps between app opens do not invalidate the session. */
export const SESSION_IDLE_MS = TEN_YEARS_MS;
export const SESSION_COOKIE_MAX_AGE_SEC = Math.floor(TEN_YEARS_MS / 1000);

export function newSessionId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
}

export async function createSession(userId: string): Promise<string> {
  const id = newSessionId();
  const now = Date.now();
  await db.insert(userSessions).values({
    id,
    userId,
    expiresAt: new Date(now + SESSION_ABSOLUTE_MS),
    idleExpiresAt: new Date(now + SESSION_IDLE_MS),
  });
  return id;
}

export async function getSession(id: string): Promise<{ userId: string } | null> {
  const rows = await db.select().from(userSessions).where(eq(userSessions.id, id));
  const session = rows[0];
  if (!session) return null;
  const now = new Date();
  if (session.expiresAt < now || session.idleExpiresAt < now) {
    await db.delete(userSessions).where(eq(userSessions.id, id));
    return null;
  }
  // Sliding idle timeout: refresh on every successful lookup, capped by absolute expiry.
  const newIdle = new Date(Date.now() + SESSION_IDLE_MS);
  if (newIdle < session.expiresAt) {
    await db.update(userSessions).set({ idleExpiresAt: newIdle }).where(eq(userSessions.id, id));
  }
  return { userId: session.userId };
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(userSessions).where(eq(userSessions.id, id));
}

export async function pruneExpiredSessions(): Promise<void> {
  await db.delete(userSessions).where(lt(userSessions.expiresAt, new Date()));
}
