/**
 * Verify seeded review credentials against the current DATABASE_URL.
 * Exits 0 only if apple.test@gmail.com exists and Password1234 verifies.
 *
 *   docker compose exec app bun src/scripts/verifySeedCredentials.ts
 */
import { eq } from 'drizzle-orm';
import { verifyPassword } from '../auth/argon';
import { pg, db } from '../db/client';
import { resolveDatabaseUrl } from '../db/connection';
import { users } from '../db/schema';

const EMAIL = 'apple.test@gmail.com';
const PASSWORD = 'Password1234';

async function main() {
  let dbTarget = '(unknown)';
  try {
    const u = new URL(resolveDatabaseUrl());
    dbTarget = `${u.hostname}:${u.port || '5432'}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    /* ignore */
  }
  console.log(`Verify DB: ${dbTarget}`);

  const rows = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.email, EMAIL)).limit(1);
  const user = rows[0];
  if (!user) {
    console.error(`No row for ${EMAIL}. Run db:seed against this database.`);
    await pg.end({ timeout: 5 });
    process.exit(1);
  }

  const ok = await verifyPassword(user.passwordHash, PASSWORD);
  console.log(ok ? `Password OK for ${EMAIL}` : `Password FAILED for ${EMAIL} (re-run db:seed on this DB)`);

  await pg.end({ timeout: 5 });
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pg.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
