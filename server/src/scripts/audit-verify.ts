#!/usr/bin/env bun
/**
 * Verify the tamper-evident hash chain for a workspace's data_events.
 * Usage: bun run audit:verify -- --workspace <uuid>
 * (Legacy: --user <uuid> is accepted as an alias for the workspace id.)
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { asc, eq } from 'drizzle-orm';
import { dataEvents } from '../db/schema';
import { computeEventHash, type HashEnvelopeInput } from '../services/eventChain';
import { resolveDatabaseUrl } from '../db/connection';

const args = process.argv.slice(2);
let workspaceId: string | undefined;
const wsIdx = args.indexOf('--workspace');
const userIdx = args.indexOf('--user');
if (wsIdx !== -1 && args[wsIdx + 1]) workspaceId = args[wsIdx + 1];
else if (userIdx !== -1 && args[userIdx + 1]) workspaceId = args[userIdx + 1];

if (!workspaceId) {
  console.error('Usage: bun src/scripts/audit-verify.ts -- --workspace <uuid>');
  process.exit(1);
}

const connectionString = resolveDatabaseUrl();

const pg = postgres(connectionString, { max: 1 });
const db = drizzle(pg);

const rows = await db
  .select()
  .from(dataEvents)
  .where(eq(dataEvents.workspaceId, workspaceId))
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
    userId: workspaceId,
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
console.log(`Verified ${rows.length} events for workspace ${workspaceId}`);
process.exit(0);
