import {
  type Client, type WorkerProfile, type TravelTimeMatrix, type DayOfWeek,
  type DaySchedule, type WeekSchedule, type ScheduledVisit, type TimeWindow,
  type SchedulingStrategy,
  DAYS_OF_WEEK, travelKey, DEFAULT_TRAVEL_TIME, frequencyToVisits,
} from '@/types/models';

const BLOCK_SIZE = 15; // schedule in 15-minute blocks

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(m: number): string {
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** Round up to the next 15-minute boundary */
function roundUpToBlock(minutes: number): number {
  return Math.ceil(minutes / BLOCK_SIZE) * BLOCK_SIZE;
}

function getTravelTime(matrix: TravelTimeMatrix, a: string, b: string): number {
  return matrix[travelKey(a, b)] ?? DEFAULT_TRAVEL_TIME;
}

function getClientWindowForDay(client: Client, day: DayOfWeek): TimeWindow | null {
  return client.timeWindows.find(tw => tw.day === day) ?? null;
}

/** How many visits this client needs this week */
function visitsNeededThisWeek(client: Client, weekIndex: number): number {
  const vpp = client.visitsPerPeriod ?? 1;
  const period = client.period;
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

function adjustForBreaks(startMin: number, duration: number, worker: WorkerProfile): number {
  let adjusted = startMin;
  for (const b of worker.breaks) {
    const bs = timeToMinutes(b.startTime);
    const be = timeToMinutes(b.endTime);
    if (adjusted < be && adjusted + duration > bs) {
      adjusted = be;
    }
  }
  return adjusted;
}

interface CandidateVisit {
  client: Client;
  window: TimeWindow;
}

/** Try to insert a client into an existing day schedule, returns updated schedule or null */
function tryInsertClient(
  daySchedule: DaySchedule,
  client: Client,
  window: TimeWindow,
  worker: WorkerProfile,
  travelTimes: TravelTimeMatrix,
  clients: Client[],
): DaySchedule | null {
  const workEnd = timeToMinutes(worker.workingHours.endTime);
  const workStart = timeToMinutes(worker.workingHours.startTime);
  const windowStart = timeToMinutes(window.startTime);
  const windowEnd = timeToMinutes(window.endTime);

  // Try inserting at each position (including end)
  for (let pos = 0; pos <= daySchedule.visits.length; pos++) {
    const prevId = pos === 0 ? 'home' : daySchedule.visits[pos - 1].clientId;
    const nextId = pos < daySchedule.visits.length ? daySchedule.visits[pos].clientId : 'home';

    const travelToPrev = getTravelTime(travelTimes, prevId, client.id);
    const travelToNext = getTravelTime(travelTimes, client.id, nextId);

    // Calculate arrival time at this position
    let prevEndTime: number;
    if (pos === 0) {
      prevEndTime = workStart;
    } else {
      prevEndTime = timeToMinutes(daySchedule.visits[pos - 1].endTime);
    }

    let arrival = Math.max(prevEndTime + travelToPrev, windowStart);
    arrival = roundUpToBlock(arrival);
    arrival = adjustForBreaks(arrival, client.visitDurationMinutes, worker);

    if (arrival + client.visitDurationMinutes > windowEnd) continue;
    if (arrival + client.visitDurationMinutes > workEnd) continue;

    // Check if subsequent visits can still fit after this insertion
    let canFit = true;
    let currentTime = arrival + client.visitDurationMinutes;
    const newVisits = [...daySchedule.visits];

    // Rebuild times for visits after insertion point
    const rebuiltVisits: ScheduledVisit[] = [];
    for (let j = pos; j < newVisits.length; j++) {
      const v = newVisits[j];
      const vClient = clients.find(c => c.id === v.clientId);
      if (!vClient) { canFit = false; break; }

      const vWindow = getClientWindowForDay(vClient, daySchedule.day);
      if (!vWindow) { canFit = false; break; }

      const fromId = j === pos ? client.id : newVisits[j - 1].clientId;
      const travel = getTravelTime(travelTimes, fromId, v.clientId);
      let vArrival = Math.max(currentTime + travel, timeToMinutes(vWindow.startTime));
      vArrival = roundUpToBlock(vArrival);
      vArrival = adjustForBreaks(vArrival, vClient.visitDurationMinutes, worker);

      if (vArrival + vClient.visitDurationMinutes > timeToMinutes(vWindow.endTime) ||
          vArrival + vClient.visitDurationMinutes > workEnd) {
        canFit = false;
        break;
      }

      rebuiltVisits.push({
        clientId: v.clientId,
        startTime: minutesToTime(vArrival),
        endTime: minutesToTime(vArrival + vClient.visitDurationMinutes),
        travelTimeFromPrev: travel,
      });
      currentTime = vArrival + vClient.visitDurationMinutes;
    }

    if (!canFit) continue;

    // Build the new visit list
    const insertedVisit: ScheduledVisit = {
      clientId: client.id,
      startTime: minutesToTime(arrival),
      endTime: minutesToTime(arrival + client.visitDurationMinutes),
      travelTimeFromPrev: travelToPrev,
    };

    const finalVisits = [
      ...newVisits.slice(0, pos),
      insertedVisit,
      ...rebuiltVisits,
    ];

    // Recalculate day stats
    const lastVisit = finalVisits[finalVisits.length - 1];
    const lastClientId = lastVisit.clientId;
    const travelHome = getTravelTime(travelTimes, lastClientId, 'home');
    const totalTravel = finalVisits.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;
    const leaveHomeTime = minutesToTime(timeToMinutes(finalVisits[0].startTime) - finalVisits[0].travelTimeFromPrev);
    const arriveHomeTime = minutesToTime(timeToMinutes(lastVisit.endTime) + travelHome);

    return {
      ...daySchedule,
      visits: finalVisits,
      totalTravelMinutes: totalTravel,
      leaveHomeTime,
      arriveHomeTime,
    };
  }

  return null;
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

  const visitCounts = new Map<string, number>();
  const visitsNeeded = new Map<string, number>();
  const originalNeeded = new Map<string, number>();

  const strategyEarly: SchedulingStrategy = worker.schedulingStrategy ?? 'spread';
  for (const c of clients) {
    const needed = visitsNeededThisWeek(c, weekIndex);
    originalNeeded.set(c.id, needed);
    // In alternate mode, primary days carry half the visits; the mirror provides the rest.
    const primaryNeed = strategyEarly === 'alternate' ? Math.ceil(needed / 2) : needed;
    visitsNeeded.set(c.id, primaryNeed);
    visitCounts.set(c.id, 0);
  }

  const days: DaySchedule[] = [];
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const workingDays = DAYS_OF_WEEK.filter(d => !worker.daysOff.includes(d));
  const strategy: SchedulingStrategy = worker.schedulingStrategy ?? 'spread';
  const clientScheduledDays = new Map<string, Set<DayOfWeek>>();

  // Alternate strategy: split working days into two halves; schedule the first
  // half normally, then mirror those days onto the matching second-half days.
  // E.g. with Mon-Thu working: schedule Mon & Tue, then copy → Wed & Thu.
  const halfSize = Math.ceil(workingDays.length / 2);
  const primaryDays = strategy === 'alternate' ? workingDays.slice(0, halfSize) : workingDays;
  const mirrorPairs: Array<{ source: DayOfWeek; target: DayOfWeek }> = [];
  if (strategy === 'alternate') {
    for (let i = 0; i < halfSize; i++) {
      const target = workingDays[i + halfSize];
      if (target) mirrorPairs.push({ source: workingDays[i], target });
    }
  }

  // Alternate strategy: pre-assign clients to a single primary day (group A only).
  // Mirror days will receive duplicates of the primary day's visits.
  const clientDayGroup = new Map<string, Set<number>>();
  if (strategy === 'alternate') {
    const allowed = new Set<number>();
    primaryDays.forEach((_, i) => allowed.add(i));
    for (const client of clients) {
      clientDayGroup.set(client.id, allowed);
    }
  }

  // --- PASS 1: Main greedy scheduling ---
  const schedulingDays = strategy === 'alternate' ? primaryDays : workingDays;
  for (const day of schedulingDays) {
    const dayIdx = workingDays.indexOf(day);

    const candidates: CandidateVisit[] = [];
    for (const client of clients) {
      const needed = visitsNeeded.get(client.id) ?? 0;
      const scheduled = visitCounts.get(client.id) ?? 0;
      if (scheduled >= needed) continue;

      if (strategy === 'alternate') {
        const allowedDays = clientDayGroup.get(client.id);
        if (allowedDays && !allowedDays.has(dayIdx)) continue;
      }

      const window = getClientWindowForDay(client, day);
      if (window) candidates.push({ client, window });
    }

    candidates.sort((a, b) => {
      const pDiff = priorityOrder[a.client.priority] - priorityOrder[b.client.priority];
      if (pDiff !== 0) return pDiff;

      if (strategy === 'spread' || strategy === 'alternate') {
        const aSD = clientScheduledDays.get(a.client.id)?.size ?? 0;
        const bSD = clientScheduledDays.get(b.client.id)?.size ?? 0;
        if (aSD !== bSD) return aSD - bSD;
      }
      if (strategy === 'spread') {
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
        arrival = roundUpToBlock(arrival);
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
      if (!clientScheduledDays.has(chosen.client.id)) clientScheduledDays.set(chosen.client.id, new Set());
      clientScheduledDays.get(chosen.client.id)!.add(day);
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
      leaveHomeTime: minutesToTime(timeToMinutes(visits[0].startTime) - visits[0].travelTimeFromPrev),
      arriveHomeTime: minutesToTime(currentTime + travelHome),
    });
  }

  // --- PASS 2: Try to fit unscheduled clients by relaxing constraints ---
  const unscheduled = clients.filter(c => {
    const needed = visitsNeeded.get(c.id) ?? 0;
    const scheduled = visitCounts.get(c.id) ?? 0;
    return needed > 0 && scheduled < needed;
  });

  // Sort unscheduled by priority (high first)
  unscheduled.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  for (const client of unscheduled) {
    const remaining = (visitsNeeded.get(client.id) ?? 0) - (visitCounts.get(client.id) ?? 0);

    for (let v = 0; v < remaining; v++) {
      let placed = false;

      // Try each primary day (no day-group restriction in pass 2; mirror handled later)
      for (const day of schedulingDays) {
        if (placed) break;

        const window = getClientWindowForDay(client, day);
        if (!window) continue;

        // Already on this day?
        const existingDay = days.find(d => d.day === day);

        if (existingDay) {
          if (existingDay.visits.some(vis => vis.clientId === client.id)) continue;
          const updated = tryInsertClient(existingDay, client, window, worker, travelTimes, clients);
          if (updated) {
            const idx = days.indexOf(existingDay);
            days[idx] = updated;
            visitCounts.set(client.id, (visitCounts.get(client.id) ?? 0) + 1);
            placed = true;
          }
        } else {
          // Create a new day schedule
          const travel = getTravelTime(travelTimes, 'home', client.id);
          const windowStart = timeToMinutes(window.startTime);
          let arrival = Math.max(workStart + travel, windowStart);
          arrival = roundUpToBlock(arrival);
          arrival = adjustForBreaks(arrival, client.visitDurationMinutes, worker);

          if (arrival + client.visitDurationMinutes <= timeToMinutes(window.endTime) &&
              arrival + client.visitDurationMinutes <= workEnd) {
            const travelHome = getTravelTime(travelTimes, client.id, 'home');
            const dayIndex = DAYS_OF_WEEK.indexOf(day);
            const dateObj = new Date(weekStartDate);
            dateObj.setDate(dateObj.getDate() + dayIndex);

            days.push({
              day,
              date: dateObj.toISOString().split('T')[0],
              visits: [{
                clientId: client.id,
                startTime: minutesToTime(arrival),
                endTime: minutesToTime(arrival + client.visitDurationMinutes),
                travelTimeFromPrev: travel,
              }],
              totalTravelMinutes: travel + travelHome,
              leaveHomeTime: minutesToTime(arrival - travel),
              arriveHomeTime: minutesToTime(arrival + client.visitDurationMinutes + travelHome),
            });
            visitCounts.set(client.id, (visitCounts.get(client.id) ?? 0) + 1);
            placed = true;
          }
        }
      }
    }
  }

  // --- Mirror primary days onto target days for alternate strategy ---
  // Track total scheduled visits per client across primary + mirror so we can
  // trim duplicates that would exceed the client's actual needed-visit count.
  if (strategy === 'alternate' && mirrorPairs.length > 0) {
    const totalScheduled = new Map<string, number>();
    for (const d of days) {
      for (const v of d.visits) {
        totalScheduled.set(v.clientId, (totalScheduled.get(v.clientId) ?? 0) + 1);
      }
    }

    for (const { source, target } of mirrorPairs) {
      const src = days.find(d => d.day === source);
      if (!src) continue;

      // Build mirrored visits, dropping any that would exceed the client's needed total.
      const mirroredVisits: ScheduledVisit[] = [];
      for (const v of src.visits) {
        const need = originalNeeded.get(v.clientId) ?? 0;
        const have = totalScheduled.get(v.clientId) ?? 0;
        if (have >= need) continue;
        mirroredVisits.push({ ...v });
        totalScheduled.set(v.clientId, have + 1);
      }

      if (mirroredVisits.length === 0) continue;

      const dayIndex = DAYS_OF_WEEK.indexOf(target);
      const dateObj = new Date(weekStartDate);
      dateObj.setDate(dateObj.getDate() + dayIndex);

      // If the mirrored visit list matches the source exactly, reuse source totals;
      // otherwise recalc travel home from the last visit.
      const lastVisit = mirroredVisits[mirroredVisits.length - 1];
      const travelHome = getTravelTime(travelTimes, lastVisit.clientId, 'home');
      const totalTravel = mirroredVisits.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;
      const leaveHomeTime = minutesToTime(timeToMinutes(mirroredVisits[0].startTime) - mirroredVisits[0].travelTimeFromPrev);
      const arriveHomeTime = minutesToTime(timeToMinutes(lastVisit.endTime) + travelHome);

      days.push({
        day: target,
        date: dateObj.toISOString().split('T')[0],
        visits: mirroredVisits,
        totalTravelMinutes: totalTravel,
        leaveHomeTime,
        arriveHomeTime,
      });
    }
  }

  // Sort days by weekday order
  days.sort((a, b) => DAYS_OF_WEEK.indexOf(a.day) - DAYS_OF_WEEK.indexOf(b.day));

  const totalTravel = days.reduce((s, d) => s + d.totalTravelMinutes, 0);
  const totalAway = days.reduce((s, d) => {
    return s + (timeToMinutes(d.arriveHomeTime) - timeToMinutes(d.leaveHomeTime));
  }, 0);

  // Build client group map for display: A = primary day, B = mirror day
  const clientGroups: Record<string, string> = {};
  if (strategy === 'alternate') {
    const primarySet = new Set<DayOfWeek>(primaryDays);
    const mirrorSet = new Set<DayOfWeek>(mirrorPairs.map(p => p.target));
    for (const c of clients) {
      const onPrimary = days.some(d => primarySet.has(d.day) && d.visits.some(v => v.clientId === c.id));
      const onMirror = days.some(d => mirrorSet.has(d.day) && d.visits.some(v => v.clientId === c.id));
      if (onPrimary && onMirror) clientGroups[c.id] = 'A+B';
      else if (onPrimary) clientGroups[c.id] = 'A';
      else if (onMirror) clientGroups[c.id] = 'B';
    }
  }

  return {
    weekStartDate,
    days,
    totalTravelMinutes: totalTravel,
    totalTimeAwayMinutes: totalAway,
    clientGroups: strategy === 'alternate' ? clientGroups : undefined,
  };
}

/** Recalculate times for a day schedule given a new visit order */
export function recalcDaySchedule(
  visits: ScheduledVisit[],
  day: DayOfWeek,
  date: string,
  worker: WorkerProfile,
  clients: Client[],
  travelTimes: TravelTimeMatrix,
): DaySchedule | null {
  const workStart = timeToMinutes(worker.workingHours.startTime);
  const workEnd = timeToMinutes(worker.workingHours.endTime);

  const rebuilt: ScheduledVisit[] = [];
  let currentTime = workStart;
  let currentLocationId = 'home';

  for (const v of visits) {
    const client = clients.find(c => c.id === v.clientId);
    if (!client) continue;

    const window = getClientWindowForDay(client, day);
    const windowStart = window ? timeToMinutes(window.startTime) : workStart;

    const travel = getTravelTime(travelTimes, currentLocationId, client.id);
    const earliest = Math.max(currentTime + travel, windowStart);

    // If the visit already has a manually-set start time, respect it
    // (as long as it's not before the earliest feasible time)
    const manualStart = v.startTime !== '00:00' ? timeToMinutes(v.startTime) : 0;
    let arrival = manualStart > earliest ? manualStart : earliest;
    arrival = roundUpToBlock(arrival);
    arrival = adjustForBreaks(arrival, client.visitDurationMinutes, worker);

    rebuilt.push({
      clientId: client.id,
      startTime: minutesToTime(arrival),
      endTime: minutesToTime(arrival + client.visitDurationMinutes),
      travelTimeFromPrev: travel,
    });

    currentTime = arrival + client.visitDurationMinutes;
    currentLocationId = client.id;
  }

  if (rebuilt.length === 0) return null;

  const travelHome = getTravelTime(travelTimes, currentLocationId, 'home');
  const totalTravel = rebuilt.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;

  return {
    day,
    date,
    visits: rebuilt,
    totalTravelMinutes: totalTravel,
    leaveHomeTime: minutesToTime(timeToMinutes(rebuilt[0].startTime) - rebuilt[0].travelTimeFromPrev),
    arriveHomeTime: minutesToTime(currentTime + travelHome),
  };
}
