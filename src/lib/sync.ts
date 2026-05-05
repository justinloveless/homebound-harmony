// Workspace sync: pulls/pushes the encrypted blob, manages the local
// version, and surfaces cross-device updates over SSE.
//
// IndexedDB is a cache-only fallback so the app keeps working offline; the
// server's blob is the source of truth as soon as we can reach it.

import { api, ApiError, eventSource } from './api';
import {
  decryptJson,
  encryptJson,
  type EncryptedBlob,
} from './crypto';
import { DEFAULT_WORKSPACE, type Workspace } from '@/types/models';
import { loadWorkspace as loadCached, saveWorkspace as saveCached } from './storage';

interface ServerBlob extends EncryptedBlob {
  wrappedWorkspaceKey: string;
  wrappedWorkspaceKeyRecovery: string;
  version: number;
}

export interface SyncState {
  workspace: Workspace;
  version: number;
}

export async function fetchServerBlob(): Promise<ServerBlob> {
  return api.get<ServerBlob>('/api/workspace');
}

export async function pullWorkspace(wk: CryptoKey): Promise<SyncState> {
  const blob = await fetchServerBlob();
  if (!blob.ciphertext || !blob.iv) {
    return { workspace: { ...DEFAULT_WORKSPACE }, version: blob.version };
  }
  const ws = await decryptJson<Workspace>(
    { ciphertext: blob.ciphertext, iv: blob.iv },
    wk,
  );
  await saveCached(ws);
  return { workspace: ws, version: blob.version };
}

export class WorkspaceConflictError extends Error {
  constructor(public serverVersion: number) {
    super('Workspace was updated on another device');
    this.name = 'WorkspaceConflictError';
  }
}

export async function pushWorkspace(
  ws: Workspace,
  wk: CryptoKey,
  expectedVersion: number,
): Promise<number> {
  const enc = await encryptJson(ws, wk);
  try {
    const res = await api.put<{ version: number }>(
      '/api/workspace',
      { ciphertext: enc.ciphertext, iv: enc.iv },
      { headers: { 'If-Match': `"${expectedVersion}"` } },
    );
    await saveCached(ws);
    return res.version;
  } catch (err) {
    if (err instanceof ApiError && err.status === 412) {
      const sv = (err.body as any)?.serverVersion;
      throw new WorkspaceConflictError(typeof sv === 'number' ? sv : expectedVersion);
    }
    throw err;
  }
}

// Initial blob seeded at registration time, before login.
export async function loadCachedWorkspace(): Promise<Workspace> {
  return loadCached();
}

export interface UpdateMessage {
  version: number;
}

export function subscribeWorkspaceUpdates(
  onUpdate: (msg: UpdateMessage) => void,
): () => void {
  const es = eventSource('/api/workspace/events');
  const handler = (ev: MessageEvent) => {
    try { onUpdate(JSON.parse(ev.data) as UpdateMessage); } catch { /* ignore */ }
  };
  es.addEventListener('update', handler as EventListener);
  return () => {
    es.removeEventListener('update', handler as EventListener);
    es.close();
  };
}
