/**
 * Idempotent dev/review seed: creates apple.test@gmail.com / Password1234 with
 * MFA disabled and valid client-compatible wrapped workspace keys.
 *
 * Platform admin UI requires listing this email in ADMIN_EMAILS / ADMIN_EMAIL.
 *
 * Run after migrations: `cd server && bun run db:seed`
 *
 * Recovery key hex (for recovery flow / ops): see SEED_RECOVERY_KEY_HEX in seedCrypto.ts
 */
import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/argon';
import { pg, db } from '../db/client';
import { users, workspaces, workspaceMembers, workspaceKeyWraps, workspaceSnapshots, userEventChain } from '../db/schema';
import { buildClientCompatibleWraps, SEED_RECOVERY_KEY_HEX } from './seedCrypto';

const SEED_EMAIL = 'apple.test@gmail.com';
const SEED_PASSWORD = 'Password1234';

async function main() {
  const normalizedEmail = SEED_EMAIL.toLowerCase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
  if (existing.length > 0) {
    console.log(`Seed skipped: ${normalizedEmail} already exists`);
    await pg.end({ timeout: 5 });
    process.exit(0);
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const { pdkSalt, recoveryKeyHash, wrappedWorkspaceKey, wrappedWorkspaceKeyRecovery } =
    await buildClientCompatibleWraps(SEED_PASSWORD);

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

  const userId = user.id;
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

  console.log(`Seeded ${normalizedEmail} (password: ${SEED_PASSWORD}, mfaDisabled=true)`);
  console.log(`Recovery key hex (no spaces): ${SEED_RECOVERY_KEY_HEX}`);

  await pg.end({ timeout: 5 });
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pg.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
