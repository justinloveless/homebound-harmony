import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db } from '../db/client';
import { users, workspaceBlobs } from '../db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword, encryptTotpSecret, decryptTotpSecret } from '../auth/argon';
import { generateTotpSecret, verifyTotpCode, generateQrDataUrl } from '../auth/totp';
import { createSession, deleteSession } from '../auth/session';
import { requireUser } from '../auth/middleware';
import { SESSION_COOKIE, SECURE_COOKIES } from '../auth/cookie';
import { logEvent } from '../services/audit';
import { timingSafeEqual } from 'crypto';

const auth = new Hono();

// In-memory rate limiting: 10 failed attempts in 15 min
const loginAttempts = new Map<string, { count: number; firstAt: number }>();
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_THRESHOLD = 10;

function checkLockout(email: string): boolean {
  const a = loginAttempts.get(email);
  if (!a) return false;
  if (Date.now() - a.firstAt > LOCKOUT_WINDOW_MS) { loginAttempts.delete(email); return false; }
  return a.count >= LOCKOUT_THRESHOLD;
}
function recordFail(email: string) {
  const a = loginAttempts.get(email);
  if (!a) loginAttempts.set(email, { count: 1, firstAt: Date.now() });
  else a.count++;
}
function clearFails(email: string) { loginAttempts.delete(email); }

// In-memory registration tokens (userId → token, valid 1h)
const registrationTokens = new Map<string, { userId: string; expiresAt: number }>();
function createRegToken(userId: string): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  registrationTokens.set(token, { userId, expiresAt: Date.now() + 60 * 60 * 1000 });
  return token;
}
function useRegToken(token: string): string | null {
  const entry = registrationTokens.get(token);
  if (!entry || Date.now() > entry.expiresAt) { registrationTokens.delete(token); return null; }
  return entry.userId;
}

function getClientIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
}

function setCookieSession(c: any, sessionId: string) {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
}

// POST /api/auth/register
auth.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid request' }, 400);

  const { email, password, pdkSalt, recoveryKeyHash, wrappedWorkspaceKey, wrappedWorkspaceKeyRecovery } = body;
  if (!email || !password || !pdkSalt || !recoveryKeyHash || !wrappedWorkspaceKey || !wrappedWorkspaceKeyRecovery) {
    return c.json({ error: 'Missing fields' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Invalid email' }, 400);
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase()));
  if (existing.length > 0) return c.json({ error: 'Email already in use' }, 409);

  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(users).values({
    email: email.toLowerCase(),
    passwordHash,
    pdkSalt,
    recoveryKeyHash,
  }).returning({ id: users.id });

  await db.insert(workspaceBlobs).values({
    userId: user.id,
    wrappedWorkspaceKey,
    wrappedWorkspaceKeyRecovery,
  });

  const registrationToken = createRegToken(user.id);
  return c.json({ registrationToken }, 201);
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

  // Re-create the token so the caller can use it for verify step
  const newToken = createRegToken(userId);
  const qrCode = await generateQrDataUrl(otpauth);

  return c.json({ registrationToken: newToken, secret, otpauth, qrCode });
});

// POST /api/auth/totp/verify  (during registration — completes enrollment)
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

  await logEvent({ action: 'totp_enroll', userId, ip: getClientIp(c), userAgent: c.req.header('user-agent') });
  return c.json({ success: true });
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const { email, password, code } = body ?? {};
  if (!email || !password || !code) return c.json({ error: 'Missing fields' }, 400);

  const normalEmail = email.toLowerCase();

  if (checkLockout(normalEmail)) {
    return c.json({ error: 'Account locked. Try again in 15 minutes.' }, 429);
  }

  const rows = await db.select().from(users).where(eq(users.email, normalEmail));
  const user = rows[0];

  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    recordFail(normalEmail);
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  if (!user.totpSecretEncrypted) {
    return c.json({ error: 'TOTP enrollment incomplete. Please complete registration.' }, 403);
  }

  const secret = await decryptTotpSecret(user.totpSecretEncrypted);
  if (!verifyTotpCode(secret, code)) {
    recordFail(normalEmail);
    return c.json({ error: 'Invalid TOTP code' }, 401);
  }

  clearFails(normalEmail);
  const sessionId = await createSession(user.id);
  setCookieSession(c, sessionId);

  await logEvent({ action: 'login', userId: user.id, ip: getClientIp(c), userAgent: c.req.header('user-agent') });
  return c.json({ pdkSalt: user.pdkSalt });
});

// POST /api/auth/logout
auth.post('/logout', requireUser, async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await deleteSession(sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  const userId = (c as any).get('userId');
  await logEvent({ action: 'logout', userId, ip: getClientIp(c), userAgent: c.req.header('user-agent') });
  return c.json({ success: true });
});

