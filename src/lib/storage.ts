import { openDB, type IDBPDatabase } from 'idb';
import { DEFAULT_WORKSPACE, type Workspace, frequencyToVisits } from '@/types/models';

// IndexedDB now functions as a local cache only — the encrypted server blob
// is the source of truth (see src/lib/sync.ts). The legacy File System
// Access helpers have been removed.

const DB_NAME = 'home-health-scheduler';
const STORE_NAME = 'workspace';
const WORKSPACE_KEY = 'current';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
}

/** Migrate legacy clients with frequency field to new visitsPerPeriod format */
function migrateWorkspace(ws: Workspace): Workspace {
  const clients = ws.clients.map(c => {
    if (c.visitsPerPeriod != null && c.period != null) return c;
    const freq = (c as any).frequency;
    if (freq) {
      const { visitsPerPeriod, period } = frequencyToVisits(freq);
      return { ...c, visitsPerPeriod, period };
    }
    return { ...c, visitsPerPeriod: 1, period: 'week' as const };
  });
  const worker = ws.worker;
  if (!worker.schedulingStrategy) {
    worker.schedulingStrategy = 'spread';
  }
  return { ...ws, clients, worker };
}

export async function loadWorkspace(): Promise<Workspace> {
  const db = await getDB();
  const data = await db.get(STORE_NAME, WORKSPACE_KEY);
  return migrateWorkspace(data ?? { ...DEFAULT_WORKSPACE });
}

export async function saveWorkspace(ws: Workspace): Promise<void> {
  const db = await getDB();
  await db.put(STORE_NAME, ws, WORKSPACE_KEY);
}

export function exportWorkspace(ws: Workspace): string {
  return JSON.stringify(ws, null, 2);
}

export function importWorkspace(json: string): Workspace {
  const data = JSON.parse(json);
  if (data.version !== 1) throw new Error('Unsupported workspace version');
  return migrateWorkspace(data as Workspace);
}

export function downloadJson(content: string, filename: string) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
