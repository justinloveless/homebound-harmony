/** Workspace shapes duplicated from src/types/models.ts for server-only replay (no Vite path aliases). */

export interface Coords {
  lat: number;
  lon: number;
}

export interface TimeWindow {
  day: string;
  startTime: string;
  endTime: string;
}

export interface Client {
  id: string;
  name: string;
  address: string;
  coords?: Coords;
  visitDurationMinutes: number;
  visitsPerPeriod: number;
  period: string;
  priority: string;
  timeWindows: TimeWindow[];
  notes: string;
  excludedFromSchedule?: boolean;
}

export interface WorkerProfile {
  name: string;
  homeAddress: string;
  homeCoords?: Coords;
  workingHours: { startTime: string; endTime: string };
  daysOff: string[];
  makeUpDays: string[];
  breaks: { startTime: string; endTime: string; label: string }[];
  schedulingStrategy: string;
}

export interface ScheduledVisit {
  clientId: string;
  startTime: string;
  endTime: string;
  travelTimeFromPrev: number;
  travelDistanceMiFromPrev?: number;
  manuallyPlaced?: boolean;
}

export interface DaySchedule {
  day: string;
  date: string;
  visits: ScheduledVisit[];
  totalTravelMinutes: number;
  leaveHomeTime: string;
  arriveHomeTime: string;
}

export interface WeekSchedule {
  weekStartDate: string;
  days: DaySchedule[];
  totalTravelMinutes: number;
  totalTimeAwayMinutes: number;
  clientGroups?: Record<string, string>;
  unmetVisits?: { clientId: string; missing: number }[];
  recommendedDrops?: string[];
}

export interface SavedSchedule {
  id: string;
  name: string;
  savedAt: string;
  schedule: WeekSchedule;
}

export type TravelTimeMatrix = Record<string, number>;
export type TravelTimeErrors = Record<string, string>;

export interface Workspace {
  version: 1;
  worker: WorkerProfile;
  clients: Client[];
  travelTimes: TravelTimeMatrix;
  travelTimeErrors?: TravelTimeErrors;
  lastSchedule: WeekSchedule | null;
  savedSchedules?: SavedSchedule[];
}

export function travelKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export const DEFAULT_WORKSPACE: Workspace = {
  version: 1,
  worker: {
    name: '',
    homeAddress: '',
    workingHours: { startTime: '08:00', endTime: '17:00' },
    daysOff: ['saturday', 'sunday'],
    makeUpDays: [],
    breaks: [{ startTime: '12:00', endTime: '13:00', label: 'Lunch' }],
    schedulingStrategy: 'spread',
  },
  clients: [],
  travelTimes: {},
  travelTimeErrors: {},
  lastSchedule: null,
};
