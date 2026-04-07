import {
  type Client, type WorkerProfile, type TravelTimeMatrix, type DayOfWeek,
  type DaySchedule, type WeekSchedule, type ScheduledVisit, type TimeWindow,
  type SchedulingStrategy,
  DAYS_OF_WEEK, travelKey, DEFAULT_TRAVEL_TIME, frequencyToVisits,
} from '@/types/models';

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(m: number): string {
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function getTravelTime(matrix: TravelTimeMatrix, a: string, b: string): number {
  return matrix[travelKey(a, b)] ?? DEFAULT_TRAVEL_TIME;
}

function getClientWindowForDay(client: Client, day: DayOfWeek): TimeWindow | null {
  return client.timeWindows.find(tw => tw.day === day) ?? null;
}

/** How many visits this client needs this week */
function visitsNeededThisWeek(client: Client, weekIndex: number): number {
  // Support new format
  const vpp = client.visitsPerPeriod ?? 1;
  const period = client.period;

  // Legacy frequency field migration
  if (!period && (client as any).frequency) {
    const converted = frequencyToVisits((client as any).frequency);
    return visitsNeededForPeriod(converted.visitsPerPeriod, converted.period, weekIndex);
  }

  return visitsNeededForPeriod(vpp, period ?? 'week', weekIndex);
}

function visitsNeededForPeriod(visitsPerPeriod: number, period: string, weekIndex: number): number {
  switch (period) {
    case 'week': return visitsPerPeriod;
    case '2weeks': return weekIndex % 2 === 0 ? visitsPerPeriod : 0;
    case 'month': return weekIndex % 4 === 0 ? visitsPerPeriod : 0;
    default: return visitsPerPeriod;
  }
}

// Check if a time range overlaps with any worker break
function overlapsBreak(startMin: number, endMin: number, worker: WorkerProfile): boolean {
  return worker.breaks.some(b => {
    const bs = timeToMinutes(b.startTime);
    const be = timeToMinutes(b.endTime);
    return startMin < be && endMin > bs;
  });
}

// Adjust start time to avoid breaks
function adjustForBreaks(startMin: number, duration: number, worker: WorkerProfile): number {
  let adjusted = startMin;
  for (const b of worker.breaks) {
    const bs = timeToMinutes(b.startTime);
    const be = timeToMinutes(b.endTime);
    if (adjusted < be && adjusted + duration > bs) {
      adjusted = be; // push after break
    }
  }
  return adjusted;
}

interface CandidateVisit {
  client: Client;
  window: TimeWindow;
}

export function generateWeekSchedule(
  worker: WorkerProfile,
  clients: Client[],
  travelTimes: TravelTimeMatrix,
  weekStartDate: string,
  weekIndex: number = 0,
): WeekSchedule {
  const workStart = timeToMinutes(worker.workingHours.startTime);
  const workEnd = timeToMinutes(worker.workingHours.endTime);

  // Track how many times each client has been scheduled this week
  const visitCounts = new Map<string, number>();
  // Track how many visits each client needs
  const visitsNeeded = new Map<string, number>();

  for (const c of clients) {
    const needed = visitsNeededThisWeek(c, weekIndex);
    visitsNeeded.set(c.id, needed);
    visitCounts.set(c.id, 0);
  }

  const days: DaySchedule[] = [];
  const priorityOrder = { high: 0, medium: 1, low: 2 };

  // Build the list of working days
  const workingDays = DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d));
  const strategy: SchedulingStrategy = worker.schedulingStrategy ?? 'spread';

  // Assign each client a "preferred day set" based on strategy
  // For 'alternate': even-index clients prefer day indices 0,2,4; odd-index prefer 1,3
  // For 'spread': distribute clients round-robin across days
  // For 'pack': no preference, just greedily fill days in order (original behavior)

  // Track which days each client has been scheduled on (for multi-visit clients)
  const clientScheduledDays = new Map<string, Set<DayOfWeek>>();

  for (const day of workingDays) {
    // Gather candidates: clients that still need more visits this week and are available today
    const candidates: CandidateVisit[] = [];
    for (const client of clients) {
      const needed = visitsNeeded.get(client.id) ?? 0;
      const scheduled = visitCounts.get(client.id) ?? 0;
      if (scheduled >= needed) continue;

      const window = getClientWindowForDay(client, day);
      if (window) {
        candidates.push({ client, window });
      }
    }

    // Sort by priority first
    candidates.sort((a, b) => {
      const pDiff = priorityOrder[a.client.priority] - priorityOrder[b.client.priority];
      if (pDiff !== 0) return pDiff;

      // Apply strategy-based day preference scoring
      const dayIdx = workingDays.indexOf(day);

      if (strategy === 'alternate') {
        // Prefer clients whose index parity matches the day parity (Mon/Wed/Fri vs Tue/Thu)
        const aClientIdx = clients.indexOf(a.client);
        const bClientIdx = clients.indexOf(b.client);
        const aMatch = (aClientIdx % 2 === dayIdx % 2) ? 0 : 1;
        const bMatch = (bClientIdx % 2 === dayIdx % 2) ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
      } else if (strategy === 'spread') {
        // Prefer clients who have been scheduled on fewer days so far
        const aScheduledDays = clientScheduledDays.get(a.client.id)?.size ?? 0;
        const bScheduledDays = clientScheduledDays.get(b.client.id)?.size ?? 0;
        // Prefer less-scheduled clients
        if (aScheduledDays !== bScheduledDays) return aScheduledDays - bScheduledDays;
        // Among equally scheduled, prefer clients whose "home day" matches
        // Distribute by assigning each client a preferred day slot
        const aPreferred = clients.indexOf(a.client) % workingDays.length;
        const bPreferred = clients.indexOf(b.client) % workingDays.length;
        const aDist = Math.abs(dayIdx - aPreferred);
        const bDist = Math.abs(dayIdx - bPreferred);
        if (aDist !== bDist) return aDist - bDist;
      }

      const aRemaining = (visitsNeeded.get(a.client.id) ?? 0) - (visitCounts.get(a.client.id) ?? 0);
      const bRemaining = (visitsNeeded.get(b.client.id) ?? 0) - (visitCounts.get(b.client.id) ?? 0);
      return bRemaining - aRemaining;
    });

    // Nearest-neighbor greedy scheduling
    const visits: ScheduledVisit[] = [];
    let currentTime = workStart;
    let currentLocationId = 'home';
    const usedIds = new Set<string>();

    while (candidates.length > 0) {
      let bestIdx = -1;
      let bestArrival = Infinity;

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (usedIds.has(c.client.id)) continue;

        const travel = getTravelTime(travelTimes, currentLocationId, c.client.id);
        const windowStart = timeToMinutes(c.window.startTime);
        const windowEnd = timeToMinutes(c.window.endTime);
        let arrival = Math.max(currentTime + travel, windowStart);
        arrival = adjustForBreaks(arrival, c.client.visitDurationMinutes, worker);

        if (arrival + c.client.visitDurationMinutes <= windowEnd &&
            arrival + c.client.visitDurationMinutes <= workEnd) {
          if (arrival < bestArrival) {
            bestArrival = arrival;
            bestIdx = i;
          }
        }
      }

      if (bestIdx === -1) break;

      const chosen = candidates[bestIdx];
      const travel = getTravelTime(travelTimes, currentLocationId, chosen.client.id);

      visits.push({
        clientId: chosen.client.id,
        startTime: minutesToTime(bestArrival),
        endTime: minutesToTime(bestArrival + chosen.client.visitDurationMinutes),
        travelTimeFromPrev: travel,
      });

      currentTime = bestArrival + chosen.client.visitDurationMinutes;
      currentLocationId = chosen.client.id;
      usedIds.add(chosen.client.id);
      visitCounts.set(chosen.client.id, (visitCounts.get(chosen.client.id) ?? 0) + 1);
      candidates.splice(bestIdx, 1);
    }

    if (visits.length === 0) continue;

    const travelHome = getTravelTime(travelTimes, currentLocationId, 'home');
    const totalTravel = visits.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;

    const dayIndex = DAYS_OF_WEEK.indexOf(day);
    const dateObj = new Date(weekStartDate);
    dateObj.setDate(dateObj.getDate() + dayIndex);

    days.push({
      day,
      date: dateObj.toISOString().split('T')[0],
      visits,
      totalTravelMinutes: totalTravel,
      leaveHomeTime: minutesToTime(
        timeToMinutes(visits[0].startTime) - visits[0].travelTimeFromPrev
      ),
      arriveHomeTime: minutesToTime(currentTime + travelHome),
    });
  }

  const totalTravel = days.reduce((s, d) => s + d.totalTravelMinutes, 0);
  const totalAway = days.reduce((s, d) => {
    return s + (timeToMinutes(d.arriveHomeTime) - timeToMinutes(d.leaveHomeTime));
  }, 0);

  return {
    weekStartDate,
    days,
    totalTravelMinutes: totalTravel,
    totalTimeAwayMinutes: totalAway,
  };
}
