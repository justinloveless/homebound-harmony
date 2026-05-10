import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { db } from '../db/client';
import { tenants, tenantMembers, users, workers, tenantDomainChain } from '../db/schema';
import { hashPassword, verifyPassword, encryptTotpSecret, decryptTotpSecret } from '../auth/argon';
import { generateTotpSecret, verifyTotpCode, generateQrDataUrl } from '../auth/totp';
import { createSession, deleteSession } from '../auth/session';
import { requireUser } from '../auth/middleware';
import { isAdminEmail } from '../auth/admin';
import { isMfaDisabledEmail } from '../auth/mfaBypass';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from '../auth/cookie';
import { logEvent } from '../services/audit';
import { and, eq, isNull } from 'drizzle-orm';

const auth = new Hono();

const loginAttempts = new Map<string, { count: number; firstAt: number }>();
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_THRESHOLD = 10;

function checkLockout(email: string): boolean {
  const a = loginAttempts.get(email);
  if (!a) return false;
  if (Date.now() - a.firstAt > LOCKOUT_WINDOW_MS) {
    loginAttempts.delete(email);
    return false;
  }
  return a.count >= LOCKOUT_THRESHOLD;
}
function recordFail(email: string) {
  const a = loginAttempts.get(email);
  if (!a) loginAttempts.set(email, { count: 1, firstAt: Date.now() });
  else a.count++;
}
function clearFails(email: string) {
  loginAttempts.delete(email);
}

const registrationTokens = new Map<string, { userId: string; expiresAt: number }>();
function createRegToken(userId: string): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  registrationTokens.set(token, { userId, expiresAt: Date.now() + 60 * 60 * 1000 });
  return token;
}
function useRegToken(token: string): string | null {
  const entry = registrationTokens.get(token);
  if (!entry || Date.now() > entry.expiresAt) {
    registrationTokens.delete(token);
    return null;
  }
  return entry.userId;
}

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

function slugFromEmail(email: string): string {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9-]/g, '-') ?? 'user';
  const base = local.replace(/^-+|-+$/g, '').slice(0, 28);
  return base || 'tenant';
}

async function allocateTenantSlug(email: string): Promise<string> {
  const base = slugFromEmail(email);
  for (let i = 0; i < 25; i++) {
    const suffix = i === 0 ? '' : `-${Math.random().toString(36).slice(2, 8)}`;
    const candidate = `${base}${suffix}`.slice(0, 48);
    const hit = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, candidate)).limit(1);
    if (!hit[0]) return candidate;
  }
  throw new Error('Could not allocate tenant slug');
}

// POST /api/auth/register — { email, password }
auth.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid request' }, 400);

  const { email, password } = body;
  if (!email || !password) return c.json({ error: 'Missing fields' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Invalid email' }, 400);
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);

  const normalizedEmail = email.toLowerCase();
  const registerMfaDisabled = isMfaDisabledEmail(normalizedEmail);

  const dup = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
  if (dup[0]) return c.json({ error: 'Email already in use' }, 409);

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      passwordHash,
      mfaDisabled: registerMfaDisabled,
    })
    .returning({ id: users.id });

  const slug = await allocateTenantSlug(normalizedEmail);
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

  const [tenant] = await db
    .insert(tenants)
    .values({ slug, name: `${displayName} Clinic` })
    .returning({ id: tenants.id });

  await db.insert(tenantMembers).values({
    tenantId: tenant.id,
    userId: user.id,
    role: 'admin',
  });

  await db.insert(workers).values({
    tenantId: tenant.id,
    userId: user.id,
    name: '',
    homeAddress: '',
  });

  await db.insert(tenantDomainChain).values({ tenantId: tenant.id, headSeq: 0 });

  const registrationToken = createRegToken(user.id);
  return c.json({ registrationToken, mfaDisabled: registerMfaDisabled, tenantId: tenant.id, tenantSlug: slug }, 201);
});

// POST /api/auth/totp/enroll
auth.post('/totp/enroll', async (c) => {
  const body = await c.req.json().catch(() => null);
  const token = body?.registrationToken;
  if (!token) return c.json({ error: 'Missing registration token' }, 400);

  const userId = useRegToken(token);
  if (!userId) return c.json({ error: 'Invalid or expired token' }, 401);

  const rows = await db.select().from(users).where(eq(users.id, userId));
  const user = rows[0];
  if (!user) return c.json({ error: 'User not found' }, 404);
  if (user.totpSecretEncrypted) return c.json({ error: 'TOTP already enrolled' }, 409);

  const { secret, otpauth } = generateTotpSecret(user.email);
  const encrypted = await encryptTotpSecret(secret);

  await db.update(users).set({ totpSecretEncrypted: encrypted, updatedAt: new Date() }).where(eq(users.id, userId));

  const newToken = createRegToken(userId);
  const qrCode = await generateQrDataUrl(otpauth);

  return c.json({ registrationToken: newToken, secret, otpauth, qrCode });
});

