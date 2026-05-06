import {
  type Client, type WorkerProfile, type TravelTimeMatrix, type DayOfWeek,
  type DaySchedule, type WeekSchedule, type ScheduledVisit, type TimeWindow,
  type SchedulingStrategy, type UnmetVisit,
  DAYS_OF_WEEK, travelKey, DEFAULT_TRAVEL_TIME, frequencyToVisits,
} from '@/types/models';

const BLOCK_SIZE = 15; // schedule in 15-minute blocks
const PERMUTATION_LIMIT = 8; // up to 8! = 40320 permutations

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

// =============================================================================
// PHASE 2 — Per-day route + timing optimizer
// =============================================================================

interface RouteResult {
  visits: ScheduledVisit[];
  leaveHome: number; // minutes
  arriveHome: number; // minutes
  totalTravel: number;
  span: number; // arriveHome - leaveHome
}

/**
 * Forward pass: given an ordering of clients, compute earliest feasible
 * arrival times respecting windows, breaks, work end. Returns null if any
 * visit fails to fit.
 */
function buildForwardSchedule(
  order: Client[],
  day: DayOfWeek,
  worker: WorkerProfile,
  travelTimes: TravelTimeMatrix,
): RouteResult | null {
  const workStart = timeToMinutes(worker.workingHours.startTime);
  const workEnd = timeToMinutes(worker.workingHours.endTime);

  const visits: ScheduledVisit[] = [];
  let currentTime = workStart;
  let currentLocId = 'home';

  for (const client of order) {
    const window = getClientWindowForDay(client, day);
    if (!window) return null;
    const ws = timeToMinutes(window.startTime);
    const we = timeToMinutes(window.endTime);

    const travel = getTravelTime(travelTimes, currentLocId, client.id);
    let arrival = Math.max(currentTime + travel, ws);
    arrival = roundUpToBlock(arrival);
    arrival = adjustForBreaks(arrival, client.visitDurationMinutes, worker);

    const end = arrival + client.visitDurationMinutes;
    if (end > we || end > workEnd) return null;

    visits.push({
      clientId: client.id,
      startTime: minutesToTime(arrival),
      endTime: minutesToTime(end),
      travelTimeFromPrev: travel,
    });

    currentTime = end;
    currentLocId = client.id;
  }

  if (visits.length === 0) {
    return { visits: [], leaveHome: workStart, arriveHome: workStart, totalTravel: 0, span: 0 };
  }

  const travelHome = getTravelTime(travelTimes, currentLocId, 'home');
  const totalTravel = visits.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;
  const leaveHome = timeToMinutes(visits[0].startTime) - visits[0].travelTimeFromPrev;
  const arriveHome = currentTime + travelHome;

  return { visits, leaveHome, arriveHome, totalTravel, span: arriveHome - leaveHome };
}

/**
 * Right-shift the schedule: push the start of the day as late as possible
 * without violating any visit's window-end or work-end. This eliminates
 * morning idle time. Returns adjusted result.
 */
