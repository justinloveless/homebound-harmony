/**
 * Idempotent dev/review seed: ensures apple.test@gmail.com exists with password Password1234,
 * MFA disabled, and client-compatible wrapped workspace keys.
 *
 * If the user row already exists (e.g. from an older signup), credentials and wraps are reset so the seeded password works.
 *
 * Platform admin UI requires listing this email in ADMIN_EMAILS / ADMIN_EMAIL.
 *
 * Run after migrations: `cd server && bun run db:seed`
 *
 * Recovery key hex (for recovery flow / ops): see SEED_RECOVERY_KEY_HEX in seedCrypto.ts
 */
import { and, eq } from 'drizzle-orm';
import { hashPassword } from '../auth/argon';
import { pg, db } from '../db/client';
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

async function main() {
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

  console.log(`Password: ${SEED_PASSWORD} (mfaDisabled=true)`);
  console.log(`Recovery key hex (no spaces): ${SEED_RECOVERY_KEY_HEX}`);

  await pg.end({ timeout: 5 });
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pg.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