// POST /api/auth/totp/verify
auth.post('/totp/verify', async (c) => {
  const body = await c.req.json().catch(() => null);
  const { registrationToken, code } = body ?? {};
  if (!registrationToken || !code) return c.json({ error: 'Missing fields' }, 400);

  const userId = useRegToken(registrationToken);
  if (!userId) return c.json({ error: 'Invalid or expired token' }, 401);

  const rows = await db.select().from(users).where(eq(users.id, userId));
  const user = rows[0];
  if (!user?.totpSecretEncrypted) return c.json({ error: 'TOTP not set up' }, 400);

  const secret = await decryptTotpSecret(user.totpSecretEncrypted);
  if (!verifyTotpCode(secret, code)) return c.json({ error: 'Invalid code' }, 400);

  await logEvent({
    action: 'totp_enroll',
    userId,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ success: true });
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const { email, password, code } = body ?? {};
  const passwordStr = typeof password === 'string' ? password.trim() : '';
  const normalEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalEmail || !passwordStr) return c.json({ error: 'Missing fields' }, 400);

  if (checkLockout(normalEmail)) {
    return c.json({ error: 'Account locked. Try again in 15 minutes.' }, 429);
  }

  const rows = await db.select().from(users).where(eq(users.email, normalEmail));
  const user = rows[0];

  if (!user || !(await verifyPassword(user.passwordHash, passwordStr))) {
    recordFail(normalEmail);
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const mfaDisabled = user.mfaDisabled || isMfaDisabledEmail(user.email);
  const totpCode = typeof code === 'string' ? code.trim() : '';
  if (!mfaDisabled) {
    if (!user.totpSecretEncrypted) {
      return c.json({ error: 'TOTP enrollment incomplete. Please complete registration.' }, 403);
    }
    if (!totpCode) return c.json({ error: 'Missing TOTP code' }, 400);

    const secret = await decryptTotpSecret(user.totpSecretEncrypted);
    if (!verifyTotpCode(secret, totpCode)) {
      recordFail(normalEmail);
      return c.json({ error: 'Invalid TOTP code' }, 401);
    }
  }

  clearFails(normalEmail);
  const sessionId = await createSession(user.id);
  setSessionCookie(c, sessionId);

  await logEvent({
    action: 'login',
    userId: user.id,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ success: true });
});

// POST /api/auth/logout
auth.post('/logout', requireUser, async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await deleteSession(sessionId);
  clearSessionCookie(c);
  const userId = (c as { get: (k: string) => unknown }).get('userId');
  await logEvent({
    action: 'logout',
    userId: userId as string,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ success: true });
});

// GET /api/auth/me
auth.get('/me', requireUser, async (c) => {
  const user = (c as { get: (k: string) => unknown }).get('user') as typeof users.$inferSelect;
  c.header('X-Min-Client-Version', process.env.MIN_CLIENT_VERSION ?? '2026.5.10');
  c.header('Cache-Control', 'no-store, private');

  const memberships = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      role: tenantMembers.role,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
    .where(and(eq(tenantMembers.userId, user.id), isNull(tenantMembers.revokedAt)));

  return c.json({
    id: user.id,
    email: user.email,
    tenants: memberships.map((m) => ({
      id: m.id,
      slug: m.slug,
      name: m.name,
      role: m.role,
    })),
    totpEnrolled: !!user.totpSecretEncrypted,
    mfaDisabled: user.mfaDisabled || isMfaDisabledEmail(user.email),
    isAdmin: isAdminEmail(user.email),
  });
});

// POST /api/auth/password/change
auth.post('/password/change', requireUser, async (c) => {
  const user = (c as { get: (k: string) => unknown }).get('user') as typeof users.$inferSelect;
  const body = await c.req.json().catch(() => null);
  const { currentPassword, newPassword } = body ?? {};

  if (!currentPassword || !newPassword) return c.json({ error: 'Missing fields' }, 400);
  if (newPassword.length < 8) return c.json({ error: 'Password too short' }, 400);

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    return c.json({ error: 'Invalid current password' }, 401);
  }

  const newHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, user.id));

  await logEvent({
    action: 'password_change',
    userId: user.id,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ success: true });
});

export { auth as authRouter };
