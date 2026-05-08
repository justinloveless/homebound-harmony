import { openDB, type IDBPDatabase } from 'idb';
import { DEFAULT_WORKSPACE, type Workspace, frequencyToVisits } from '@/types/models';

// IndexedDB: workspace cache + event outbox (see src/lib/outbox.ts, src/lib/sync.ts).

const DB_NAME = 'home-health-scheduler';
const DB_VERSION = 2;
const STORE_NAME = 'workspace';
const WORKSPACE_KEY = 'current';

export const STORES = {
  workspace: STORE_NAME,
  outbox: 'events_outbox',
  meta: 'events_meta',
} as const;

let dbPromise: Promise<IDBPDatabase> | null = null;

/** Shared DB handle for workspace + event outbox. */
export function getSchedulerDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains(STORES.outbox)) {
            const ob = db.createObjectStore(STORES.outbox, { keyPath: 'clientEventId' });
            ob.createIndex('byOrder', 'order');
          }
          if (!db.objectStoreNames.contains(STORES.meta)) {
            db.createObjectStore(STORES.meta);
          }
        }
      },
    });
  }
  return dbPromise;
}

/** Migrate legacy workspace JSON (new fields, defaults). */
export function migrateWorkspace(ws: Workspace): Workspace {
  const clients = ws.clients.map(c => {
    if (c.visitsPerPeriod != null && c.period != null) return c;
    const freq = (c as any).frequency;
    if (freq) {
      const { visitsPerPeriod, period } = frequencyToVisits(freq);
      return { ...c, visitsPerPeriod, period };
    }
    return { ...c, visitsPerPeriod: 1, period: 'week' as const };
  });
  const worker = {
    ...ws.worker,
    makeUpDays: ws.worker.makeUpDays ?? [],
    schedulingStrategy: ws.worker.schedulingStrategy ?? 'spread',
  };
  return { ...ws, clients, worker };
}

export async function loadWorkspace(): Promise<Workspace> {
  const db = await getSchedulerDB();
  const data = await db.get(STORE_NAME, WORKSPACE_KEY);
  return migrateWorkspace(data ?? { ...DEFAULT_WORKSPACE });
}

export async function saveWorkspace(ws: Workspace): Promise<void> {
  const db = await getSchedulerDB();
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
