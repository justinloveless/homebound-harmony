import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { db } from '../db/client';
import { users, workspaces, workspaceMembers, workspaceKeyWraps, workspaceSnapshots, userEventChain, auditEvents } from '../db/schema';
import { hashPassword, verifyPassword, encryptTotpSecret, decryptTotpSecret } from '../auth/argon';
import { generateTotpSecret, verifyTotpCode, generateQrDataUrl } from '../auth/totp';
import { createSession, deleteSession } from '../auth/session';
import { requireUser } from '../auth/middleware';
import { isAdminEmail } from '../auth/admin';
import { isMfaDisabledEmail } from '../auth/mfaBypass';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from '../auth/cookie';
import { logEvent } from '../services/audit';
import { timingSafeEqual } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { listActiveWorkspaceIdsForUser } from '../services/workspaceContext';

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

  const passwordHash = await hashPassword(password);
  const normalizedEmail = email.toLowerCase();

  const existing = await db
    .select({ id: users.id, mfaDisabled: users.mfaDisabled })
    .from(users)
    .where(eq(users.email, normalizedEmail));

  let userId: string;
  if (existing.length > 0) {
    // An email already has a row, but the signup may have been abandoned
    // before the account became usable. MFA-disabled review accounts (per
    // column or env allowlist) are considered finalized even without a TOTP
    // enrollment audit event.
    const mfaDisabled = existing[0].mfaDisabled || isMfaDisabledEmail(normalizedEmail);
    const finalized = mfaDisabled ? [{ id: existing[0].id }] : await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.userId, existing[0].id), eq(auditEvents.action, 'totp_enroll')))
      .limit(1);
    if (finalized.length > 0) return c.json({ error: 'Email already in use' }, 409);

    userId = existing[0].id;
    await db.update(users).set({
      passwordHash,
      pdkSalt,
      recoveryKeyHash,
      totpSecretEncrypted: null,
      mfaDisabled: false,
      updatedAt: new Date(),
    }).where(eq(users.id, userId));
    const wsId = userId;
    await db.update(workspaceSnapshots).set({
      wrappedWorkspaceKeyRecovery,
      updatedAt: new Date(),
    }).where(eq(workspaceSnapshots.workspaceId, wsId));
    await db
      .update(workspaceKeyWraps)
      .set({ wrappedWorkspaceKey, createdAt: new Date() })
      .where(
        and(
          eq(workspaceKeyWraps.workspaceId, wsId),
          eq(workspaceKeyWraps.userId, userId),
          eq(workspaceKeyWraps.keyEpoch, 0),
        ),
      );
  } else {
    const [user] = await db.insert(users).values({
      email: normalizedEmail,
      passwordHash,
      pdkSalt,
      recoveryKeyHash,
    }).returning({ id: users.id });
    userId = user.id;
    const wsId = userId;

    await db.insert(workspaces).values({ id: wsId });
    await db.insert(workspaceMembers).values({ workspaceId: wsId, userId, role: 'owner' });
    await db.insert(workspaceKeyWraps).values({
      workspaceId: wsId,
      userId,
      keyEpoch: 0,
      wrappedWorkspaceKey,
    });
    await db.insert(workspaceSnapshots).values({
      workspaceId: wsId,
      wrappedWorkspaceKeyRecovery,
      ciphertext: '',
      iv: '',
    });
    await db.insert(userEventChain).values({ workspaceId: wsId, headSeq: 0, headHash: '' });
  }

  const registrationToken = createRegToken(userId);
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
  if (!email || !password) return c.json({ error: 'Missing fields' }, 400);

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

  const mfaDisabled = user.mfaDisabled || isMfaDisabledEmail(user.email);
  if (!mfaDisabled) {
    if (!user.totpSecretEncrypted) {
      return c.json({ error: 'TOTP enrollment incomplete. Please complete registration.' }, 403);
    }
    if (!code) return c.json({ error: 'Missing TOTP code' }, 400);

    const secret = await decryptTotpSecret(user.totpSecretEncrypted);
    if (!verifyTotpCode(secret, code)) {
      recordFail(normalEmail);
      return c.json({ error: 'Invalid TOTP code' }, 401);
    }
  }

  clearFails(normalEmail);
  const sessionId = await createSession(user.id);
  setSessionCookie(c, sessionId);

  await logEvent({ action: 'login', userId: user.id, ip: getClientIp(c), userAgent: c.req.header('user-agent') });
  return c.json({ pdkSalt: user.pdkSalt });
});

// POST /api/auth/logout
auth.post('/logout', requireUser, async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await deleteSession(sessionId);
  clearSessionCookie(c);
  const userId = (c as any).get('userId');
  await logEvent({ action: 'logout', userId, ip: getClientIp(c), userAgent: c.req.header('user-agent') });
  return c.json({ success: true });
});