// GET /api/auth/me
auth.get('/me', requireUser, async (c) => {
  const user = (c as any).get('user') as typeof users.$inferSelect;
  return c.json({
    id: user.id,
    email: user.email,
    pdkSalt: user.pdkSalt,
    totpEnrolled: !!user.totpSecretEncrypted,
  });
});

// POST /api/auth/password/change
auth.post('/password/change', requireUser, async (c) => {
  const user = (c as any).get('user') as typeof users.$inferSelect;
  const body = await c.req.json().catch(() => null);
  const { currentPassword, newPassword, newPdkSalt, newWrappedWorkspaceKey, newWrappedWorkspaceKeyRecovery } = body ?? {};

  if (!currentPassword || !newPassword || !newPdkSalt || !newWrappedWorkspaceKey || !newWrappedWorkspaceKeyRecovery) {
    return c.json({ error: 'Missing fields' }, 400);
  }
  if (newPassword.length < 8) return c.json({ error: 'Password too short' }, 400);

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    return c.json({ error: 'Invalid current password' }, 401);
  }

  const newHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash: newHash, pdkSalt: newPdkSalt, updatedAt: new Date() }).where(eq(users.id, user.id));
  await db.update(workspaceBlobs)
    .set({ wrappedWorkspaceKey: newWrappedWorkspaceKey, wrappedWorkspaceKeyRecovery: newWrappedWorkspaceKeyRecovery, updatedAt: new Date() })
    .where(eq(workspaceBlobs.userId, user.id));

  await logEvent({ action: 'password_change', userId: user.id, ip: getClientIp(c), userAgent: c.req.header('user-agent') });
  return c.json({ success: true });
});

// POST /api/auth/recovery/init
// Public lookup: given email + recoveryKeyHash, returns the salt and the
// recovery-wrapped workspace key the client needs to derive the new
// envelope. Returns 401 on mismatch so we don't confirm account existence.
auth.post('/recovery/init', async (c) => {
  const body = await c.req.json().catch(() => null);
  const { email, recoveryKeyHash } = body ?? {};
  if (!email || !recoveryKeyHash) return c.json({ error: 'Missing fields' }, 400);

  const rows = await db.select().from(users).where(eq(users.email, String(email).toLowerCase()));
  const user = rows[0];
  if (!user) return c.json({ error: 'Invalid recovery info' }, 401);

  const storedBuf = Buffer.from(user.recoveryKeyHash, 'hex');
  const providedBuf = Buffer.from(recoveryKeyHash, 'hex');
  if (storedBuf.length !== providedBuf.length || !timingSafeEqual(storedBuf, providedBuf)) {
    return c.json({ error: 'Invalid recovery info' }, 401);
  }

  const blobs = await db.select().from(workspaceBlobs).where(eq(workspaceBlobs.userId, user.id));
  const blob = blobs[0];
  if (!blob) return c.json({ error: 'Workspace missing' }, 500);

  return c.json({
    pdkSalt: user.pdkSalt,
    wrappedWorkspaceKeyRecovery: blob.wrappedWorkspaceKeyRecovery,
  });
});

// POST /api/auth/recovery
auth.post('/recovery', async (c) => {
  const body = await c.req.json().catch(() => null);
  const { email, recoveryKeyHash, newPassword, newPdkSalt, newWrappedWorkspaceKey } = body ?? {};

  if (!email || !recoveryKeyHash || !newPassword || !newPdkSalt || !newWrappedWorkspaceKey) {
    return c.json({ error: 'Missing fields' }, 400);
  }
  if (newPassword.length < 8) return c.json({ error: 'Password too short' }, 400);

  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  const user = rows[0];
  if (!user) return c.json({ error: 'Invalid credentials' }, 401);

  // Timing-safe comparison of recovery key hashes
  const storedBuf = Buffer.from(user.recoveryKeyHash, 'hex');
  const providedBuf = Buffer.from(recoveryKeyHash, 'hex');
  if (storedBuf.length !== providedBuf.length || !timingSafeEqual(storedBuf, providedBuf)) {
    return c.json({ error: 'Invalid recovery key' }, 401);
  }

  const newHash = await hashPassword(newPassword);
  await db.update(users)
    .set({ passwordHash: newHash, pdkSalt: newPdkSalt, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await db.update(workspaceBlobs)
    .set({ wrappedWorkspaceKey: newWrappedWorkspaceKey, updatedAt: new Date() })
    .where(eq(workspaceBlobs.userId, user.id));

  await logEvent({ action: 'recovery_used', userId: user.id, ip: getClientIp(c), userAgent: c.req.header('user-agent') });
  return c.json({ success: true });
});

export { auth as authRouter };