function rightShiftSchedule(
  order: Client[],
  result: RouteResult,
  day: DayOfWeek,
  worker: WorkerProfile,
  travelTimes: TravelTimeMatrix,
): RouteResult {
  if (result.visits.length === 0) return result;

  const workEnd = timeToMinutes(worker.workingHours.endTime);

  // Backward pass: latest-start times.
  // For visit i: latestStart[i] = min(window_end_i - duration, latestStart[i+1] - travel(i, i+1) - duration_i)
  const n = order.length;
  const latestStart: number[] = new Array(n);

  const lastClient = order[n - 1];
  const lastWindow = getClientWindowForDay(lastClient, day);
  if (!lastWindow) return result;
  const lastWe = timeToMinutes(lastWindow.endTime);
  latestStart[n - 1] = Math.min(lastWe, workEnd) - lastClient.visitDurationMinutes;
  // Floor to block
  latestStart[n - 1] = Math.floor(latestStart[n - 1] / BLOCK_SIZE) * BLOCK_SIZE;

  for (let i = n - 2; i >= 0; i--) {
    const client = order[i];
    const window = getClientWindowForDay(client, day);
    if (!window) return result;
    const we = timeToMinutes(window.endTime);
    const travel = getTravelTime(travelTimes, client.id, order[i + 1].id);
    const fromNext = latestStart[i + 1] - travel - client.visitDurationMinutes;
    let ls = Math.min(we - client.visitDurationMinutes, fromNext);
    ls = Math.floor(ls / BLOCK_SIZE) * BLOCK_SIZE;
    latestStart[i] = ls;
  }

  // Forward pass with shifted start: arrival[i] = max(arrival[i-1] + dur + travel, window_start, current arrival).
  // We push the first visit's start to min(latestStart[0], existing arrival shifted up by gap),
  // but must still respect breaks and window starts of later visits.
  // Simpler approach: for each visit, set arrival = max(window_start, prev_end + travel, latestStart-shift).
  // We try to start at latestStart[0] for first visit, then propagate forward with max(window_start, prev_end + travel),
  // but never exceed latestStart[i].

  const visits: ScheduledVisit[] = [];
  let currentTime = -Infinity;
  let currentLocId = 'home';

  for (let i = 0; i < n; i++) {
    const client = order[i];
    const window = getClientWindowForDay(client, day);
    if (!window) return result;
    const ws = timeToMinutes(window.startTime);
    const we = timeToMinutes(window.endTime);

    const travel = getTravelTime(travelTimes, currentLocId, client.id);

    let arrival: number;
    if (i === 0) {
      // Push as late as possible
      arrival = latestStart[0];
    } else {
      arrival = Math.max(currentTime + travel, ws);
      arrival = roundUpToBlock(arrival);
      arrival = adjustForBreaks(arrival, client.visitDurationMinutes, worker);
      // But don't exceed latest
      if (arrival > latestStart[i]) {
        // Shouldn't happen if forward schedule was feasible, but bail to original.
        return result;
      }
    }

    // Final check
    if (arrival < ws) arrival = ws;
    arrival = roundUpToBlock(arrival);
    arrival = adjustForBreaks(arrival, client.visitDurationMinutes, worker);
    const end = arrival + client.visitDurationMinutes;
    if (end > we || end > workEnd) return result;

    visits.push({
      clientId: client.id,
      startTime: minutesToTime(arrival),
      endTime: minutesToTime(end),
      travelTimeFromPrev: travel,
    });

    currentTime = end;
    currentLocId = client.id;
  }

  const travelHome = getTravelTime(travelTimes, currentLocId, 'home');
  const totalTravel = visits.reduce((s, v) => s + v.travelTimeFromPrev, 0) + travelHome;
  const leaveHome = timeToMinutes(visits[0].startTime) - visits[0].travelTimeFromPrev;
  const arriveHome = currentTime + travelHome;

  return { visits, leaveHome, arriveHome, totalTravel, span: arriveHome - leaveHome };
}

function* permutations<T>(arr: T[]): Generator<T[]> {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const sub of permutations(rest)) {
      yield [arr[i], ...sub];
    }
  }
}

/** Nearest-neighbor seed from home. */
function nearestNeighborOrder(clients: Client[], travelTimes: TravelTimeMatrix): Client[] {
  const remaining = clients.slice();
  const order: Client[] = [];
  let currentId = 'home';
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestT = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const t = getTravelTime(travelTimes, currentId, remaining[i].id);
      if (t < bestT) { bestT = t; bestIdx = i; }
    }
    order.push(remaining[bestIdx]);
    currentId = remaining[bestIdx].id;
    remaining.splice(bestIdx, 1);
  }
  return order;
}

/** 2-opt local search to reduce span. */
function twoOptOptimize(
  seed: Client[],
  day: DayOfWeek,
  worker: WorkerProfile,
  travelTimes: TravelTimeMatrix,
): { order: Client[]; result: RouteResult } | null {
  let bestOrder = seed.slice();
  let bestResult = buildForwardSchedule(bestOrder, day, worker, travelTimes);
  if (!bestResult) {
    // Try different seeds via random shuffles
    for (let attempt = 0; attempt < 20; attempt++) {
      const shuffled = bestOrder.slice().sort(() => Math.random() - 0.5);
      const r = buildForwardSchedule(shuffled, day, worker, travelTimes);
      if (r) { bestOrder = shuffled; bestResult = r; break; }
    }
    if (!bestResult) return null;
  }

  let improved = true;
  let iterations = 0;
  while (improved && iterations < 100) {
    improved = false;
    iterations++;
    for (let i = 0; i < bestOrder.length - 1; i++) {
      for (let j = i + 1; j < bestOrder.length; j++) {
        const candidate = bestOrder.slice();
        // Reverse segment [i..j]
        const seg = candidate.slice(i, j + 1).reverse();
        candidate.splice(i, j - i + 1, ...seg);
        const r = buildForwardSchedule(candidate, day, worker, travelTimes);
        if (r && r.span < bestResult!.span) {
          bestOrder = candidate;
          bestResult = r;
          improved = true;
        }
      }
    }
  }

  return { order: bestOrder, result: bestResult! };
}

