export interface TimeWindow {
  day: DayOfWeek;
  startTime: string; // "HH:MM" 24h format
  endTime: string;
}

export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export const DAYS_OF_WEEK: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export const DAY_LABELS: Record<DayOfWeek, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

export type Frequency = 'weekly' | 'biweekly' | 'monthly';
export type Priority = 'high' | 'medium' | 'low';

export interface Coords {
  lat: number;
  lon: number;
}

export interface Client {
  id: string;
  name: string;
  address: string;
  coords?: Coords;
  visitDurationMinutes: number;
  frequency: Frequency;
  priority: Priority;
  timeWindows: TimeWindow[];
  notes: string;
}

export interface WorkerProfile {
  name: string;
  homeAddress: string;
  homeCoords?: Coords;
  workingHours: { startTime: string; endTime: string };
  daysOff: DayOfWeek[];
  breaks: { startTime: string; endTime: string; label: string }[];
}
  daysOff: DayOfWeek[];
  breaks: { startTime: string; endTime: string; label: string }[];
}

// Travel time in minutes between two location IDs
// Key format: "locA_id|locB_id" (sorted alphabetically so it's bidirectional)
export type TravelTimeMatrix = Record<string, number>;

export function travelKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export interface ScheduledVisit {
  clientId: string;
  startTime: string; // "HH:MM"
  endTime: string;
  travelTimeFromPrev: number; // minutes
}

export interface DaySchedule {
  day: DayOfWeek;
  date: string; // ISO date string
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
}

export interface Workspace {
  version: 1;
  worker: WorkerProfile;
  clients: Client[];
  travelTimes: TravelTimeMatrix;
  lastSchedule: WeekSchedule | null;
}

export const DEFAULT_WORKSPACE: Workspace = {
  version: 1,
  worker: {
    name: '',
    homeAddress: '',
    workingHours: { startTime: '08:00', endTime: '17:00' },
    daysOff: ['saturday', 'sunday'],
    breaks: [{ startTime: '12:00', endTime: '13:00', label: 'Lunch' }],
  },
  clients: [],
  travelTimes: {},
  lastSchedule: null,
};

export const DEFAULT_TRAVEL_TIME = 15; // minutes
