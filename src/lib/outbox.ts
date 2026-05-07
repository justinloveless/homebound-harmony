/**
 * Local event outbox + metadata for offline-first sync.
 * Queued rows POST to /api/events; successful applies update lastAppliedSeq.
 */

import { api, ApiError } from './api';
import { encryptJson, decryptJson } from './crypto';
import type { Event } from '@/types/events';
import { isClinicalKind } from '@/types/events';
import type { EventGps } from '@/types/events';
import { getSchedulerDB, STORES } from './storage';

export interface OutboxRow {
  clientEventId: string;
  clientClaimedAt: string;
  isClinical: boolean;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAccuracyM: number | null;
  gpsCapturedAt: string | null;
  gpsStaleSeconds: number | null;
  ciphertext: string;
  iv: string;
  /** Monotonic enqueue order */
  order: number;
}

export interface EventsMeta {
  lastAppliedSeq: number;
  lastSnapshotSeq: number;
  lastSnapshotAtMs: number;
  outboxOrder: number;
}

const defaultMeta = (): EventsMeta => ({
  lastAppliedSeq: 0,
  lastSnapshotSeq: 0,
  /** Avoid immediate rollup on first load (24h clock starts now). */
  lastSnapshotAtMs: Date.now(),
  outboxOrder: 0,
});

const META_KEY = 'events';

export async function getEventsMeta(): Promise<EventsMeta> {
  const db = await getSchedulerDB();
  const m = await db.get(STORES.meta, META_KEY);
  return m ?? defaultMeta();
}

async function putEventsMeta(m: EventsMeta): Promise<void> {
  const db = await getSchedulerDB();
  await db.put(STORES.meta, m, META_KEY);
}

export async function setLastAppliedSeq(seq: number): Promise<void> {
  const m = await getEventsMeta();
  m.lastAppliedSeq = Math.max(m.lastAppliedSeq, seq);
  await putEventsMeta(m);
}

export async function setLastSnapshotSeq(seq: number): Promise<void> {
  const m = await getEventsMeta();
  m.lastSnapshotSeq = seq;
  m.lastSnapshotAtMs = Date.now();
  await putEventsMeta(m);
}

/** Encrypt and queue one event (clinical kinds should pass `gps` when available). */
export async function enqueueEvent(
  ev: Event,
  wk: CryptoKey,
  gps?: EventGps | null,
): Promise<void> {
  const enc = await encryptJson(ev, wk);
  const clinical = isClinicalKind(ev.kind);
  const db = await getSchedulerDB();
  const meta = await getEventsMeta();
  meta.outboxOrder += 1;
  const row: OutboxRow = {
    clientEventId: ev.clientEventId,
    clientClaimedAt: ev.claimedAt,
    isClinical: clinical,
    gpsLat: clinical && gps ? gps.lat : null,
    gpsLon: clinical && gps ? gps.lon : null,
    gpsAccuracyM: clinical && gps ? gps.accuracyM : null,
    gpsCapturedAt: clinical && gps ? gps.capturedAt : null,
    gpsStaleSeconds: clinical && gps?.staleSeconds != null ? gps.staleSeconds : null,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    order: meta.outboxOrder,
  };
  await db.put(STORES.outbox, row);
  await putEventsMeta(meta);
}

export async function listOutboxOrdered(): Promise<OutboxRow[]> {
  const db = await getSchedulerDB();
  const all = await db.getAll(STORES.outbox);
  return (all as OutboxRow[]).sort((a, b) => a.order - b.order);
}

export async function removeOutboxRow(clientEventId: string): Promise<void> {
  const db = await getSchedulerDB();
  await db.delete(STORES.outbox, clientEventId);
}

export interface WireEventPayload {
  clientEventId: string;
  clientClaimedAt: string;
  isClinical: boolean;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAccuracyM: number | null;
  gpsCapturedAt: string | null;
  gpsStaleSeconds: number | null;
  ciphertext: string;
  iv: string;
}

/** POST queued events; removes successful rows from outbox. */
export async function drainOutbox(): Promise<void> {
  const rows = await listOutboxOrdered();
  if (rows.length === 0) return;

  const body = {
    events: rows.map(
      (r): WireEventPayload => ({
        clientEventId: r.clientEventId,
        clientClaimedAt: r.clientClaimedAt,
        isClinical: r.isClinical,
        gpsLat: r.gpsLat,
        gpsLon: r.gpsLon,
        gpsAccuracyM: r.gpsAccuracyM,
        gpsCapturedAt: r.gpsCapturedAt,
        gpsStaleSeconds: r.gpsStaleSeconds,
        ciphertext: r.ciphertext,
        iv: r.iv,
      }),
    ),
  };

  try {
    const res = await api.post<{ accepted: { clientEventId: string; seq: number; hash: string; serverReceivedAt: string }[] }>(
      '/api/events',
      body,
    );
    const acceptedIds = new Set(res.accepted.map((a) => a.clientEventId));
    for (const r of rows) {
      if (acceptedIds.has(r.clientEventId)) {
        await removeOutboxRow(r.clientEventId);
      }
    }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) throw e;
    console.warn('drainOutbox failed', e);
  }
}

export interface ServerEventRow {
  clientEventId: string;
  seq: number;
  prevHash: string;
  hash: string;
  ciphertext: string;
  iv: string;
  clientClaimedAt: string;
  serverReceivedAt: string;
  isClinical: boolean;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAccuracyM: number | null;
  gpsCapturedAt: string | null;
  gpsStaleSeconds: number | null;
}

export async function pullEventsSince(sinceSeq: number): Promise<ServerEventRow[]> {
  const res = await api.get<{ events: ServerEventRow[] }>(`/api/events?since=${sinceSeq}&limit=500`);
  return res.events ?? [];
}

export async function decryptServerEvents(rows: ServerEventRow[], wk: CryptoKey): Promise<Event[]> {
  const out: Event[] = [];
  for (const r of rows) {
    try {
      const ev = await decryptJson<Event>({ ciphertext: r.ciphertext, iv: r.iv }, wk);
      out.push(ev);
    } catch (e) {
      console.error('Failed to decrypt event', r.seq, e);
    }
  }
  return out;
}
