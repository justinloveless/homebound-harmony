#!/usr/bin/env bun
/**
 * Verify domain_events rows are strictly ordered by seq for a tenant.
 *
 *   bun run audit:verify -- --tenant <uuid>
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { asc, eq } from 'drizzle-orm';
import { domainEvents } from '../db/schema';
import { resolveDatabaseUrl } from '../db/connection';

const args = process.argv.slice(2);
let tenantId: string | undefined;
const tIdx = args.indexOf('--tenant');
if (tIdx !== -1 && args[tIdx + 1]) tenantId = args[tIdx + 1];

if (!tenantId) {
  console.error('Usage: bun src/scripts/audit-verify.ts -- --tenant <uuid>');
  process.exit(1);
}

const connectionString = resolveDatabaseUrl();

const pg = postgres(connectionString, { max: 1 });
const db = drizzle(pg);

const rows = await db
  .select()
  .from(domainEvents)
  .where(eq(domainEvents.tenantId, tenantId))
  .orderBy(asc(domainEvents.seq));

let prev = -1;
let ok = true;
for (const r of rows) {
  if (r.seq <= prev) {
    console.error(`Non-monotonic seq at id=${r.id}: seq=${r.seq} prev=${prev}`);
    ok = false;
    break;
  }
  prev = r.seq;
}

await pg.end({ timeout: 2 });

if (!ok) {
  process.exit(1);
}
console.log(`Verified ${rows.length} domain_events for tenant ${tenantId}`);
process.exit(0);
