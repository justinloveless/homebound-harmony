import type {
  Client,
  WorkerProfile,
  TravelTimeMatrix,
  TravelTimeErrors,
  WeekSchedule,
  SavedSchedule,
  Workspace,
} from '@/types/models';

/** GPS stamp attached only for clinical events (client + share + visit lifecycle). */
export interface EventGps {
  lat: number;
  lon: number;
  accuracyM: number;
  capturedAt: string; // ISO
  staleSeconds?: number;
}

export type EventKind =
  | 'worker_updated'
  | 'clients_set'
  | 'client_added'
  | 'client_updated'
  | 'client_removed'
  | 'travel_times_set'
  | 'travel_time_errors_set'
  | 'schedule_set'
  | 'saved_schedule_added'
  | 'saved_schedule_loaded'
  | 'saved_schedule_removed'
  | 'saved_schedule_renamed'
  | 'workspace_imported'
  | 'share_create'
  | 'visit_started'
  | 'visit_completed'
  | 'visit_note_added';

export type EventPayloadMap = {
  worker_updated: WorkerProfile;
  /** Replace entire client roster (same as useWorkspace.setClients). */
  clients_set: Client[];
  client_added: Client;
  client_updated: Client;
  client_removed: { id: string };
  travel_times_set: TravelTimeMatrix;
  travel_time_errors_set: TravelTimeErrors;
  schedule_set: WeekSchedule | null;
  saved_schedule_added: SavedSchedule;
  saved_schedule_loaded: { id: string };
  saved_schedule_removed: { id: string };
  saved_schedule_renamed: { id: string; name: string };
  workspace_imported: Workspace;
  /** Share artifact created — workspace unchanged; payload for audit only. */
  share_create: { artifactId: string };
  visit_started: {
    dayDate: string;
    visitIndex: number;
    clientId: string;
    verifiedArrival: boolean;
    checkedInAt: string;
  };
  visit_completed: {
    dayDate: string;
    visitIndex: number;
    clientId: string;
    completedAt: string;
  };
  visit_note_added: {
    dayDate: string;
    visitIndex: number;
    clientId: string;
    note: string;
  };
};

type EventBase = { clientEventId: string; claimedAt: string; gps?: EventGps };

/** Discriminated union so `applyEvent` narrows `payload` by `kind`. */
export type Event =
  | (EventBase & { kind: 'worker_updated'; payload: EventPayloadMap['worker_updated'] })
  | (EventBase & { kind: 'clients_set'; payload: EventPayloadMap['clients_set'] })
  | (EventBase & { kind: 'client_added'; payload: EventPayloadMap['client_added'] })
  | (EventBase & { kind: 'client_updated'; payload: EventPayloadMap['client_updated'] })
  | (EventBase & { kind: 'client_removed'; payload: EventPayloadMap['client_removed'] })
  | (EventBase & { kind: 'travel_times_set'; payload: EventPayloadMap['travel_times_set'] })
  | (EventBase & { kind: 'travel_time_errors_set'; payload: EventPayloadMap['travel_time_errors_set'] })
  | (EventBase & { kind: 'schedule_set'; payload: EventPayloadMap['schedule_set'] })
  | (EventBase & { kind: 'saved_schedule_added'; payload: EventPayloadMap['saved_schedule_added'] })
  | (EventBase & { kind: 'saved_schedule_loaded'; payload: EventPayloadMap['saved_schedule_loaded'] })
  | (EventBase & { kind: 'saved_schedule_removed'; payload: EventPayloadMap['saved_schedule_removed'] })
  | (EventBase & { kind: 'saved_schedule_renamed'; payload: EventPayloadMap['saved_schedule_renamed'] })
  | (EventBase & { kind: 'workspace_imported'; payload: EventPayloadMap['workspace_imported'] })
  | (EventBase & { kind: 'share_create'; payload: EventPayloadMap['share_create'] })
  | (EventBase & { kind: 'visit_started'; payload: EventPayloadMap['visit_started'] })
  | (EventBase & { kind: 'visit_completed'; payload: EventPayloadMap['visit_completed'] })
  | (EventBase & { kind: 'visit_note_added'; payload: EventPayloadMap['visit_note_added'] });

export const CLINICAL_KINDS = new Set<EventKind>([
  'client_added',
  'client_updated',
  'client_removed',
  'share_create',
  'visit_started',
  'visit_completed',
  'visit_note_added',
]);

export function isClinicalKind(kind: EventKind): boolean {
  return CLINICAL_KINDS.has(kind);
}
