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
export type SchedulePeriod = 'week' | '2weeks' | 'month';
export type Priority = 'high' | 'medium' | 'low';
export type SchedulingStrategy = 'pack' | 'alternate' | 'spread';

export const STRATEGY_LABELS: Record<SchedulingStrategy, string> = {
  pack: 'Pack days (Mon-Tue, Wed-Thu)',
  alternate: 'Alternate days (Mon→Wed, Tue→Thu mirror)',
  spread: 'Spread evenly across the week',
};

export const PERIOD_LABELS: Record<SchedulePeriod, string> = {
  week: 'per week',
  '2weeks': 'per 2 weeks',
  month: 'per month',
};

/** Convert legacy Frequency to new visits-per-period format */
export function frequencyToVisits(freq: Frequency): { visitsPerPeriod: number; period: SchedulePeriod } {
  switch (freq) {
    case 'weekly': return { visitsPerPeriod: 1, period: 'week' };
    case 'biweekly': return { visitsPerPeriod: 1, period: '2weeks' };
    case 'monthly': return { visitsPerPeriod: 1, period: 'month' };
  }
}

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
  /** @deprecated Use visitsPerPeriod + period instead */
  frequency?: Frequency;
  visitsPerPeriod: number;
  period: SchedulePeriod;
  priority: Priority;
  timeWindows: TimeWindow[];
  notes: string;
  /** When true, the client is kept in the roster but excluded from auto-generated schedules. */
  excludedFromSchedule?: boolean;
}

export interface WorkerProfile {
  name: string;
  homeAddress: string;
  homeCoords?: Coords;
  workingHours: { startTime: string; endTime: string };
  daysOff: DayOfWeek[];
  /** Weekdays kept open for manual visits (make-ups, evals); excluded from auto scheduling. Not days off. */
  makeUpDays: DayOfWeek[];
  breaks: { startTime: string; endTime: string; label: string }[];
  schedulingStrategy: SchedulingStrategy;
}

/** Days shown in calendar / manual editing: not marked as days off. */
export function visibleCalendarDays(worker: WorkerProfile): DayOfWeek[] {
  return DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d));
}

/** Days used for automatic visit placement: working and not make-up. */
export function autoSchedulingDays(worker: WorkerProfile): DayOfWeek[] {
  const makeup = worker.makeUpDays ?? [];
  return DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d) && !makeup.includes(d));
}


// Travel time in minutes between two location IDs
// Key format: "locA_id|locB_id" (sorted alphabetically so it's bidirectional)
export type TravelTimeMatrix = Record<string, number>;

// Track which travel time pairs had errors
export type TravelTimeErrors = Record<string, string>;

export function travelKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export interface ScheduledVisit {
  clientId: string;
  startTime: string; // "HH:MM"
  endTime: string;
  travelTimeFromPrev: number; // minutes
  travelDistanceMiFromPrev?: number; // miles
  manuallyPlaced?: boolean; // true if user manually dragged this visit
}

export interface DaySchedule {
  day: DayOfWeek;
  date: string; // ISO date string
  visits: ScheduledVisit[];
  totalTravelMinutes: number;
  leaveHomeTime: string;
  arriveHomeTime: string;
}

export interface UnmetVisit {
  clientId: string;
  /** How many of the client's required visits could not be placed this week */
  missing: number;
}

export interface WeekSchedule {
  weekStartDate: string;
  days: DaySchedule[];
  totalTravelMinutes: number;
  totalTimeAwayMinutes: number;
  /** Client ID → group label (e.g. "A" or "B") for alternate strategy */
  clientGroups?: Record<string, string>;
  /** Visits required but unplaced. Empty/undefined = fully scheduled. */
  unmetVisits?: UnmetVisit[];
  /** Smallest set of client IDs whose exclusion would let the schedule fit. */
  recommendedDrops?: string[];
}

export interface SavedSchedule {
  id: string;
  name: string;
  savedAt: string; // ISO timestamp
  schedule: WeekSchedule;
}

export interface Workspace {
  version: 1;
  worker: WorkerProfile;
  clients: Client[];
  travelTimes: TravelTimeMatrix;
  travelTimeErrors?: TravelTimeErrors;
  lastSchedule: WeekSchedule | null;
  savedSchedules?: SavedSchedule[];
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

export const DEFAULT_TRAVEL_TIME = 15; // minutes

/** Estimate drive time in minutes from lat/lon using haversine + average speed */
export function estimateTravelMinutes(a: Coords, b: Coords): number {
  const R = 6371; // km
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  const distKm = 2 * R * Math.asin(Math.sqrt(h));
  // Assume ~40 km/h average driving speed with 1.3x road winding factor
  const driveKm = distKm * 1.3;
  return Math.max(5, Math.round(driveKm / 40 * 60));
}
