import {
  type Client, type WorkerProfile, type TravelTimeMatrix, type DayOfWeek,
  type DaySchedule, type WeekSchedule, type ScheduledVisit, type TimeWindow,
  DAYS_OF_WEEK, travelKey, DEFAULT_TRAVEL_TIME,
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

function shouldScheduleThisWeek(client: Client, weekIndex: number): boolean {
  if (client.frequency === 'weekly') return true;
  if (client.frequency === 'biweekly') return weekIndex % 2 === 0;
  if (client.frequency === 'monthly') return weekIndex % 4 === 0;
  return true;
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
  const eligibleClients = clients.filter(c => shouldScheduleThisWeek(c, weekIndex));
  const workStart = timeToMinutes(worker.workingHours.startTime);
  const workEnd = timeToMinutes(worker.workingHours.endTime);

  const days: DaySchedule[] = [];
  const scheduledClientIds = new Set<string>();

  // Priority order: high first
  const priorityOrder = { high: 0, medium: 1, low: 2 };

  for (const day of DAYS_OF_WEEK) {
    if (worker.daysOff.includes(day)) continue;

    // Gather candidates for this day
    const candidates: CandidateVisit[] = [];
    for (const client of eligibleClients) {
      // Each client should only be scheduled once per week
      if (scheduledClientIds.has(client.id)) continue;
      const window = getClientWindowForDay(client, day);
      if (window) {
        candidates.push({ client, window });
      }
    }

    // Sort by priority
    candidates.sort((a, b) => priorityOrder[a.client.priority] - priorityOrder[b.client.priority]);

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
      scheduledClientIds.add(chosen.client.id);
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
