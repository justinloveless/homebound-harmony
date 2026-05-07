// Workspace sync: snapshot + encrypted event tail + SSE on /api/events/stream.

import { api, ApiError, eventSource } from './api';
import {
  decryptJson,
  encryptJson,
  type EncryptedBlob,
} from './crypto';
import { DEFAULT_WORKSPACE, type Workspace } from '@/types/models';
import { loadWorkspace as loadCached, saveWorkspace as saveCached, migrateWorkspace } from './storage';
import { replayEvents } from './events';
import {
  drainOutbox,
  getEventsMeta,
  pullEventsSince,
  decryptServerEvents,
  setLastAppliedSeq,
  setLastSnapshotSeq,
} from './outbox';

export interface ServerSnapshot extends EncryptedBlob {
  wrappedWorkspaceKey: string;
  wrappedWorkspaceKeyRecovery: string;
  version: number;
  snapshotSeq: number;
}

export interface SyncState {
  workspace: Workspace;
  version: number;
  snapshotSeq: number;
}

const SNAPSHOT_EVENT_THRESHOLD = 100;
const SNAPSHOT_MS = 24 * 60 * 60 * 1000;

export async function fetchServerSnapshot(): Promise<ServerSnapshot> {
  return api.get<ServerSnapshot>('/api/snapshot');
}

/** Pull snapshot + replay events with seq > snapshotSeq; drain local outbox. */
export async function pullWorkspace(wk: CryptoKey): Promise<SyncState> {
  const blob = await fetchServerSnapshot();
  let ws: Workspace;
  if (!blob.ciphertext || !blob.iv) {
    ws = { ...DEFAULT_WORKSPACE };
  } else {
    const raw = await decryptJson<Workspace>(
      { ciphertext: blob.ciphertext, iv: blob.iv },
      wk,
    );
    ws = migrateWorkspace(raw);
  }

  const since = blob.snapshotSeq ?? 0;
  const rows = await pullEventsSince(since);
  const events = await decryptServerEvents(rows, wk);
  ws = replayEvents(ws, events);

  let maxSeq = blob.snapshotSeq ?? 0;
  for (const r of rows) maxSeq = Math.max(maxSeq, r.seq);
  await setLastAppliedSeq(maxSeq);

  await saveCached(ws);
  await drainOutbox().catch(() => {});

  return { workspace: ws, version: blob.version, snapshotSeq: since };
}

/** After local changes, try uploading a rollup snapshot if thresholds met. */
export async function maybeRollupSnapshot(
  ws: Workspace,
  wk: CryptoKey,
  currentVersion: number,
): Promise<number> {
  const meta = await getEventsMeta();
  const seq = meta.lastAppliedSeq;
  const needByCount = seq - meta.lastSnapshotSeq >= SNAPSHOT_EVENT_THRESHOLD;
  const needByTime = Date.now() - meta.lastSnapshotAtMs >= SNAPSHOT_MS;
  if (!needByCount && !needByTime) return currentVersion;

  const enc = await encryptJson(ws, wk);
  try {
    const res = await api.put<{ version: number; snapshotSeq: number }>(
      '/api/snapshot',
      { ciphertext: enc.ciphertext, iv: enc.iv, snapshotSeq: seq, version: currentVersion },
      { headers: { 'If-Match': `"${currentVersion}"` } },
    );
    await setLastSnapshotSeq(seq);
    return res.version;
  } catch (e) {
    if (e instanceof ApiError && e.status === 412) {
      const fresh = await pullWorkspace(wk);
      return fresh.version;
    }
    console.warn('Snapshot rollup failed', e);
    return currentVersion;
  }
}

export async function loadCachedWorkspace(): Promise<Workspace> {
  return loadCached();
}

export interface EventStreamMessage {
  seq: number;
  hash: string;
}

export function subscribeEventStream(onUpdate: (msg: EventStreamMessage) => void): () => void {
  const es = eventSource('/api/events/stream');
  const handler = (ev: MessageEvent) => {
    try {
      onUpdate(JSON.parse(ev.data) as EventStreamMessage);
    } catch { /* ignore */ }
  };
  es.addEventListener('update', handler as EventListener);
  return () => {
    es.removeEventListener('update', handler as EventListener);
    es.close();
  };
}
