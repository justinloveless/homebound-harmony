import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { getSession } from './session';
import { db } from '../db/client';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE, setSessionCookie } from './cookie';

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