/**
 * Find the best ordering for a day's clients to minimize away-from-home span.
 * Returns null if no feasible ordering exists.
 */
function optimizeDay(
  clientsForDay: Client[],
  day: DayOfWeek,
  date: string,
  worker: WorkerProfile,
  travelTimes: TravelTimeMatrix,
): DaySchedule | null {
  if (clientsForDay.length === 0) return null;

  let bestOrder: Client[] | null = null;
  let bestResult: RouteResult | null = null;

  if (clientsForDay.length <= PERMUTATION_LIMIT) {
    for (const perm of permutations(clientsForDay)) {
      const r = buildForwardSchedule(perm, day, worker, travelTimes);
      if (!r) continue;
      if (!bestResult || r.span < bestResult.span) {
        bestResult = r;
        bestOrder = perm;
      }
    }
  } else {
    const seed = nearestNeighborOrder(clientsForDay, travelTimes);
    const opt = twoOptOptimize(seed, day, worker, travelTimes);
    if (opt) {
      bestOrder = opt.order;
      bestResult = opt.result;
    }
  }

  if (!bestOrder || !bestResult) return null;

  // Right-shift to eliminate morning idle
  const shifted = rightShiftSchedule(bestOrder, bestResult, day, worker, travelTimes);

  return {
    day,
    date,
    visits: shifted.visits,
    totalTravelMinutes: shifted.totalTravel,
    leaveHomeTime: minutesToTime(shifted.leaveHome),
    arriveHomeTime: minutesToTime(shifted.arriveHome),
  };
}

// =============================================================================
// PHASE 1 — Assign visits to days
// =============================================================================

interface VisitAssignment {
  client: Client;
  day: DayOfWeek;
}

interface AssignmentResult {
  /** day → ordered client list (each entry = one visit) */
  perDay: Map<DayOfWeek, Client[]>;
  /** unmet visits: client → count missing */
  unmet: Map<string, number>;
}

/**
 * Greedily assign each required visit to a day. Sorts clients by:
 *   1) priority (high first)
 *   2) fewest eligible days (most constrained first)
 *   3) longest visit duration
 * For each visit, pick the eligible day with the most remaining slack.
 */
function assignVisitsToDays(
  clients: Client[],
  schedulingDays: DayOfWeek[],
  visitsNeededMap: Map<string, number>,
  worker: WorkerProfile,
  travelTimes: TravelTimeMatrix,
): AssignmentResult {
  const priorityOrder = { high: 0, medium: 1, low: 2 };

  // Build (client, eligibleDays, needed)
  const items = clients
    .map(c => {
      const eligible = schedulingDays.filter(d => getClientWindowForDay(c, d) !== null);
      return {
        client: c,
        eligible,
        needed: visitsNeededMap.get(c.id) ?? 0,
      };
    })
    .filter(it => it.needed > 0);

  items.sort((a, b) => {
    const pd = priorityOrder[a.client.priority] - priorityOrder[b.client.priority];
    if (pd !== 0) return pd;
    if (a.eligible.length !== b.eligible.length) return a.eligible.length - b.eligible.length;
    return b.client.visitDurationMinutes - a.client.visitDurationMinutes;
  });

  const perDay = new Map<DayOfWeek, Client[]>();
  for (const d of schedulingDays) perDay.set(d, []);
  const unmet = new Map<string, number>();

  for (const it of items) {
    let placed = 0;
    const usedDays = new Set<DayOfWeek>();
    for (let v = 0; v < it.needed; v++) {
      // Sort eligible days by current "load" (fewest visits = most slack), prefer days the client isn't already on
      const candidates = it.eligible
        .filter(d => !usedDays.has(d))
        .map(d => ({ day: d, load: perDay.get(d)!.length }))
        .sort((a, b) => a.load - b.load);

      let assignedThisVisit = false;
      for (const { day } of candidates) {
        const trial = perDay.get(day)!.concat(it.client);
        const test = optimizeDay(trial, day, '0000-00-00', worker, travelTimes);
        if (test) {
          perDay.set(day, trial);
          usedDays.add(day);
          placed++;
          assignedThisVisit = true;
          break;
        }
      }
      if (!assignedThisVisit) {
        // Try days the client is already on (allow same-day duplicates? No — visits are distinct days normally)
        // Skip; will count as unmet
        break;
      }
    }
    if (placed < it.needed) {
      unmet.set(it.client.id, it.needed - placed);
    }
  }

  return { perDay, unmet };
}

