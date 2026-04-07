import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { loadWorkspace, saveWorkspace, autoSaveToFile, getCurrentFileHandle } from '@/lib/storage';
import { type Workspace, type Client, type WorkerProfile, type TravelTimeMatrix, type TravelTimeErrors, type WeekSchedule, type SavedSchedule, DEFAULT_WORKSPACE, travelKey, estimateTravelMinutes, type Coords } from '@/types/models';
import { getDistanceForNewLocation } from '@/lib/google-maps';
import { toast } from 'sonner';

/** Recalculate travel times for all location pairs that have coordinates */
function recalcTravelTimes(ws: Workspace): TravelTimeMatrix {
  const matrix = { ...ws.travelTimes };
  const locations: { id: string; coords?: Coords }[] = [
    { id: 'home', coords: ws.worker.homeCoords },
    ...ws.clients.map(c => ({ id: c.id, coords: c.coords })),
  ];
  for (let i = 0; i < locations.length; i++) {
    for (let j = i + 1; j < locations.length; j++) {
      const a = locations[i], b = locations[j];
      if (a.coords && b.coords) {
        matrix[travelKey(a.id, b.id)] = estimateTravelMinutes(a.coords, b.coords);
      }
    }
  }
  return matrix;
}

/** Calculate Google Maps travel times for a newly added/updated client */
async function calcGoogleTravelForClient(
  clientId: string,
  clientAddress: string,
  workspace: Workspace,
  persist: (ws: Workspace) => void,
  setWorkspace: React.Dispatch<React.SetStateAction<Workspace>>,
) {
  if (!clientAddress.trim()) return;

  // Gather existing locations with addresses
  const existingLocations: { id: string; address: string }[] = [];
  if (workspace.worker.homeAddress.trim()) {
    existingLocations.push({ id: 'home', address: workspace.worker.homeAddress });
  }
  for (const c of workspace.clients) {
    if (c.id !== clientId && c.address.trim()) {
      existingLocations.push({ id: c.id, address: c.address });
    }
  }

  if (existingLocations.length === 0) return;

  try {
    const { toResults, fromResults } = await getDistanceForNewLocation(
      clientAddress,
      existingLocations.map(l => l.address),
    );

    setWorkspace(prev => {
      const updated = { ...prev.travelTimes };
      const errors = { ...(prev.travelTimeErrors ?? {}) };

      for (let i = 0; i < existingLocations.length; i++) {
        const key = travelKey(clientId, existingLocations[i].id);
        // Use the average of to/from for the bidirectional key
        const to = toResults[i];
        const from = fromResults[i];
        if (to !== null && from !== null) {
          updated[key] = Math.round((to + from) / 2);
          delete errors[key];
        } else if (to !== null) {
          updated[key] = to;
          delete errors[key];
        } else if (from !== null) {
          updated[key] = from;
          delete errors[key];
        } else {
          errors[key] = 'Google Maps could not calculate this route';
        }
      }

      const next = { ...prev, travelTimes: updated, travelTimeErrors: errors };
      persist(next);
      return next;
    });
  } catch (err) {
    console.error('Auto travel time calc failed:', err);
    // Silently fail - user can manually calculate later
  }
}

interface WorkspaceContextValue {
  workspace: Workspace;
  loading: boolean;
  updateWorker: (worker: WorkerProfile) => void;
  setClients: (clients: Client[]) => void;
  addClient: (client: Client) => void;
  updateClient: (client: Client) => void;
  removeClient: (id: string) => void;
  setTravelTimes: (matrix: TravelTimeMatrix) => void;
  setTravelTimeErrors: (errors: TravelTimeErrors) => void;
  setSchedule: (schedule: WeekSchedule | null) => void;
  replaceWorkspace: (ws: Workspace) => void;
  saveSchedule: (name: string) => void;
  loadSavedSchedule: (id: string) => void;
  deleteSavedSchedule: (id: string) => void;
  renameSavedSchedule: (id: string, name: string) => void;
  fileAutoSaveEnabled: boolean;
  setFileAutoSaveEnabled: (enabled: boolean) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace>(DEFAULT_WORKSPACE);
  const [loading, setLoading] = useState(true);
  const [fileAutoSaveEnabled, setFileAutoSaveEnabled] = useState(false);

  useEffect(() => {
    loadWorkspace().then(ws => { setWorkspace(ws); setLoading(false); });
  }, []);

