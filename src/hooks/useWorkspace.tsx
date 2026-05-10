import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Workspace,
  type Client,
  type WorkerProfile,
  type TravelTimeMatrix,
  type TravelTimeErrors,
  type WeekSchedule,
  type SavedSchedule,
  DEFAULT_WORKSPACE,
  travelKey,
} from '@/types/models';
import { getDistanceForNewLocation } from '@/lib/google-maps';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { subscribeEventStream } from '@/lib/sync';
import { api } from '@/lib/api';
import { useGeolocation } from '@/hooks/useGeolocation';
import { saveWorkspace as saveCached } from '@/lib/storage';

interface WorkspaceContextValue {
  workspace: Workspace;
  loading: boolean;
  workerId: string | null;
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
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

type ApiWorker = WorkerProfile & { id: string; userId?: string | null };

async function fetchWorkspaceBundle(): Promise<{
  worker: ApiWorker;
  clients: Client[];
  travelTimes: TravelTimeMatrix;
  travelTimeErrors: TravelTimeErrors;
  lastSchedule: WeekSchedule | null;
  savedSchedules: SavedSchedule[];
}> {
  const me = await api.get<ApiWorker>('/api/workers/me');
  const clientsRes = await api.get<{ clients: Client[] }>('/api/clients');
  const tt = await api.get<{ travelTimes: TravelTimeMatrix; travelTimeErrors: TravelTimeErrors }>(
    '/api/travel-times',
  );
  const cur = await api.get<{
    schedule: null | {
      id: string;
      weekSchedule: WeekSchedule;
      isSaved: boolean;
      savedName: string | null;
      savedAt: string | null;
    };
  }>('/api/schedules/current');

  const list = await api.get<{
    schedules: {
      id: string;
      isSaved: boolean;
      savedName: string | null;
      savedAt: string | null;
      weekStartDate: string;
    }[];
  }>('/api/schedules');

  const savedRows = list.schedules.filter((s) => s.isSaved);
  const savedSchedules: SavedSchedule[] = [];
  for (const row of savedRows) {
    const full = await api.get<{
      id: string;
      weekSchedule: WeekSchedule;
      savedName: string | null;
      savedAt: string | null;
    }>(`/api/schedules/${row.id}`);
    if (full.savedName && full.savedAt) {
      savedSchedules.push({
        id: full.id,
        name: full.savedName,
        savedAt: full.savedAt,
        schedule: full.weekSchedule,
      });
    }
  }

  const lastSchedule = cur.schedule?.weekSchedule ?? null;

  return {
    worker: me,
    clients: clientsRes.clients,
    travelTimes: tt.travelTimes ?? {},
    travelTimeErrors: tt.travelTimeErrors ?? {},
    lastSchedule,
    savedSchedules,
  };
}

function toWorkspace(bundle: Awaited<ReturnType<typeof fetchWorkspaceBundle>>): Workspace {
  const w = bundle.worker;
  const worker: WorkerProfile = {
    name: w.name,
    homeAddress: w.homeAddress,
    homeCoords: w.homeCoords,
    workingHours: w.workingHours,
    daysOff: w.daysOff ?? [],
    makeUpDays: w.makeUpDays ?? [],
    breaks: w.breaks,
    schedulingStrategy: w.schedulingStrategy,
  };
  return {
    version: 1,
    worker,
    clients: bundle.clients,
    travelTimes: bundle.travelTimes,
    travelTimeErrors: bundle.travelTimeErrors,
    lastSchedule: bundle.lastSchedule,
    savedSchedules: bundle.savedSchedules,
  };
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const geo = useGeolocation();
  const queryClient = useQueryClient();
  const workspaceRef = useRef<Workspace>(DEFAULT_WORKSPACE);

  const enabled = auth.status === 'authenticated';

  const q = useQuery({
    queryKey: ['workspace', 'bundle'],
    queryFn: fetchWorkspaceBundle,
    enabled,
  });

  useEffect(() => {
    geo.startWatching();
    return () => geo.stopWatching();
  }, [geo]);

  const workspace = useMemo(() => {
    if (!q.data) return DEFAULT_WORKSPACE;
    const ws = toWorkspace(q.data);
    workspaceRef.current = ws;
    void saveCached(ws);
    return ws;
  }, [q.data]);

  useEffect(() => {
    if (!enabled) return;
    const unsub = subscribeEventStream(() => {
      void queryClient.invalidateQueries({ queryKey: ['workspace'] });
      toast.info('Workspace updated');
    });
    return unsub;
  }, [enabled, queryClient]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['workspace'] });
  }, [queryClient]);

  const workerId = q.data?.worker.id ?? null;

  const updateWorker = useCallback(
    async (worker: WorkerProfile) => {
      if (!workerId) return;
      await api.put(`/api/workers/${workerId}`, worker);
      invalidate();
    },
    [workerId, invalidate],
  );

  const setClients = useCallback(
    async (clients: Client[]) => {
      const existing = workspaceRef.current.clients;
      const prevIds = new Set(existing.map((c) => c.id));
      const nextIds = new Set(clients.map((c) => c.id));
      for (const c of existing) {
        if (!nextIds.has(c.id)) await api.del(`/api/clients/${c.id}`);
      }
      for (const c of clients) {
        if (prevIds.has(c.id)) await api.put(`/api/clients/${c.id}`, c);
        else await api.post('/api/clients', c);
      }
      invalidate();
    },
    [invalidate],
  );

  const addClient = useCallback(
    async (client: Client) => {
      const gps = await geo.ensureClinicalFix();
      if (!gps) {
        toast.error('Location access is required to add a client.');
        return;
      }
      const created = await api.post<Client>('/api/clients', {
        ...client,
        coords: { lat: gps.lat, lon: gps.lon },
      });
      const base = workspaceRef.current;
      try {
        const existingLocations: { id: string; address: string }[] = [];
        if (base.worker.homeAddress.trim()) {
          existingLocations.push({ id: 'home', address: base.worker.homeAddress });
        }
        for (const c of base.clients) {
          if (c.id !== created.id && c.address.trim()) {
            existingLocations.push({ id: c.id, address: c.address });
          }
        }
        if (existingLocations.length === 0) {
          invalidate();
          return;
        }
        const { toResults, fromResults } = await getDistanceForNewLocation(
          created.address,
          existingLocations.map((l) => l.address),
        );
        const updated = { ...base.travelTimes };
        const errors = { ...(base.travelTimeErrors ?? {}) };
        for (let i = 0; i < existingLocations.length; i++) {
          const key = travelKey(created.id, existingLocations[i].id);
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
        await api.put('/api/travel-times', {
          travelTimes: updated,
          travelTimeErrors: errors,
        });
      } catch {
        /* ignore */
      }
      invalidate();
    },
    [geo, invalidate],
  );

  const updateClient = useCallback(
    async (client: Client) => {
      const old = workspaceRef.current.clients.find((c) => c.id === client.id);
      const gps = await geo.ensureClinicalFix();
      if (!gps) {
        toast.error('Location access is required to update a client.');
        return;
      }
      await api.put(`/api/clients/${client.id}`, {
        ...client,
        coords: { lat: gps.lat, lon: gps.lon },
      });
      invalidate();
      if (old && old.address !== client.address) {
        try {
          const base = workspaceRef.current;
          const existingLocations: { id: string; address: string }[] = [];
          if (base.worker.homeAddress.trim()) existingLocations.push({ id: 'home', address: base.worker.homeAddress });
          for (const x of base.clients) {
            if (x.id !== client.id && x.address.trim()) existingLocations.push({ id: x.id, address: x.address });
          }
          const { toResults, fromResults } = await getDistanceForNewLocation(client.address, existingLocations.map((l) => l.address));
          const updated = { ...base.travelTimes };
          const errors = { ...(base.travelTimeErrors ?? {}) };
          for (let i = 0; i < existingLocations.length; i++) {
            const key = travelKey(client.id, existingLocations[i].id);
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
          await api.put('/api/travel-times', { travelTimes: updated, travelTimeErrors: errors });
        } catch {
          /* ignore */
        }
      }
      invalidate();
    },
    [geo, invalidate],
  );

  const removeClient = useCallback(
    async (id: string) => {
      await api.del(`/api/clients/${id}`);
      invalidate();
    },
    [invalidate],
  );

  const setTravelTimes = useCallback(
    async (travelTimes: TravelTimeMatrix) => {
      await api.put('/api/travel-times', {
        travelTimes,
        travelTimeErrors: workspaceRef.current.travelTimeErrors ?? {},
      });
      invalidate();
    },
    [invalidate],
  );

  const setTravelTimeErrors = useCallback(
    async (travelTimeErrors: TravelTimeErrors) => {
      await api.put('/api/travel-times', {
        travelTimes: workspaceRef.current.travelTimes,
        travelTimeErrors,
      });
      invalidate();
    },
    [invalidate],
  );

  const setSchedule = useCallback(
    async (lastSchedule: WeekSchedule | null) => {
      if (!lastSchedule) {
        invalidate();
        return;
      }
      await api.post('/api/schedules', {
        weekSchedule: lastSchedule,
        isCurrent: true,
        isSaved: false,
      });
      invalidate();
    },
    [invalidate],
  );

  const replaceWorkspace = useCallback(
    async (ws: Workspace) => {
      if (workerId) await api.put(`/api/workers/${workerId}`, ws.worker);
      await setClients(ws.clients);
      await api.put('/api/travel-times', {
        travelTimes: ws.travelTimes,
        travelTimeErrors: ws.travelTimeErrors ?? {},
      });
      if (ws.lastSchedule) {
        await api.post('/api/schedules', {
          weekSchedule: ws.lastSchedule,
          isCurrent: true,
          isSaved: false,
        });
      }
      invalidate();
    },
    [workerId, setClients, invalidate],
  );

  const saveSchedule = useCallback(
    async (name: string) => {
      const prev = workspaceRef.current;
      if (!prev.lastSchedule) return;
      await api.post('/api/schedules', {
        weekSchedule: prev.lastSchedule,
        isCurrent: true,
        isSaved: true,
        savedName: name,
      });
      invalidate();
    },
    [invalidate],
  );

  const loadSavedSchedule = useCallback(
    async (id: string) => {
      await api.post(`/api/schedules/${id}/activate`);
      invalidate();
    },
    [invalidate],
  );

  const deleteSavedSchedule = useCallback(
    async (id: string) => {
      await api.del(`/api/schedules/${id}`);
      invalidate();
    },
    [invalidate],
  );

  const renameSavedSchedule = useCallback(
    async (id: string, name: string) => {
      const row = await api.get<{ weekSchedule: WeekSchedule }>(`/api/schedules/${id}`);
      await api.put(`/api/schedules/${id}`, {
        weekSchedule: row.weekSchedule,
        isSaved: true,
        savedName: name,
      });
      invalidate();
    },
    [invalidate],
  );

  const loading = auth.status === 'checking' || (enabled && q.isLoading);

  return (
    <WorkspaceContext.Provider
      value={{
        workspace,
        loading,
        workerId,
        updateWorker,
        setClients,
        addClient,
        updateClient,
        removeClient,
        setTravelTimes,
        setTravelTimeErrors,
        setSchedule,
        replaceWorkspace,
        saveSchedule,
        loadSavedSchedule,
        deleteSavedSchedule,
        renameSavedSchedule,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be inside WorkspaceProvider');
  return ctx;
}