// =============================================================================
// PHASE 3 — Drop recommendations
// =============================================================================

/**
 * Find the smallest set of clients to drop so the remaining schedule is feasible.
 * Greedy: repeatedly drop the lowest-priority, most-constrained, longest-duration client
 * with unmet visits until everything fits.
 */
function recommendDrops(
  worker: WorkerProfile,
  clients: Client[],
  travelTimes: TravelTimeMatrix,
  schedulingDays: DayOfWeek[],
  visitsNeededMap: Map<string, number>,
  unmet: Map<string, number>,
): string[] {
  if (unmet.size === 0) return [];

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const drops: string[] = [];
  let activeClients = clients.slice();
  let currentUnmet = unmet;

  let safety = 0;
  while (currentUnmet.size > 0 && safety < clients.length) {
    safety++;

    // Score unmet clients to pick a drop candidate
    const candidates = Array.from(currentUnmet.keys())
      .map(id => activeClients.find(c => c.id === id)!)
      .filter(Boolean);

    if (candidates.length === 0) break;

    candidates.sort((a, b) => {
      // Lowest priority first (drop low before high)
      const pd = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (pd !== 0) return pd;
      // Most constrained first (fewer eligible windows)
      const aw = a.timeWindows.filter(tw => schedulingDays.includes(tw.day)).length;
      const bw = b.timeWindows.filter(tw => schedulingDays.includes(tw.day)).length;
      if (aw !== bw) return aw - bw;
      // Longest duration first
      return b.visitDurationMinutes - a.visitDurationMinutes;
    });

    const dropCandidate = candidates[0];
    drops.push(dropCandidate.id);
    activeClients = activeClients.filter(c => c.id !== dropCandidate.id);

    // Re-run assignment
    const newNeeded = new Map(visitsNeededMap);
    newNeeded.delete(dropCandidate.id);
    const result = assignVisitsToDays(activeClients, schedulingDays, newNeeded, worker, travelTimes);
    currentUnmet = result.unmet;
  }

  return drops;
}

// =============================================================================
// MAIN ENTRY
// =============================================================================

