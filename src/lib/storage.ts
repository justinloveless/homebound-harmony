import { openDB, type IDBPDatabase } from 'idb';
import { DEFAULT_WORKSPACE, type Workspace, frequencyToVisits } from '@/types/models';

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
  // Migrate missing schedulingStrategy
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
  return data as Workspace;
}

// --- File System Access API helpers ---

/** Check if the File System Access API is supported */
export function isFileSystemAccessSupported(): boolean {
  return 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
}

let _currentFileHandle: FileSystemFileHandle | null = null;

/** Get the current file handle (for auto-save) */
export function getCurrentFileHandle(): FileSystemFileHandle | null {
  return _currentFileHandle;
}

/** Clear the current file handle */
export function clearFileHandle(): void {
  _currentFileHandle = null;
}

/** Save workspace to a file using the File System Access API picker */
export async function saveWorkspaceToFile(ws: Workspace, existingHandle?: FileSystemFileHandle | null): Promise<FileSystemFileHandle> {
  const handle = existingHandle ?? await (window as any).showSaveFilePicker({
    suggestedName: `routecare-workspace.json`,
    types: [{
      description: 'JSON Workspace File',
      accept: { 'application/json': ['.json'] },
    }],
  });
  const writable = await handle.createWritable();
  await writable.write(exportWorkspace(ws));
  await writable.close();
  _currentFileHandle = handle;
  return handle;
}

/** Open a workspace file using the File System Access API picker */
export async function openWorkspaceFromFile(): Promise<{ workspace: Workspace; handle: FileSystemFileHandle }> {
  const [handle] = await (window as any).showOpenFilePicker({
    types: [{
      description: 'JSON Workspace File',
      accept: { 'application/json': ['.json'] },
    }],
  });
  const file = await handle.getFile();
  const text = await file.text();
  const ws = importWorkspace(text);
  _currentFileHandle = handle;
  return { workspace: ws, handle };
}

/** Auto-save workspace to the current file handle (no picker) */
export async function autoSaveToFile(ws: Workspace): Promise<boolean> {
  if (!_currentFileHandle) return false;
  try {
    const writable = await _currentFileHandle.createWritable();
    await writable.write(exportWorkspace(ws));
    await writable.close();
    return true;
  } catch {
    // Permission revoked or file moved
    _currentFileHandle = null;
    return false;
  }
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
