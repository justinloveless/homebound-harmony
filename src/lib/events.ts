import type { Workspace } from '@/types/models';
import {
  travelKey,
  estimateTravelMinutes,
  type Coords,
  type TravelTimeMatrix,
} from '@/types/models';
import { migrateWorkspace } from '@/lib/storage';
import type { Event } from '@/types/events';

/** Haversine matrix for pairs that have coordinates (matches useWorkspace). */
export function recalcTravelTimes(ws: Workspace): TravelTimeMatrix {
  const matrix = { ...ws.travelTimes };
  const locations: { id: string; coords?: Coords }[] = [
    { id: 'home', coords: ws.worker.homeCoords },
    ...ws.clients.map(c => ({ id: c.id, coords: c.coords })),
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

export function applyEvent(state: Workspace, ev: Event): Workspace {
  switch (ev.kind) {
    case 'worker_updated': {
      const next = { ...state, worker: ev.payload };
      next.travelTimes = recalcTravelTimes(next);
      return next;
    }
    case 'clients_set': {
      const next = { ...state, clients: [...ev.payload] };
      next.travelTimes = recalcTravelTimes(next);
      return next;
    }
    case 'client_added': {
      const next = { ...state, clients: [...state.clients, ev.payload] };
      next.travelTimes = recalcTravelTimes(next);
      return next;
    }
    case 'client_updated': {
      const next = {
        ...state,
        clients: state.clients.map(c => (c.id === ev.payload.id ? ev.payload : c)),
      };
      next.travelTimes = recalcTravelTimes(next);
      return next;
    }
    case 'client_removed': {
      const next = { ...state, clients: state.clients.filter(c => c.id !== ev.payload.id) };
      return next;
    }
    case 'travel_times_set':
      return { ...state, travelTimes: { ...ev.payload } };
    case 'travel_time_errors_set':
      return { ...state, travelTimeErrors: { ...ev.payload } };
    case 'schedule_set':
      return { ...state, lastSchedule: ev.payload };
    case 'saved_schedule_added':
      return {
        ...state,
        savedSchedules: [...(state.savedSchedules ?? []), ev.payload],
      };
    case 'saved_schedule_loaded': {
      const saved = (state.savedSchedules ?? []).find(s => s.id === ev.payload.id);
      if (!saved) return state;
      return { ...state, lastSchedule: saved.schedule };
    }
    case 'saved_schedule_removed':
      return {
        ...state,
        savedSchedules: (state.savedSchedules ?? []).filter(s => s.id !== ev.payload.id),
      };
    case 'saved_schedule_renamed':
      return {
        ...state,
        savedSchedules: (state.savedSchedules ?? []).map(s =>
          s.id === ev.payload.id ? { ...s, name: ev.payload.name } : s,
        ),
      };
    case 'workspace_imported':
      return migrateWorkspace(ev.payload);
    case 'share_create':
    case 'visit_started':
    case 'visit_completed':
    case 'visit_note_added':
      return state;
    default: {
      const _x: never = ev;
      return _x;
    }
  }
}

export function replayEvents(snapshot: Workspace, events: Event[]): Workspace {
  return events.reduce((s, e) => applyEvent(s, e), migrateWorkspace(snapshot));
}
