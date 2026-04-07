import { openDB, type IDBPDatabase } from 'idb';
import { DEFAULT_WORKSPACE, type Workspace } from '@/types/models';

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

export async function loadWorkspace(): Promise<Workspace> {
  const db = await getDB();
  const data = await db.get(STORE_NAME, WORKSPACE_KEY);
  return data ?? { ...DEFAULT_WORKSPACE };
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
  return data as Workspace;
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