// GET /api/auth/lookup-user?email=  (for workspace invites)
auth.get('/lookup-user', requireUser, async (c) => {
  const email = c.req.query('email')?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Invalid email' }, 400);
  }
  const rows = await db
    .select({ id: users.id, email: users.email, masterPublicKey: users.masterPublicKey })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const u = rows[0];
  if (!u) return c.json({ error: 'User not found' }, 404);
  return c.json({
    id: u.id,
    email: u.email,
    masterPublicKey: u.masterPublicKey,
  });
});

// PATCH /api/auth/me/device-key  { masterPublicKey }
auth.patch('/me/device-key', requireUser, async (c) => {
  const user = (c as any).get('user') as typeof users.$inferSelect;
  const body = await c.req.json().catch(() => null);
  const masterPublicKey = body?.masterPublicKey;
  if (typeof masterPublicKey !== 'string' || !masterPublicKey.trim()) {
    return c.json({ error: 'Missing masterPublicKey' }, 400);
  }
  await db
    .update(users)
    .set({ masterPublicKey: masterPublicKey.trim(), updatedAt: new Date() })
    .where(eq(users.id, user.id));
  return c.json({ success: true });
});

// GET /api/auth/me
auth.get('/me', requireUser, async (c) => {
  const user = (c as any).get('user') as typeof users.$inferSelect;
  c.header('X-Min-Client-Version', process.env.MIN_CLIENT_VERSION ?? '2026.5.6');
  c.header('Cache-Control', 'no-store, private');
  return c.json({
    id: user.id,
    email: user.email,
    pdkSalt: user.pdkSalt,
    totpEnrolled: !!user.totpSecretEncrypted,
    mfaDisabled: user.mfaDisabled || isMfaDisabledEmail(user.email),
    isAdmin: isAdminEmail(user.email),
  });
});

// POST /api/auth/password/change
auth.post('/password/change', requireUser, async (c) => {
  const user = (c as any).get('user') as typeof users.$inferSelect;
  const body = await c.req.json().catch(() => null);
  const {
    currentPassword,
    newPassword,
    newPdkSalt,
    newWrappedWorkspaceKey,
    newWrappedWorkspaceKeyRecovery,
    workspaceId: bodyWorkspaceId,
  } = body ?? {};

  if (!currentPassword || !newPassword || !newPdkSalt || !newWrappedWorkspaceKey || !newWrappedWorkspaceKeyRecovery) {
    return c.json({ error: 'Missing fields' }, 400);
  }
  if (newPassword.length < 8) return c.json({ error: 'Password too short' }, 400);

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    return c.json({ error: 'Invalid current password' }, 401);
  }

  let workspaceId = typeof bodyWorkspaceId === 'string' ? bodyWorkspaceId : undefined;
  if (!workspaceId) {
    const ids = await listActiveWorkspaceIdsForUser(user.id);
    if (ids.length !== 1) {
      return c.json({ error: 'Pass workspaceId when you belong to multiple workspaces' }, 400);
    }
    workspaceId = ids[0];
  } else {
    const m = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, user.id),
          isNull(workspaceMembers.revokedAt),
        ),
      )
      .limit(1);
    if (!m[0]) return c.json({ error: 'Not a member of this workspace' }, 403);
  }

  const snaps = await db.select().from(workspaceSnapshots).where(eq(workspaceSnapshots.workspaceId, workspaceId)).limit(1);
  const snap = snaps[0];
  if (!snap) return c.json({ error: 'Workspace not found' }, 404);

  const newHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash: newHash, pdkSalt: newPdkSalt, updatedAt: new Date() }).where(eq(users.id, user.id));
  await db
    .update(workspaceKeyWraps)
    .set({ wrappedWorkspaceKey: newWrappedWorkspaceKey, createdAt: new Date() })
    .where(
      and(
        eq(workspaceKeyWraps.workspaceId, workspaceId),
        eq(workspaceKeyWraps.userId, user.id),
        eq(workspaceKeyWraps.keyEpoch, snap.keyEpoch),
      ),
    );
  await db
    .update(workspaceSnapshots)
    .set({ wrappedWorkspaceKeyRecovery: newWrappedWorkspaceKeyRecovery, updatedAt: new Date() })
    .where(eq(workspaceSnapshots.workspaceId, workspaceId));

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

  const blobs = await db.select().from(workspaceSnapshots).where(eq(workspaceSnapshots.workspaceId, user.id));
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
  const snaps = await db.select().from(workspaceSnapshots).where(eq(workspaceSnapshots.workspaceId, user.id)).limit(1);
  const snap = snaps[0];
  if (!snap) return c.json({ error: 'Workspace missing' }, 500);

  await db
    .update(workspaceKeyWraps)
    .set({ wrappedWorkspaceKey: newWrappedWorkspaceKey, createdAt: new Date() })
    .where(
      and(
        eq(workspaceKeyWraps.workspaceId, user.id),
        eq(workspaceKeyWraps.userId, user.id),
        eq(workspaceKeyWraps.keyEpoch, snap.keyEpoch),
      ),
    );

  await logEvent({ action: 'recovery_used', userId: user.id, ip: getClientIp(c), userAgent: c.req.header('user-agent') });
  return c.json({ success: true });
});

export { auth as authRouter };