  const persist = useCallback((ws: Workspace) => {
    setWorkspace(ws);
    saveWorkspace(ws);
    // Auto-save to linked file if enabled
    if (fileAutoSaveEnabled && getCurrentFileHandle()) {
      autoSaveToFile(ws);
    }
  }, [fileAutoSaveEnabled]);

  const updateWorker = useCallback((worker: WorkerProfile) => {
    setWorkspace(prev => {
      const next = { ...prev, worker };
      next.travelTimes = recalcTravelTimes(next);
      persist(next);
      return next;
    });
  }, [persist]);

  const setClients = useCallback((clients: Client[]) => {
    setWorkspace(prev => { const next = { ...prev, clients }; persist(next); return next; });
  }, [persist]);

  const addClient = useCallback((client: Client) => {
    setWorkspace(prev => {
      const next = { ...prev, clients: [...prev.clients, client] };
      next.travelTimes = recalcTravelTimes(next);
      persist(next);

      // Fire off Google Maps calculation in the background
      calcGoogleTravelForClient(client.id, client.address, next, persist, setWorkspace);

      return next;
    });
  }, [persist]);

  const updateClient = useCallback((client: Client) => {
    setWorkspace(prev => {
      const oldClient = prev.clients.find(c => c.id === client.id);
      const next = { ...prev, clients: prev.clients.map(c => c.id === client.id ? client : c) };
      next.travelTimes = recalcTravelTimes(next);
      persist(next);

      // Recalculate Google Maps times if address changed
      if (oldClient && oldClient.address !== client.address) {
        calcGoogleTravelForClient(client.id, client.address, next, persist, setWorkspace);
      }

      return next;
    });
  }, [persist]);

  const removeClient = useCallback((id: string) => {
    setWorkspace(prev => {
      const next = { ...prev, clients: prev.clients.filter(c => c.id !== id) };
      persist(next);
      return next;
    });
  }, [persist]);

  const setTravelTimes = useCallback((travelTimes: TravelTimeMatrix) => {
    setWorkspace(prev => { const next = { ...prev, travelTimes }; persist(next); return next; });
  }, [persist]);

  const setTravelTimeErrors = useCallback((travelTimeErrors: TravelTimeErrors) => {
    setWorkspace(prev => { const next = { ...prev, travelTimeErrors }; persist(next); return next; });
  }, [persist]);

  const setSchedule = useCallback((lastSchedule: WeekSchedule | null) => {
    setWorkspace(prev => { const next = { ...prev, lastSchedule }; persist(next); return next; });
  }, [persist]);

  const replaceWorkspace = useCallback((ws: Workspace) => { persist(ws); }, [persist]);

  const saveSchedule = useCallback((name: string) => {
    setWorkspace(prev => {
      if (!prev.lastSchedule) return prev;
      const saved: SavedSchedule = {
        id: crypto.randomUUID(),
        name,
        savedAt: new Date().toISOString(),
        schedule: prev.lastSchedule!,
      };
      const next = { ...prev, savedSchedules: [...(prev.savedSchedules ?? []), saved] };
      persist(next);
      return next;
    });
  }, [persist]);

  const loadSavedSchedule = useCallback((id: string) => {
    setWorkspace(prev => {
      const saved = (prev.savedSchedules ?? []).find(s => s.id === id);
      if (!saved) return prev;
      const next = { ...prev, lastSchedule: saved.schedule };
      persist(next);
      return next;
    });
  }, [persist]);

  const deleteSavedSchedule = useCallback((id: string) => {
    setWorkspace(prev => {
      const next = { ...prev, savedSchedules: (prev.savedSchedules ?? []).filter(s => s.id !== id) };
      persist(next);
      return next;
    });
  }, [persist]);

  const renameSavedSchedule = useCallback((id: string, name: string) => {
    setWorkspace(prev => {
      const next = { ...prev, savedSchedules: (prev.savedSchedules ?? []).map(s => s.id === id ? { ...s, name } : s) };
      persist(next);
      return next;
    });
  }, [persist]);

  return (
    <WorkspaceContext.Provider value={{
      workspace, loading, updateWorker, setClients, addClient, updateClient,
      removeClient, setTravelTimes, setTravelTimeErrors, setSchedule, replaceWorkspace,
      saveSchedule, loadSavedSchedule, deleteSavedSchedule, renameSavedSchedule,
      fileAutoSaveEnabled, setFileAutoSaveEnabled,
    }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be inside WorkspaceProvider');
  return ctx;
}
