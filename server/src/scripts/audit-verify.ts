#!/usr/bin/env bun
/**
 * Verify the tamper-evident hash chain for a user's data_events.
 * Usage: bun run audit:verify -- --user <uuid>
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { asc, eq } from 'drizzle-orm';
import { dataEvents } from '../db/schema';
import { computeEventHash, type HashEnvelopeInput } from '../services/eventChain';
import { resolveDatabaseUrl } from '../db/connection';

const args = process.argv.slice(2);
const userIdx = args.indexOf('--user');
if (userIdx === -1 || !args[userIdx + 1]) {
  console.error('Usage: bun src/scripts/audit-verify.ts -- --user <uuid>');
  process.exit(1);
}
const userId = args[userIdx + 1];

const connectionString = resolveDatabaseUrl();

const pg = postgres(connectionString, { max: 1 });
const db = drizzle(pg);

const rows = await db
  .select()
  .from(dataEvents)
  .where(eq(dataEvents.userId, userId))
  .orderBy(asc(dataEvents.seq));

let prev = '';
let ok = true;
for (const r of rows) {
  if (r.prevHash !== prev) {
    console.error(`Break at seq=${r.seq}: expected prevHash=${prev}, got ${r.prevHash}`);
    ok = false;
    break;
  }
  const input: HashEnvelopeInput = {
    userId,
    clientEventId: r.clientEventId,
    seq: r.seq,
    serverReceivedAt: r.serverReceivedAt.toISOString(),
    ipHash: r.ipHash,
    gpsLat: r.gpsLat,
    gpsLon: r.gpsLon,
    gpsAccuracyM: r.gpsAccuracyM,
    gpsCapturedAt: r.gpsCapturedAt?.toISOString() ?? null,
    isClinical: r.isClinical,
    ciphertext: r.ciphertext,
    iv: r.iv,
  };
  const expected = computeEventHash(prev, input);
  if (expected !== r.hash) {
    console.error(`Hash mismatch at seq=${r.seq}`);
    ok = false;
    break;
  }
  prev = r.hash;
}

await pg.end({ timeout: 2 });

if (!ok) {
  process.exit(1);
}
console.log(`Verified ${rows.length} events for user ${userId}`);
process.exit(0);
