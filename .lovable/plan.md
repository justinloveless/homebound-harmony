

## Goal
Revamp scheduling to: (1) minimize each day's "away-from-home span" (leave→arrive home), (2) require fitting every needed visit, (3) warn + recommend drops when infeasible, (4) minimize idle gaps between visits.

## Approach: Two-phase optimizer

### Phase 1 — Assign visits to days
For each client, decide which working day(s) get their visits, respecting `visitsNeeded`, `timeWindows`, and the chosen strategy (pack/spread/alternate). Use a constraint-aware greedy: sort clients by (priority, fewest eligible days, longest duration), assign each visit to the day that currently has the most slack and where the client's window exists.

### Phase 2 — Per-day route + timing optimizer
For each day, given its assigned client set, find the visit ordering and start times that minimize the **away-from-home span** = `(travel_home_end − leave_home_start)`. Span = total travel + total visit duration + total idle gaps. Visit durations are fixed, so this reduces to **minimizing travel + idle gaps** simultaneously.

Algorithm per day (small client counts, ~3–10):
- If ≤8 clients: enumerate permutations (8! = 40k, fast). For each permutation:
  - Compute the earliest-finish, latest-start schedule that respects all time windows (forward pass: arrival = max(prev_end + travel, window_start, block-rounded); reject if exceeds window_end / workEnd / break conflicts).
  - Then **right-shift the start of the day**: push the first visit as late as possible without violating any later window. This eliminates morning idle.
  - Score = arriveHome − leaveHome (the span). Track best.
- If >8 clients: use 2-opt local search starting from nearest-neighbor seed, then apply the same right-shift pass.

This directly minimizes the "away time" the user cares about, while idle gaps fall out naturally (any gap inflates the span).

### Phase 3 — Feasibility check & drop recommendations
After Phase 1+2, collect unscheduled visits. If any remain:
- Show a **warning banner** in the Schedule page listing unmet visits.
- Compute drop recommendations: greedily simulate removing one client at a time (lowest priority first, then most constraining = fewest eligible windows, then longest visit) and re-running the scheduler until all remaining clients fit. List the smallest drop set.
- Surface this in the existing "Not Scheduled" card with a new "Recommended to drop" section and a one-click "Exclude these from schedule" action (uses existing `excludedFromSchedule` flag).

## Files to change
- **`src/lib/scheduler.ts`** — rewrite `generateWeekSchedule`. Add helpers:
  - `assignVisitsToDays(...)` — Phase 1
  - `optimizeDay(visitsForDay, ...)` — Phase 2 (permutation/2-opt + right-shift)
  - `recommendDrops(worker, clients, travelTimes, weekStartDate)` — Phase 3
  - Keep existing `recalcDaySchedule` and `tryInsertClient` for manual edits.
- **`src/types/models.ts`** — add to `WeekSchedule`:
  ```ts
  unmetVisits?: Array<{ clientId: string; missing: number }>;
  recommendedDrops?: string[]; // client IDs
  ```
- **`src/pages/Schedule.tsx`** — when `unmetVisits` non-empty, show a destructive alert with the list and a "Drop recommended clients" button that toggles `excludedFromSchedule` and regenerates.

## Behavior preserved
- 15-min block rounding, breaks, `excludedFromSchedule`, alternate-day mirroring (Phase 1 still pre-assigns to primary days; mirror copy stays as-is), Google Maps refinement, manual editing.

## Edge cases
- Client with no time window on any working day → counted as unmet, recommended to drop.
- Worker has zero working days → return empty schedule with all visits unmet.
- Permutation explosion guarded by 8-client threshold per day.

