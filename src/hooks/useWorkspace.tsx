import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { loadWorkspace, saveWorkspace } from '@/lib/storage';
import { type Workspace, type Client, type WorkerProfile, type TravelTimeMatrix, type WeekSchedule, DEFAULT_WORKSPACE, travelKey, estimateTravelMinutes, type Coords } from '@/types/models';

interface WorkspaceContextValue {
  workspace: Workspace;
  loading: boolean;
  updateWorker: (worker: WorkerProfile) => void;
  setClients: (clients: Client[]) => void;
  addClient: (client: Client) => void;
  updateClient: (client: Client) => void;
  removeClient: (id: string) => void;
  setTravelTimes: (matrix: TravelTimeMatrix) => void;
  setSchedule: (schedule: WeekSchedule | null) => void;
  replaceWorkspace: (ws: Workspace) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace>(DEFAULT_WORKSPACE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadWorkspace().then(ws => { setWorkspace(ws); setLoading(false); });
  }, []);

  const persist = useCallback((ws: Workspace) => {
    setWorkspace(ws);
    saveWorkspace(ws);
  }, []);

  const updateWorker = useCallback((worker: WorkerProfile) => {
    setWorkspace(prev => { const next = { ...prev, worker }; persist(next); return next; });
  }, [persist]);

  const setClients = useCallback((clients: Client[]) => {
    setWorkspace(prev => { const next = { ...prev, clients }; persist(next); return next; });
  }, [persist]);

  const addClient = useCallback((client: Client) => {
    setWorkspace(prev => { const next = { ...prev, clients: [...prev.clients, client] }; persist(next); return next; });
  }, [persist]);

  const updateClient = useCallback((client: Client) => {
    setWorkspace(prev => {
      const next = { ...prev, clients: prev.clients.map(c => c.id === client.id ? client : c) };
      persist(next);
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

  const setSchedule = useCallback((lastSchedule: WeekSchedule | null) => {
    setWorkspace(prev => { const next = { ...prev, lastSchedule }; persist(next); return next; });
  }, [persist]);

  const replaceWorkspace = useCallback((ws: Workspace) => { persist(ws); }, [persist]);

  return (
    <WorkspaceContext.Provider value={{
      workspace, loading, updateWorker, setClients, addClient, updateClient,
      removeClient, setTravelTimes, setSchedule, replaceWorkspace,
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
