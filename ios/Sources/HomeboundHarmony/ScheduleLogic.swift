import Foundation

// Swift port of scheduling logic from scheduler.ts / Schedule.tsx.
// Used by the iOS timeline editor to recalculate visit times after drag-to-reschedule.

// MARK: - Constants

private let BLOCK_SIZE = 15
private let DEFAULT_TRAVEL_MINUTES = 15

// MARK: - Time utilities

/// Parse "HH:MM" into minutes from midnight.
func timeToMinutes(_ time: String) -> Int {
    let parts = time.split(separator: ":").compactMap { Int($0) }
    guard parts.count == 2 else { return 0 }
    return parts[0] * 60 + parts[1]
}

/// Convert minutes from midnight to "HH:MM".
func minutesToTime(_ minutes: Int) -> String {
    let clamped = max(0, min(23 * 60 + 59, minutes))
    return String(format: "%02d:%02d", clamped / 60, clamped % 60)
}

/// Round UP to the next 15-minute block (matches TypeScript's roundUpToBlock).
func roundUpToBlock(_ minutes: Int) -> Int {
    return ((minutes + BLOCK_SIZE - 1) / BLOCK_SIZE) * BLOCK_SIZE
}

/// Round to the NEAREST 15-minute block (used for drag snapping).
func roundToNearestBlock(_ minutes: Int) -> Int {
    return (Int((Double(minutes) / Double(BLOCK_SIZE)).rounded())) * BLOCK_SIZE
}

/// Lookup travel time between two location IDs (client IDs or "home").
func getTravelMinutes(from fromId: String, to toId: String, matrix: TravelTimeMatrix) -> Int {
    let key = travelKey(fromId, toId)
    if let t = matrix[key] { return Int(t) }
    return DEFAULT_TRAVEL_MINUTES
}

func getClientWindowForDay(client: Client, day: DayOfWeek) -> TimeWindow? {
    client.timeWindows.first { $0.day == day }
}

// MARK: - Recalculate day schedule

/// Port of recalcDaySchedule from scheduler.ts.
/// Recalculates arrival times and travel times for an ordered visit list.
/// When preserveManualTimes is true, visits with manuallyPlaced=true keep their exact start times.
func recalcDaySchedule(
    visits: [ScheduledVisit],
    day: DaySchedule,
    worker: WorkerProfile,
    clients: [Client],
    travelTimes: TravelTimeMatrix,
    preserveManualTimes: Bool = true
) -> DaySchedule? {
    guard !visits.isEmpty else { return nil }

    let clientMap = Dictionary(uniqueKeysWithValues: clients.map { ($0.id, $0) })
    let workStart = timeToMinutes(worker.workingHours.startTime)

    var rebuilt: [ScheduledVisit] = []
    var currentTime = workStart
    var currentLocId = "home"

    for v in visits {
        guard let client = clientMap[v.clientId] else { continue }

        let window = getClientWindowForDay(client: client, day: day.day)
        let windowStart = window.map { timeToMinutes($0.startTime) } ?? workStart

        let travel = getTravelMinutes(from: currentLocId, to: client.id, matrix: travelTimes)
        let earliest = max(currentTime + travel, windowStart)

        let manualStart = v.startTime != "00:00" ? timeToMinutes(v.startTime) : 0

        var arrival: Int
        if preserveManualTimes && v.manuallyPlaced == true && manualStart > 0 {
            // Manually placed: keep exact time
            arrival = manualStart
        } else if preserveManualTimes && manualStart > 0 && manualStart >= earliest {
            // Non-manual but already fits: keep it
            arrival = manualStart
        } else {
            arrival = manualStart > earliest ? manualStart : earliest
        }
        arrival = roundUpToBlock(arrival)

        // Skip over worker breaks
        for brk in worker.breaks {
            let bs = timeToMinutes(brk.startTime)
            let be = timeToMinutes(brk.endTime)
            if arrival < be && arrival + client.visitDurationMinutes > bs {
                arrival = roundUpToBlock(be)
            }
        }

        rebuilt.append(ScheduledVisit(
            clientId: client.id,
            startTime: minutesToTime(arrival),
            endTime: minutesToTime(arrival + client.visitDurationMinutes),
            travelTimeFromPrev: travel,
            travelDistanceMiFromPrev: v.travelDistanceMiFromPrev,
            manuallyPlaced: v.manuallyPlaced
        ))

        currentTime = arrival + client.visitDurationMinutes
        currentLocId = client.id
    }

    guard !rebuilt.isEmpty else { return nil }

    let travelHome = getTravelMinutes(from: currentLocId, to: "home", matrix: travelTimes)
    let totalTravel = rebuilt.reduce(0) { $0 + $1.travelTimeFromPrev } + travelHome
    let leaveMinute = timeToMinutes(rebuilt[0].startTime) - rebuilt[0].travelTimeFromPrev

    return DaySchedule(
        day: day.day,
        date: day.date,
        visits: rebuilt,
        totalTravelMinutes: totalTravel,
        leaveHomeTime: minutesToTime(max(0, leaveMinute)),
        arriveHomeTime: minutesToTime(currentTime + travelHome)
    )
}

