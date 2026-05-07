import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { getSession } from './session';
import { db } from '../db/client';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE, setSessionCookie } from './cookie';
import { isAdminEmail } from './admin';

export const requireUser = createMiddleware(async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return c.json({ error: 'Unauthorized' }, 401);

  const session = await getSession(sessionId);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const rows = await db.select().from(users).where(eq(users.id, session.userId));
  const user = rows[0];
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  c.set('userId', session.userId);
  c.set('user', user);
  setSessionCookie(c, sessionId);
  await next();
});

export const requireAdmin = createMiddleware(async (c, next) => {
  const user = (c as any).get('user') as typeof users.$inferSelect | undefined;
  if (!user || !isAdminEmail(user.email)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
});
