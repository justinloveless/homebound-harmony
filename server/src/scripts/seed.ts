/**
 * Idempotent dev/review seed: ensures apple.test@gmail.com exists with password Password1234,
 * MFA disabled, and client-compatible wrapped workspace keys.
 *
 * **Docker / production:** runs automatically after migrations when the API boots (`RUN_SEED_ON_BOOT`
 * is not `false`). Same Postgres as `DATABASE_URL`.
 *
 * **Manual:** `cd server && bun run db:seed`
 *
 * Platform admin UI requires listing this email in ADMIN_EMAILS / ADMIN_EMAIL.
 *
 * For optional host-published Postgres (`docker-compose.local.yaml`), bind defaults to `127.0.0.1:55432`.
 *
 * Recovery key hex (for recovery flow / ops): see SEED_RECOVERY_KEY_HEX in seedCrypto.ts
 */
import { and, eq } from 'drizzle-orm';
import { hashPassword } from '../auth/argon';
import { pg, db } from '../db/client';
import { resolveDatabaseUrl } from '../db/connection';
import {
  users,
  workspaces,
  workspaceMembers,
  workspaceKeyWraps,
  workspaceSnapshots,
  userEventChain,
} from '../db/schema';
import { buildClientCompatibleWraps, SEED_RECOVERY_KEY_HEX } from './seedCrypto';

const SEED_EMAIL = 'apple.test@gmail.com';
const SEED_PASSWORD = 'Password1234';

async function upsertSeedWorkspaceRows(params: {
  userId: string;
  wsId: string;
  wrappedWorkspaceKey: string;
  wrappedWorkspaceKeyRecovery: string;
}) {
  const { userId, wsId, wrappedWorkspaceKey, wrappedWorkspaceKeyRecovery } = params;

  const wsRow = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, wsId)).limit(1);
  if (wsRow.length === 0) {
    await db.insert(workspaces).values({ id: wsId });
  }

  const memberRow = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (memberRow.length === 0) {
    await db.insert(workspaceMembers).values({ workspaceId: wsId, userId, role: 'owner' });
  }

  const wrapRow = await db
    .select({ workspaceId: workspaceKeyWraps.workspaceId })
    .from(workspaceKeyWraps)
    .where(
      and(
        eq(workspaceKeyWraps.workspaceId, wsId),
        eq(workspaceKeyWraps.userId, userId),
        eq(workspaceKeyWraps.keyEpoch, 0),
      ),
    )
    .limit(1);
  if (wrapRow.length === 0) {
    await db.insert(workspaceKeyWraps).values({
      workspaceId: wsId,
      userId,
      keyEpoch: 0,
      wrappedWorkspaceKey,
    });
  } else {
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
  }

  const snapRow = await db
    .select({ workspaceId: workspaceSnapshots.workspaceId })
    .from(workspaceSnapshots)
    .where(eq(workspaceSnapshots.workspaceId, wsId))
    .limit(1);
  if (snapRow.length === 0) {
    await db.insert(workspaceSnapshots).values({
      workspaceId: wsId,
      wrappedWorkspaceKeyRecovery,
      ciphertext: '',
      iv: '',
    });
  } else {
    await db
      .update(workspaceSnapshots)
      .set({ wrappedWorkspaceKeyRecovery, updatedAt: new Date() })
      .where(eq(workspaceSnapshots.workspaceId, wsId));
  }

  const chainRow = await db
    .select({ workspaceId: userEventChain.workspaceId })
    .from(userEventChain)
    .where(eq(userEventChain.workspaceId, wsId))
    .limit(1);
  if (chainRow.length === 0) {
    await db.insert(userEventChain).values({ workspaceId: wsId, headSeq: 0, headHash: '' });
  }
}

/** Does not close the shared `pg` pool — safe when called from `index.ts` before serving. */
export async function runSeed(): Promise<void> {
  let dbTarget = '(unknown)';
  try {
    const u = new URL(resolveDatabaseUrl());
    dbTarget = `${u.hostname}:${u.port || '5432'}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    /* ignore */
  }
  console.log(`Seed target DB: ${dbTarget}`);

  const normalizedEmail = SEED_EMAIL.toLowerCase();

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const { pdkSalt, recoveryKeyHash, wrappedWorkspaceKey, wrappedWorkspaceKeyRecovery } =
    await buildClientCompatibleWraps(SEED_PASSWORD);

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);

  let userId: string;

  if (existing.length > 0) {
    userId = existing[0].id;
    await db
      .update(users)
      .set({
        passwordHash,
        pdkSalt,
        recoveryKeyHash,
        totpSecretEncrypted: null,
        mfaDisabled: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    console.log(`Seed refreshed credentials for ${normalizedEmail}`);
  } else {
    const [user] = await db
      .insert(users)
      .values({
        email: normalizedEmail,
        passwordHash,
        pdkSalt,
        recoveryKeyHash,
        mfaDisabled: true,
        totpSecretEncrypted: null,
      })
      .returning({ id: users.id });
    userId = user.id;
    console.log(`Seeded new user ${normalizedEmail}`);
  }

  const wsId = userId;
  await upsertSeedWorkspaceRows({ userId, wsId, wrappedWorkspaceKey, wrappedWorkspaceKeyRecovery });

  console.log(`Review account ready: ${normalizedEmail} / ${SEED_PASSWORD} (mfaDisabled=true)`);
  console.log(`Recovery key hex (no spaces): ${SEED_RECOVERY_KEY_HEX}`);
}

async function cliMain() {
  try {
    await runSeed();
    await pg.end({ timeout: 5 });
    process.exit(0);
  } catch (err) {
    console.error(err);
    await pg.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  }
}

if (import.meta.main) {
  cliMain();
}