// MARK: - Resolve conflicts

struct ConflictResult {
    var resolvedVisits: [ScheduledVisit]
    var removedClientIds: [String]
}

/// Port of resolveConflicts from Schedule.tsx.
/// Places the dropped visit and bumps conflicting visits to fit around it.
/// Manually-placed visits are immovable anchors.
func resolveConflicts(
    droppedVisit: ScheduledVisit,
    existingVisits: [ScheduledVisit],
    dayOfWeek: DayOfWeek,
    worker: WorkerProfile,
    clients: [Client],
    travelTimes: TravelTimeMatrix
) -> ConflictResult {
    let whEnd = timeToMinutes(worker.workingHours.endTime)
    let dropStart = timeToMinutes(droppedVisit.startTime)
    let dropEnd = timeToMinutes(droppedVisit.endTime)

    let clientMap = Dictionary(uniqueKeysWithValues: clients.map { ($0.id, $0) })

    let manualVisits = existingVisits.filter { $0.manuallyPlaced == true }
    let movable = existingVisits.filter { $0.manuallyPlaced != true }

    let before = movable
        .filter { timeToMinutes($0.endTime) <= dropStart }
        .sorted { timeToMinutes($0.startTime) < timeToMinutes($1.startTime) }
    let after = movable
        .filter { timeToMinutes($0.startTime) >= dropEnd }
        .sorted { timeToMinutes($0.startTime) < timeToMinutes($1.startTime) }
    let overlapping = movable
        .filter { v in
            let vs = timeToMinutes(v.startTime); let ve = timeToMinutes(v.endTime)
            return vs < dropEnd && ve > dropStart
        }
        .sorted { timeToMinutes($0.startTime) < timeToMinutes($1.startTime) }

    var resolved: [ScheduledVisit] = before + manualVisits + [droppedVisit]
    var removed: [String] = []
    var currentEnd = dropEnd

    func getPrevClientId(endMinute: Int) -> String {
        var prevId = "home"
        var closestEnd = -1
        for r in resolved {
            let rEnd = timeToMinutes(r.endTime)
            if rEnd <= endMinute && rEnd > closestEnd {
                closestEnd = rEnd
                prevId = r.clientId
            }
        }
        return prevId
    }

    func tryPlace(_ v: ScheduledVisit, afterMinute: Int) {
        guard let client = clientMap[v.clientId] else { removed.append(v.clientId); return }
        guard let tw = getClientWindowForDay(client: client, day: dayOfWeek) else {
            removed.append(v.clientId); return
        }

        let twEnd = timeToMinutes(tw.endTime)
        let prevId = getPrevClientId(endMinute: afterMinute)
        let travel = getTravelMinutes(from: prevId, to: client.id, matrix: travelTimes)

        var newStart = max(afterMinute + travel, timeToMinutes(tw.startTime))
        newStart = roundUpToBlock(newStart)

        for brk in worker.breaks {
            let bs = timeToMinutes(brk.startTime)
            let be = timeToMinutes(brk.endTime)
            if newStart < be && newStart + client.visitDurationMinutes > bs {
                newStart = roundUpToBlock(be)
            }
        }

        let newEnd = newStart + client.visitDurationMinutes
        guard newEnd <= twEnd && newEnd <= whEnd else {
            removed.append(v.clientId); return
        }

        resolved.append(ScheduledVisit(
            clientId: v.clientId,
            startTime: minutesToTime(newStart),
            endTime: minutesToTime(newEnd),
            travelTimeFromPrev: travel,
            travelDistanceMiFromPrev: nil,
            manuallyPlaced: nil
        ))
        currentEnd = newEnd
    }

    for v in overlapping { tryPlace(v, afterMinute: currentEnd) }

    for v in after {
        let vStart = timeToMinutes(v.startTime)
        let vEnd = timeToMinutes(v.endTime)
        if vStart >= currentEnd {
            resolved.append(v)
            currentEnd = vEnd
        } else {
            tryPlace(v, afterMinute: currentEnd)
        }
    }

    resolved.sort { timeToMinutes($0.startTime) < timeToMinutes($1.startTime) }
    return ConflictResult(resolvedVisits: resolved, removedClientIds: removed)
}