export function generateWeekSchedule(
  worker: WorkerProfile,
  allClients: Client[],
  travelTimes: TravelTimeMatrix,
  weekStartDate: string,
  weekIndex: number = 0,
): WeekSchedule {
  // Exclude clients explicitly removed from the schedule (kept in the roster).
  const clients = allClients.filter(c => !c.excludedFromSchedule);

  const makeup = worker.makeUpDays ?? [];
  const schedulingEligibleDays = DAYS_OF_WEEK.filter(
    d => !worker.daysOff.includes(d) && !makeup.includes(d),
  );
  const strategy: SchedulingStrategy = worker.schedulingStrategy ?? 'spread';

  // Alternate strategy: split auto-scheduling days into two halves; schedule the first
  // half normally, then mirror those days onto the matching second-half days.
  const halfSize = Math.ceil(schedulingEligibleDays.length / 2);
  const primaryDays = strategy === 'alternate' ? schedulingEligibleDays.slice(0, halfSize) : schedulingEligibleDays;
  const mirrorPairs: Array<{ source: DayOfWeek; target: DayOfWeek }> = [];
  if (strategy === 'alternate') {
    for (let i = 0; i < halfSize; i++) {
      const target = schedulingEligibleDays[i + halfSize];
      if (target) mirrorPairs.push({ source: schedulingEligibleDays[i], target });
    }
  }

  // Compute visits needed (alternate halves the primary load; mirror provides the other half)
  const originalNeeded = new Map<string, number>();
  const visitsNeededMap = new Map<string, number>();
  for (const c of clients) {
    const needed = visitsNeededThisWeek(c, weekIndex);
    originalNeeded.set(c.id, needed);
    const primaryNeed = strategy === 'alternate' ? Math.ceil(needed / 2) : needed;
    visitsNeededMap.set(c.id, primaryNeed);
  }

  const schedulingDays = strategy === 'alternate' ? primaryDays : schedulingEligibleDays;

  // Edge case: no auto-scheduling days (e.g. all off or all make-up)
  if (schedulingDays.length === 0) {
    const unmetVisits: UnmetVisit[] = clients
      .filter(c => (originalNeeded.get(c.id) ?? 0) > 0)
      .map(c => ({ clientId: c.id, missing: originalNeeded.get(c.id)! }));
    return {
      weekStartDate, days: [], totalTravelMinutes: 0, totalTimeAwayMinutes: 0,
      unmetVisits: unmetVisits.length > 0 ? unmetVisits : undefined,
      recommendedDrops: unmetVisits.map(u => u.clientId),
    };
  }

  // PHASE 1 — Assign visits to days
  const { perDay, unmet } = assignVisitsToDays(clients, schedulingDays, visitsNeededMap, worker, travelTimes);

  // PHASE 2 — Optimize each day's route
  const days: DaySchedule[] = [];
  for (const day of schedulingDays) {
    const list = perDay.get(day) ?? [];
    if (list.length === 0) continue;
    const dayIndex = DAYS_OF_WEEK.indexOf(day);
    const dateObj = new Date(weekStartDate);
    dateObj.setDate(dateObj.getDate() + dayIndex);
    const date = dateObj.toISOString().split('T')[0];

    const optimized = optimizeDay(list, day, date, worker, travelTimes);
    if (optimized) days.push(optimized);
  }

  // Mirror primary → target days for alternate strategy
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

    // For alternate strategy, recompute unmet against the original needed counts
    // since mirror covers the other half.
    const finalUnmet = new Map<string, number>();
    for (const c of clients) {
      const need = originalNeeded.get(c.id) ?? 0;
      const have = totalScheduled.get(c.id) ?? 0;
      if (have < need) finalUnmet.set(c.id, need - have);
    }
    unmet.clear();
    for (const [k, v] of finalUnmet) unmet.set(k, v);
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

  // PHASE 3 — Compute unmet + recommended drops
  const unmetVisits: UnmetVisit[] = Array.from(unmet.entries())
    .map(([clientId, missing]) => ({ clientId, missing }));

  let recommendedDrops: string[] | undefined;
  if (unmetVisits.length > 0) {
    recommendedDrops = recommendDrops(worker, clients, travelTimes, schedulingDays, visitsNeededMap, unmet);
  }

  return {
    weekStartDate,
    days,
    totalTravelMinutes: totalTravel,
    totalTimeAwayMinutes: totalAway,
    clientGroups: strategy === 'alternate' ? clientGroups : undefined,
    unmetVisits: unmetVisits.length > 0 ? unmetVisits : undefined,
    recommendedDrops,
  };
}

// =============================================================================
// Manual editing helpers (preserved for Schedule.tsx)
// =============================================================================

/** Try to insert a client into an existing day schedule, returns updated schedule or null */
export function tryInsertClient(
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

  for (let pos = 0; pos <= daySchedule.visits.length; pos++) {
    const prevId = pos === 0 ? 'home' : daySchedule.visits[pos - 1].clientId;
    const nextId = pos < daySchedule.visits.length ? daySchedule.visits[pos].clientId : 'home';

    const travelToPrev = getTravelTime(travelTimes, prevId, client.id);

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

    let canFit = true;
    let currentTime = arrival + client.visitDurationMinutes;
    const newVisits = [...daySchedule.visits];
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

/** Recalculate times for a day schedule given a new visit order */
export function recalcDaySchedule(
  visits: ScheduledVisit[],
  day: DayOfWeek,
  date: string,
  worker: WorkerProfile,
  clients: Client[],
  travelTimes: TravelTimeMatrix,
  preserveManualTimes?: boolean,
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

    const manualStart = v.startTime !== '00:00' ? timeToMinutes(v.startTime) : 0;

    let arrival: number;
    if (preserveManualTimes && v.manuallyPlaced && manualStart > 0) {
      // Only respect manually placed visits' times (allow travel overlap for these)
      arrival = manualStart;
    } else if (preserveManualTimes && manualStart > 0 && manualStart >= earliest) {
      // Non-manual visits: keep their time if it already works, but never overlap travel
      arrival = manualStart;
    } else {
      arrival = manualStart > earliest ? manualStart : earliest;
    }
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
    leaveHomeTime: minutesToTime(rebuilt[0].startTime ? timeToMinutes(rebuilt[0].startTime) - rebuilt[0].travelTimeFromPrev : workStart),
    arriveHomeTime: minutesToTime(currentTime + travelHome),
  };
}
