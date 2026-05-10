/**
 * Idempotent dev/review seed: ensures apple.test@gmail.com exists with password Password1234,
 * MFA disabled, admin on test tenant with worker profile.
 */
import { and, eq } from 'drizzle-orm';
import { hashPassword } from '../auth/argon';
import { pg, db } from '../db/client';
import { resolveDatabaseUrl } from '../db/connection';
import {
  tenants,
  tenantMembers,
  users,
  workers,
  tenantDomainChain,
} from '../db/schema';

const SEED_EMAIL = 'apple.test@gmail.com';
const SEED_PASSWORD = 'Password1234';
const SEED_TENANT_SLUG = 'test';
const SEED_TENANT_NAME = 'Test Clinic';

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

  let tenantRow = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, SEED_TENANT_SLUG)).limit(1);
  let tenantId: string;
  if (!tenantRow[0]) {
    const [t] = await db
      .insert(tenants)
      .values({ slug: SEED_TENANT_SLUG, name: SEED_TENANT_NAME })
      .returning({ id: tenants.id });
    tenantId = t.id;
    await db.insert(tenantDomainChain).values({ tenantId, headSeq: 0 });
    console.log(`Seed created tenant ${SEED_TENANT_SLUG}`);
  } else {
    tenantId = tenantRow[0].id;
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);

  let userId: string;

  if (existing.length > 0) {
    userId = existing[0].id;
    await db
      .update(users)
      .set({
        passwordHash,
        totpSecretEncrypted: null,
        mfaDisabled: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    console.log(`Seed refreshed credentials for ${normalizedEmail}`);
  } else {
    const [u] = await db
      .insert(users)
      .values({
        email: normalizedEmail,
        passwordHash,
        mfaDisabled: true,
      })
      .returning({ id: users.id });
    userId = u.id;
    console.log(`Seed created user ${normalizedEmail}`);
  }

  const mem = await db
    .select()
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
    .limit(1);
  if (!mem[0]) {
    await db.insert(tenantMembers).values({ tenantId, userId, role: 'admin' });
  } else if (mem[0].revokedAt) {
    await db
      .update(tenantMembers)
      .set({ revokedAt: null, role: 'admin' })
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));
  }

  const wk = await db
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.tenantId, tenantId), eq(workers.userId, userId)))
    .limit(1);
  if (!wk[0]) {
    await db.insert(workers).values({
      tenantId,
      userId,
      name: 'Seed Worker',
      homeAddress: '',
    });
  }

  console.log('Seed summary: tenant=test user=apple.test@gmail.com password=Password1234');
}

if (import.meta.main) {
  await runSeed();
  await pg.end();
  process.exit(0);
}
