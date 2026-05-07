import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { loadWorkspace as loadCached, saveWorkspace as saveCached } from '@/lib/storage';
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
import { pullWorkspace, subscribeEventStream, maybeRollupSnapshot } from '@/lib/sync';
import { applyEvent } from '@/lib/events';
import { enqueueEvent, drainOutbox } from '@/lib/outbox';
import type { Event } from '@/types/events';
import { isClinicalKind } from '@/types/events';
import type { EventGps } from '@/types/events';
import { useGeolocation } from '@/hooks/useGeolocation';

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
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const wk = auth.workspaceKey;
  const geo = useGeolocation();
  const [workspace, setWorkspace] = useState<Workspace>(DEFAULT_WORKSPACE);
  const [loading, setLoading] = useState(true);

  const versionRef = useRef(0);
  const snapshotSeqRef = useRef(0);
  const workspaceRef = useRef(workspace);
  const syncChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    geo.startWatching();
    return () => geo.stopWatching();
  }, [geo]);

  useEffect(() => {
    if (!wk) return;
    let cancelled = false;
    (async () => {
      try {
        const cached = await loadCached();
        if (!cancelled) setWorkspace(cached);
      } catch { /* */ }
      try {
        const fresh = await pullWorkspace(wk);
        if (cancelled) return;
        setWorkspace(fresh.workspace);
        workspaceRef.current = fresh.workspace;
        versionRef.current = fresh.version;
        snapshotSeqRef.current = fresh.snapshotSeq;
      } catch (err) {
        console.warn('Workspace pull failed, using cache', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [wk]);

  useEffect(() => {
    if (!wk) return;
    const unsub = subscribeEventStream(async () => {
      try {
        const fresh = await pullWorkspace(wk);
        setWorkspace(fresh.workspace);
        workspaceRef.current = fresh.workspace;
        versionRef.current = fresh.version;
        snapshotSeqRef.current = fresh.snapshotSeq;
        toast.info('Workspace updated from another device');
      } catch (err) {
        console.warn('Event stream pull failed', err);
      }
    });
    return unsub;
  }, [wk]);

  const runSync = useCallback((fn: () => Promise<void>) => {
    syncChainRef.current = syncChainRef.current.then(fn).catch((e) => {
      console.error('sync chain', e);
    });
  }, []);

  const applyAndPersist = useCallback((next: Workspace) => {
    workspaceRef.current = next;
    setWorkspace(next);
    void saveCached(next);
  }, []);

  const pushEncrypted = useCallback(
    async (ev: Event, gps: EventGps | null) => {
      if (!wk) return;
      await enqueueEvent(ev, wk, gps);
      await drainOutbox();
      versionRef.current = await maybeRollupSnapshot(workspaceRef.current, wk, versionRef.current);
    },
    [wk],
  );

  /** Apply event locally and upload; resolves GPS for clinical kinds first. */
  const dispatch = useCallback(
    (ev: Event) => {
      runSync(async () => {
        let finalEv = ev;
        let gps: EventGps | null = null;
        if (isClinicalKind(ev.kind)) {
          gps = await geo.ensureClinicalFix();
          if (!gps) {
            toast.error('Location access is required for client changes.');
            return;
          }
          finalEv = { ...ev, gps };
        }
        const next = applyEvent(workspaceRef.current, finalEv);
        applyAndPersist(next);
        if (!wk) return;
        await pushEncrypted(finalEv, gps);
      });
    },
    [wk, geo, applyAndPersist, runSync, pushEncrypted],
  );

  const calcGoogleTravelForClient = useCallback(
    async (clientId: string, clientAddress: string) => {
      if (!clientAddress.trim() || !wk) return;

      const baseWs = workspaceRef.current;
      const existingLocations: { id: string; address: string }[] = [];
      if (baseWs.worker.homeAddress.trim()) {
        existingLocations.push({ id: 'home', address: baseWs.worker.homeAddress });
      }
      for (const c of baseWs.clients) {
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

        const prev = workspaceRef.current;
        const updated = { ...prev.travelTimes };
        const errors = { ...(prev.travelTimeErrors ?? {}) };

        for (let i = 0; i < existingLocations.length; i++) {
          const key = travelKey(clientId, existingLocations[i].id);
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
        applyAndPersist(next);

        const evTimes: Event = {
          clientEventId: crypto.randomUUID(),
          kind: 'travel_times_set',
          payload: updated,
          claimedAt: new Date().toISOString(),
        };
        const evErr: Event = {
          clientEventId: crypto.randomUUID(),
          kind: 'travel_time_errors_set',
          payload: errors,
          claimedAt: new Date().toISOString(),
        };
        await pushEncrypted(evTimes, null);
        await pushEncrypted(evErr, null);
      } catch (err) {
        console.error('Auto travel time calc failed:', err);
      }
    },
    [wk, applyAndPersist, pushEncrypted],
  );

  const updateWorker = useCallback(
    (worker: WorkerProfile) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'worker_updated',
        payload: worker,
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const setClients = useCallback(
    (clients: Client[]) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'clients_set',
        payload: clients,
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const addClient = useCallback(
    (client: Client) => {
      runSync(async () => {
        const gps = await geo.ensureClinicalFix();
        if (!gps) {
          toast.error('Location access is required to add a client.');
          return;
        }
        const ev: Event = {
          clientEventId: crypto.randomUUID(),
          kind: 'client_added',
          payload: client,
          claimedAt: new Date().toISOString(),
          gps,
        };
        const next = applyEvent(workspaceRef.current, ev);
        applyAndPersist(next);
        if (wk) await pushEncrypted(ev, gps);
        await calcGoogleTravelForClient(client.id, client.address);
      });
    },
    [wk, geo, applyAndPersist, runSync, pushEncrypted, calcGoogleTravelForClient],
  );

  const updateClient = useCallback(
    (client: Client) => {
      const old = workspaceRef.current.clients.find(c => c.id === client.id);
      runSync(async () => {
        const gps = await geo.ensureClinicalFix();
        if (!gps) {
          toast.error('Location access is required to update a client.');
          return;
        }
        const ev: Event = {
          clientEventId: crypto.randomUUID(),
          kind: 'client_updated',
          payload: client,
          claimedAt: new Date().toISOString(),
          gps,
        };
        const next = applyEvent(workspaceRef.current, ev);
        applyAndPersist(next);
        if (wk) await pushEncrypted(ev, gps);
        if (old && old.address !== client.address) {
          await calcGoogleTravelForClient(client.id, client.address);
        }
      });
    },
    [wk, geo, applyAndPersist, runSync, pushEncrypted, calcGoogleTravelForClient],
  );

  const removeClient = useCallback(
    (id: string) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'client_removed',
        payload: { id },
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const setTravelTimes = useCallback(
    (travelTimes: TravelTimeMatrix) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'travel_times_set',
        payload: travelTimes,
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const setTravelTimeErrors = useCallback(
    (travelTimeErrors: TravelTimeErrors) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'travel_time_errors_set',
        payload: travelTimeErrors,
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const setSchedule = useCallback(
    (lastSchedule: WeekSchedule | null) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'schedule_set',
        payload: lastSchedule,
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const replaceWorkspace = useCallback(
    (ws: Workspace) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'workspace_imported',
        payload: ws,
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const saveSchedule = useCallback(
    (name: string) => {
      const prev = workspaceRef.current;
      if (!prev.lastSchedule) return;
      const saved: SavedSchedule = {
        id: crypto.randomUUID(),
        name,
        savedAt: new Date().toISOString(),
        schedule: prev.lastSchedule,
      };
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'saved_schedule_added',
        payload: saved,
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const loadSavedSchedule = useCallback(
    (id: string) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'saved_schedule_loaded',
        payload: { id },
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const deleteSavedSchedule = useCallback(
    (id: string) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'saved_schedule_removed',
        payload: { id },
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  const renameSavedSchedule = useCallback(
    (id: string, name: string) => {
      dispatch({
        clientEventId: crypto.randomUUID(),
        kind: 'saved_schedule_renamed',
        payload: { id, name },
        claimedAt: new Date().toISOString(),
      });
    },
    [dispatch],
  );

  return (
    <WorkspaceContext.Provider
      value={{
        workspace,
        loading,
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
