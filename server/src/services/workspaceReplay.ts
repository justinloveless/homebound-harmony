/**
 * Minimal workspace replay for admin audit diffs (mirrors src/lib/events.ts applyEvent).
 * No IndexedDB / React dependencies.
 */

import {
  type Client,
  type Coords,
  type SavedSchedule,
  type WeekSchedule,
  type WorkerProfile,
  type Workspace,
  DEFAULT_WORKSPACE,
  travelKey,
} from './workspaceReplayTypes';

export type { Client, SavedSchedule, WeekSchedule, WorkerProfile, Workspace } from './workspaceReplayTypes';
export { DEFAULT_WORKSPACE, travelKey } from './workspaceReplayTypes';

function estimateTravelMinutes(a: Coords, b: Coords): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  const distKm = 2 * R * Math.asin(Math.sqrt(h));
  const driveKm = distKm * 1.3;
  return Math.max(5, Math.round((driveKm / 40) * 60));
}

export function migrateWorkspace(ws: Workspace): Workspace {
  const clients = ws.clients.map((c) => {
    if (c.visitsPerPeriod != null && c.period != null) return c;
    const freq = (c as { frequency?: string }).frequency;
    if (freq === 'weekly') return { ...c, visitsPerPeriod: 1, period: 'week' as const };
    if (freq === 'biweekly') return { ...c, visitsPerPeriod: 1, period: '2weeks' as const };
    if (freq === 'monthly') return { ...c, visitsPerPeriod: 1, period: 'month' as const };
    return { ...c, visitsPerPeriod: c.visitsPerPeriod ?? 1, period: c.period ?? 'week' };
  });
  const worker = {
    ...ws.worker,
    makeUpDays: ws.worker.makeUpDays ?? [],
    schedulingStrategy: ws.worker.schedulingStrategy ?? 'spread',
  };
  return { ...ws, clients, worker };
}

function recalcTravelTimes(ws: Workspace): Workspace['travelTimes'] {
  const matrix = { ...ws.travelTimes };
  const locations: { id: string; coords?: Coords }[] = [
    { id: 'home', coords: ws.worker.homeCoords },
    ...ws.clients.map((c) => ({ id: c.id, coords: c.coords })),
  ];
  for (let i = 0; i < locations.length; i++) {
    for (let j = i + 1; j < locations.length; j++) {
      const a = locations[i];
      const b = locations[j];
      if (a.coords && b.coords) {
        matrix[travelKey(a.id, b.id)] = estimateTravelMinutes(a.coords, b.coords);
      }
    }
  }
  return matrix;
}

export function applyDomainEventRow(state: Workspace, row: { kind: string; payload: unknown }): Workspace {
  const ev = row as { kind: string; payload: unknown };
  switch (ev.kind) {
    case 'worker_updated': {
      const next = { ...state, worker: ev.payload as WorkerProfile };
      next.travelTimes = recalcTravelTimes(next);
      return next;
    }
    case 'clients_set': {
      const next = { ...state, clients: [...(ev.payload as Client[])] };
      next.travelTimes = recalcTravelTimes(next);
      return next;
    }
    case 'client_added': {
      const next = { ...state, clients: [...state.clients, ev.payload as Client] };
      next.travelTimes = recalcTravelTimes(next);
      return next;
    }
    case 'client_updated': {
      const pl = ev.payload as Client;
      const existing = state.clients.some((c) => c.id === pl.id);
      const next = {
        ...state,
        clients: existing ? state.clients.map((c) => (c.id === pl.id ? pl : c)) : [...state.clients, pl],
      };
      next.travelTimes = recalcTravelTimes(next);
      return next;
    }
    case 'client_removed': {
      const id = (ev.payload as { id: string }).id;
      const next = { ...state, clients: state.clients.filter((c) => c.id !== id) };
      return next;
    }
    case 'travel_times_set':
      return { ...state, travelTimes: { ...(ev.payload as Workspace['travelTimes']) } };
    case 'travel_time_errors_set':
      return { ...state, travelTimeErrors: { ...(ev.payload as NonNullable<Workspace['travelTimeErrors']>) } };
    case 'schedule_set':
      return { ...state, lastSchedule: ev.payload as WeekSchedule | null };
    case 'saved_schedule_added':
      return {
        ...state,
        savedSchedules: [...(state.savedSchedules ?? []), ev.payload as SavedSchedule],
      };
    case 'saved_schedule_loaded': {
      const sid = (ev.payload as { id: string }).id;
      const saved = (state.savedSchedules ?? []).find((s) => s.id === sid);
      if (!saved) return state;
      return { ...state, lastSchedule: saved.schedule };
    }
    case 'saved_schedule_removed':
      return {
        ...state,
        savedSchedules: (state.savedSchedules ?? []).filter((s) => s.id !== (ev.payload as { id: string }).id),
      };
    case 'saved_schedule_renamed': {
      const { id, name } = ev.payload as { id: string; name: string };
      return {
        ...state,
        savedSchedules: (state.savedSchedules ?? []).map((s) => (s.id === id ? { ...s, name } : s)),
      };
    }
    case 'workspace_imported':
      return migrateWorkspace(ev.payload as Workspace);
    case 'share_create':
    case 'visit_started':
    case 'visit_completed':
    case 'visit_note_added':
    case 'visit_note':
      return state;
    default:
      return state;
  }
}

export function replayWorkspaceFromEvents(
  initial: Workspace,
  rows: { kind: string; payload: unknown }[],
): Workspace {
  let s = migrateWorkspace(structuredClone(initial));
  for (const row of rows) {
    s = applyDomainEventRow(s, row);
  }
  return s;
}
