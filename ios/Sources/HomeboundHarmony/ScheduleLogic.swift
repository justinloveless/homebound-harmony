import Foundation

// Swift port of scheduling logic from scheduler.ts / Schedule.tsx.
// Used by the iOS timeline editor to recalculate visit times after drag-to-reschedule.

// MARK: - Constants

private let BLOCK_SIZE = 15
private let DEFAULT_TRAVEL_MINUTES = 15
private let PERMUTATION_LIMIT = 8

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

// MARK: - Generate week schedule

private struct RouteResult {
    var visits: [ScheduledVisit]
    var leaveHome: Int
    var arriveHome: Int
    var totalTravel: Int
    var span: Int
}

private struct AssignmentResult {
    var perDay: [DayOfWeek: [Client]]
    var unmet: [String: Int]
}

private func visitsNeededForPeriod(visitsPerPeriod: Int, period: SchedulePeriod, weekIndex: Int) -> Int {
    switch period {
    case .week:
        return visitsPerPeriod
    case .twoWeeks:
        return weekIndex % 2 == 0 ? visitsPerPeriod : 0
    case .month:
        return weekIndex % 4 == 0 ? visitsPerPeriod : 0
    }
}

private func visitsNeededThisWeek(client: Client, weekIndex: Int) -> Int {
    visitsNeededForPeriod(
        visitsPerPeriod: client.visitsPerPeriod,
        period: client.period,
        weekIndex: weekIndex
    )
}

private func adjustForBreaks(startMinute: Int, duration: Int, worker: WorkerProfile) -> Int {
    var adjusted = startMinute
    for brk in worker.breaks {
        let breakStart = timeToMinutes(brk.startTime)
        let breakEnd = timeToMinutes(brk.endTime)
        if adjusted < breakEnd && adjusted + duration > breakStart {
            adjusted = breakEnd
        }
    }
    return adjusted
}

private func floorToBlock(_ minutes: Int) -> Int {
    (minutes / BLOCK_SIZE) * BLOCK_SIZE
}

private func buildForwardSchedule(
    order: [Client],
    day: DayOfWeek,
    worker: WorkerProfile,
    travelTimes: TravelTimeMatrix
) -> RouteResult? {
    let workStart = timeToMinutes(worker.workingHours.startTime)
    let workEnd = timeToMinutes(worker.workingHours.endTime)

    var visits: [ScheduledVisit] = []
    var currentTime = workStart
    var currentLocationId = "home"

    for client in order {
        guard let window = getClientWindowForDay(client: client, day: day) else { return nil }
        let windowStart = timeToMinutes(window.startTime)
        let windowEnd = timeToMinutes(window.endTime)
        let travel = getTravelMinutes(from: currentLocationId, to: client.id, matrix: travelTimes)
        var arrival = max(currentTime + travel, windowStart)
        arrival = roundUpToBlock(arrival)
        arrival = adjustForBreaks(startMinute: arrival, duration: client.visitDurationMinutes, worker: worker)

        let end = arrival + client.visitDurationMinutes
        guard end <= windowEnd && end <= workEnd else { return nil }

        visits.append(ScheduledVisit(
            clientId: client.id,
            startTime: minutesToTime(arrival),
            endTime: minutesToTime(end),
            travelTimeFromPrev: travel,
            travelDistanceMiFromPrev: nil,
            manuallyPlaced: nil
        ))

        currentTime = end
        currentLocationId = client.id
    }

    guard let firstVisit = visits.first else {
        return RouteResult(visits: [], leaveHome: workStart, arriveHome: workStart, totalTravel: 0, span: 0)
    }

    let travelHome = getTravelMinutes(from: currentLocationId, to: "home", matrix: travelTimes)
    let totalTravel = visits.reduce(0) { $0 + $1.travelTimeFromPrev } + travelHome
    let leaveHome = timeToMinutes(firstVisit.startTime) - firstVisit.travelTimeFromPrev
    let arriveHome = currentTime + travelHome

    return RouteResult(
        visits: visits,
        leaveHome: leaveHome,
        arriveHome: arriveHome,
        totalTravel: totalTravel,
        span: arriveHome - leaveHome
    )
}

private func rightShiftSchedule(
    order: [Client],
    result: RouteResult,
    day: DayOfWeek,
    worker: WorkerProfile,
    travelTimes: TravelTimeMatrix
) -> RouteResult {
    guard !result.visits.isEmpty else { return result }

    let workEnd = timeToMinutes(worker.workingHours.endTime)
    let count = order.count
    var latestStart = Array(repeating: 0, count: count)

    guard let lastWindow = getClientWindowForDay(client: order[count - 1], day: day) else { return result }
    latestStart[count - 1] = floorToBlock(
        min(timeToMinutes(lastWindow.endTime), workEnd) - order[count - 1].visitDurationMinutes
    )

    if count > 1 {
        for index in stride(from: count - 2, through: 0, by: -1) {
            guard let window = getClientWindowForDay(client: order[index], day: day) else { return result }
            let travel = getTravelMinutes(from: order[index].id, to: order[index + 1].id, matrix: travelTimes)
            let fromNext = latestStart[index + 1] - travel - order[index].visitDurationMinutes
            latestStart[index] = floorToBlock(
                min(timeToMinutes(window.endTime) - order[index].visitDurationMinutes, fromNext)
            )
        }
    }

    var visits: [ScheduledVisit] = []
    var currentTime = 0
    var currentLocationId = "home"

    for (index, client) in order.enumerated() {
        guard let window = getClientWindowForDay(client: client, day: day) else { return result }
        let windowStart = timeToMinutes(window.startTime)
        let windowEnd = timeToMinutes(window.endTime)
        let travel = getTravelMinutes(from: currentLocationId, to: client.id, matrix: travelTimes)

        var arrival: Int
        if index == 0 {
            arrival = latestStart[0]
        } else {
            arrival = max(currentTime + travel, windowStart)
            arrival = roundUpToBlock(arrival)
            arrival = adjustForBreaks(startMinute: arrival, duration: client.visitDurationMinutes, worker: worker)
            guard arrival <= latestStart[index] else { return result }
        }

        arrival = max(arrival, windowStart)
        arrival = roundUpToBlock(arrival)
        arrival = adjustForBreaks(startMinute: arrival, duration: client.visitDurationMinutes, worker: worker)

        let end = arrival + client.visitDurationMinutes
        guard end <= windowEnd && end <= workEnd else { return result }

        visits.append(ScheduledVisit(
            clientId: client.id,
            startTime: minutesToTime(arrival),
            endTime: minutesToTime(end),
            travelTimeFromPrev: travel,
            travelDistanceMiFromPrev: nil,
            manuallyPlaced: nil
        ))

        currentTime = end
        currentLocationId = client.id
    }

    guard let firstVisit = visits.first else { return result }

    let travelHome = getTravelMinutes(from: currentLocationId, to: "home", matrix: travelTimes)
    let totalTravel = visits.reduce(0) { $0 + $1.travelTimeFromPrev } + travelHome
    let leaveHome = timeToMinutes(firstVisit.startTime) - firstVisit.travelTimeFromPrev
    let arriveHome = currentTime + travelHome

    return RouteResult(
        visits: visits,
        leaveHome: leaveHome,
        arriveHome: arriveHome,
        totalTravel: totalTravel,
        span: arriveHome - leaveHome
    )
}

private func permutations<T>(_ values: [T]) -> [[T]] {
    guard values.count > 1 else { return [values] }
    var output: [[T]] = []
    for index in values.indices {
        var rest = values
        let item = rest.remove(at: index)
        for subPermutation in permutations(rest) {
            output.append([item] + subPermutation)
        }
    }
    return output
}

private func nearestNeighborOrder(clients: [Client], travelTimes: TravelTimeMatrix) -> [Client] {
    var remaining = clients
    var order: [Client] = []
    var currentId = "home"

    while !remaining.isEmpty {
        var bestIndex = 0
        var bestTime = Int.max
        for (index, client) in remaining.enumerated() {
            let travel = getTravelMinutes(from: currentId, to: client.id, matrix: travelTimes)
            if travel < bestTime {
                bestTime = travel
                bestIndex = index
            }
        }
        let next = remaining.remove(at: bestIndex)
        order.append(next)
        currentId = next.id
    }

    return order
}

private func twoOptOptimize(
    seed: [Client],
    day: DayOfWeek,
    worker: WorkerProfile,
    travelTimes: TravelTimeMatrix
) -> (order: [Client], result: RouteResult)? {
    var bestOrder = seed
    guard var bestResult = buildForwardSchedule(
        order: bestOrder,
        day: day,
        worker: worker,
        travelTimes: travelTimes
    ) else { return nil }

    var improved = true
    var iterations = 0
    while improved && iterations < 100 {
        improved = false
        iterations += 1

        for i in 0..<(bestOrder.count - 1) {
            for j in (i + 1)..<bestOrder.count {
                var candidate = bestOrder
                candidate.replaceSubrange(i...j, with: candidate[i...j].reversed())
                guard let result = buildForwardSchedule(
                    order: candidate,
                    day: day,
                    worker: worker,
                    travelTimes: travelTimes
                ) else { continue }
                if result.span < bestResult.span {
                    bestOrder = candidate
                    bestResult = result
                    improved = true
                }
            }
        }
    }

    return (bestOrder, bestResult)
}

private func optimizeDay(
    clientsForDay: [Client],
    day: DayOfWeek,
    date: String,
    worker: WorkerProfile,
    travelTimes: TravelTimeMatrix
) -> DaySchedule? {
    guard !clientsForDay.isEmpty else { return nil }

    var bestOrder: [Client]?
    var bestResult: RouteResult?

    if clientsForDay.count <= PERMUTATION_LIMIT {
        for order in permutations(clientsForDay) {
            guard let result = buildForwardSchedule(
                order: order,
                day: day,
                worker: worker,
                travelTimes: travelTimes
            ) else { continue }
            if bestResult == nil || result.span < bestResult!.span {
                bestOrder = order
                bestResult = result
            }
        }
    } else if let optimized = twoOptOptimize(
        seed: nearestNeighborOrder(clients: clientsForDay, travelTimes: travelTimes),
        day: day,
        worker: worker,
        travelTimes: travelTimes
    ) {
        bestOrder = optimized.order
        bestResult = optimized.result
    }

    guard let bestOrder, let bestResult else { return nil }
    let shifted = rightShiftSchedule(
        order: bestOrder,
        result: bestResult,
        day: day,
        worker: worker,
        travelTimes: travelTimes
    )

    return DaySchedule(
        day: day,
        date: date,
        visits: shifted.visits,
        totalTravelMinutes: shifted.totalTravel,
        leaveHomeTime: minutesToTime(shifted.leaveHome),
        arriveHomeTime: minutesToTime(shifted.arriveHome)
    )
}

private func priorityRank(_ priority: Priority) -> Int {
    switch priority {
    case .high: return 0
    case .medium: return 1
    case .low: return 2
    }
}

private func assignVisitsToDays(
    clients: [Client],
    schedulingDays: [DayOfWeek],
    visitsNeeded: [String: Int],
    worker: WorkerProfile,
    travelTimes: TravelTimeMatrix
) -> AssignmentResult {
    struct Item {
        var client: Client
        var eligibleDays: [DayOfWeek]
        var needed: Int
    }

    let items = clients
        .map { client in
            Item(
                client: client,
                eligibleDays: schedulingDays.filter { getClientWindowForDay(client: client, day: $0) != nil },
                needed: visitsNeeded[client.id] ?? 0
            )
        }
        .filter { $0.needed > 0 }
        .sorted { lhs, rhs in
            let priorityDelta = priorityRank(lhs.client.priority) - priorityRank(rhs.client.priority)
            if priorityDelta != 0 { return priorityDelta < 0 }
            if lhs.eligibleDays.count != rhs.eligibleDays.count {
                return lhs.eligibleDays.count < rhs.eligibleDays.count
            }
            return lhs.client.visitDurationMinutes > rhs.client.visitDurationMinutes
        }

    var perDay = Dictionary(uniqueKeysWithValues: schedulingDays.map { ($0, [Client]()) })
    var unmet: [String: Int] = [:]

    for item in items {
        var placed = 0
        var usedDays = Set<DayOfWeek>()

        for _ in 0..<item.needed {
            let candidates = item.eligibleDays
                .filter { !usedDays.contains($0) }
                .map { (day: $0, load: perDay[$0, default: []].count) }
                .sorted { lhs, rhs in lhs.load < rhs.load }

            var assignedThisVisit = false
            for candidate in candidates {
                let trial = perDay[candidate.day, default: []] + [item.client]
                if optimizeDay(
                    clientsForDay: trial,
                    day: candidate.day,
                    date: "0000-00-00",
                    worker: worker,
                    travelTimes: travelTimes
                ) != nil {
                    perDay[candidate.day] = trial
                    usedDays.insert(candidate.day)
                    placed += 1
                    assignedThisVisit = true
                    break
                }
            }

            if !assignedThisVisit { break }
        }

        if placed < item.needed {
            unmet[item.client.id] = item.needed - placed
        }
    }

    return AssignmentResult(perDay: perDay, unmet: unmet)
}

private func recommendDrops(
    worker: WorkerProfile,
    clients: [Client],
    travelTimes: TravelTimeMatrix,
    schedulingDays: [DayOfWeek],
    visitsNeeded: [String: Int],
    unmet: [String: Int]
) -> [String] {
    guard !unmet.isEmpty else { return [] }

    var drops: [String] = []
    var activeClients = clients
    var currentUnmet = unmet
    var safety = 0

    while !currentUnmet.isEmpty && safety < clients.count {
        safety += 1
        let candidates = currentUnmet.keys.compactMap { id in
            activeClients.first { $0.id == id }
        }

        guard let dropCandidate = candidates.sorted(by: { lhs, rhs in
            let priorityDelta = priorityRank(rhs.priority) - priorityRank(lhs.priority)
            if priorityDelta != 0 { return priorityDelta < 0 }

            let lhsWindows = lhs.timeWindows.filter { schedulingDays.contains($0.day) }.count
            let rhsWindows = rhs.timeWindows.filter { schedulingDays.contains($0.day) }.count
            if lhsWindows != rhsWindows { return lhsWindows < rhsWindows }

            return lhs.visitDurationMinutes > rhs.visitDurationMinutes
        }).first else { break }

        drops.append(dropCandidate.id)
        activeClients.removeAll { $0.id == dropCandidate.id }

        var adjustedNeeded = visitsNeeded
        adjustedNeeded.removeValue(forKey: dropCandidate.id)
        currentUnmet = assignVisitsToDays(
            clients: activeClients,
            schedulingDays: schedulingDays,
            visitsNeeded: adjustedNeeded,
            worker: worker,
            travelTimes: travelTimes
        ).unmet
    }

    return drops
}

private func isoDateInWeek(weekStartDate: String, day: DayOfWeek) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")

    guard let startDate = formatter.date(from: weekStartDate),
          let dayIndex = DayOfWeek.allCases.firstIndex(of: day) else {
        return weekStartDate
    }

    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let date = calendar.date(byAdding: .day, value: dayIndex, to: startDate) ?? startDate
    return formatter.string(from: date)
}

func currentMondayISODate(now: Date = Date()) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    calendar.firstWeekday = 2

    let components = calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: now)
    let monday = calendar.date(from: components) ?? now

    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    return formatter.string(from: monday)
}

func generateWeekSchedule(
    worker: WorkerProfile,
    allClients: [Client],
    travelTimes: TravelTimeMatrix,
    weekStartDate: String,
    weekIndex: Int = 0
) -> WeekSchedule {
    let clients = allClients.filter { !$0.isExcluded }
    let workingDays = DayOfWeek.allCases.filter { !worker.daysOff.contains($0) }
    let strategy = worker.schedulingStrategy
    let halfSize = Int(ceil(Double(workingDays.count) / 2.0))
    let primaryDays = strategy == .alternate ? Array(workingDays.prefix(halfSize)) : workingDays

    var mirrorPairs: [(source: DayOfWeek, target: DayOfWeek)] = []
    if strategy == .alternate {
        for index in 0..<halfSize where index + halfSize < workingDays.count {
            mirrorPairs.append((workingDays[index], workingDays[index + halfSize]))
        }
    }

    var originalNeeded: [String: Int] = [:]
    var visitsNeeded: [String: Int] = [:]
    for client in clients {
        let needed = visitsNeededThisWeek(client: client, weekIndex: weekIndex)
        originalNeeded[client.id] = needed
        visitsNeeded[client.id] = strategy == .alternate ? Int(ceil(Double(needed) / 2.0)) : needed
    }

    let schedulingDays = strategy == .alternate ? primaryDays : workingDays
    if schedulingDays.isEmpty {
        let unmetVisits = clients
            .filter { (originalNeeded[$0.id] ?? 0) > 0 }
            .map { UnmetVisit(clientId: $0.id, missing: originalNeeded[$0.id] ?? 0) }

        return WeekSchedule(
            weekStartDate: weekStartDate,
            days: [],
            totalTravelMinutes: 0,
            totalTimeAwayMinutes: 0,
            clientGroups: nil,
            unmetVisits: unmetVisits.isEmpty ? nil : unmetVisits,
            recommendedDrops: unmetVisits.map(\.clientId)
        )
    }

    let assignment = assignVisitsToDays(
        clients: clients,
        schedulingDays: schedulingDays,
        visitsNeeded: visitsNeeded,
        worker: worker,
        travelTimes: travelTimes
    )
    var unmet = assignment.unmet

    var days: [DaySchedule] = []
    for day in schedulingDays {
        let clientsForDay = assignment.perDay[day] ?? []
        guard !clientsForDay.isEmpty else { continue }
        let date = isoDateInWeek(weekStartDate: weekStartDate, day: day)
        if let optimized = optimizeDay(
            clientsForDay: clientsForDay,
            day: day,
            date: date,
            worker: worker,
            travelTimes: travelTimes
        ) {
            days.append(optimized)
        }
    }

    if strategy == .alternate && !mirrorPairs.isEmpty {
        var totalScheduled: [String: Int] = [:]
        for day in days {
            for visit in day.visits {
                totalScheduled[visit.clientId, default: 0] += 1
            }
        }

        for pair in mirrorPairs {
            guard let sourceDay = days.first(where: { $0.day == pair.source }) else { continue }
            var mirroredVisits: [ScheduledVisit] = []

            for visit in sourceDay.visits {
                let need = originalNeeded[visit.clientId] ?? 0
                let have = totalScheduled[visit.clientId] ?? 0
                guard have < need else { continue }
                mirroredVisits.append(visit)
                totalScheduled[visit.clientId] = have + 1
            }

            guard let firstVisit = mirroredVisits.first, let lastVisit = mirroredVisits.last else { continue }

            let travelHome = getTravelMinutes(from: lastVisit.clientId, to: "home", matrix: travelTimes)
            let totalTravel = mirroredVisits.reduce(0) { $0 + $1.travelTimeFromPrev } + travelHome
            let leaveHomeTime = minutesToTime(timeToMinutes(firstVisit.startTime) - firstVisit.travelTimeFromPrev)
            let arriveHomeTime = minutesToTime(timeToMinutes(lastVisit.endTime) + travelHome)

            days.append(DaySchedule(
                day: pair.target,
                date: isoDateInWeek(weekStartDate: weekStartDate, day: pair.target),
                visits: mirroredVisits,
                totalTravelMinutes: totalTravel,
                leaveHomeTime: leaveHomeTime,
                arriveHomeTime: arriveHomeTime
            ))
        }

        var finalUnmet: [String: Int] = [:]
        for client in clients {
            let need = originalNeeded[client.id] ?? 0
            let have = totalScheduled[client.id] ?? 0
            if have < need {
                finalUnmet[client.id] = need - have
            }
        }
        unmet = finalUnmet
    }

    days.sort {
        DayOfWeek.allCases.firstIndex(of: $0.day)! < DayOfWeek.allCases.firstIndex(of: $1.day)!
    }

    let totalTravel = days.reduce(0) { $0 + $1.totalTravelMinutes }
    let totalAway = days.reduce(0) { total, day in
        total + max(0, timeToMinutes(day.arriveHomeTime) - timeToMinutes(day.leaveHomeTime))
    }

    var clientGroups: [String: String]?
    if strategy == .alternate {
        let primarySet = Set(primaryDays)
        let mirrorSet = Set(mirrorPairs.map(\.target))
        var groups: [String: String] = [:]

        for client in clients {
            let onPrimary = days.contains { day in
                primarySet.contains(day.day) && day.visits.contains { $0.clientId == client.id }
            }
            let onMirror = days.contains { day in
                mirrorSet.contains(day.day) && day.visits.contains { $0.clientId == client.id }
            }

            if onPrimary && onMirror {
                groups[client.id] = "A+B"
            } else if onPrimary {
                groups[client.id] = "A"
            } else if onMirror {
                groups[client.id] = "B"
            }
        }

        clientGroups = groups
    }

    let unmetVisits = unmet.map { UnmetVisit(clientId: $0.key, missing: $0.value) }
    let drops = unmetVisits.isEmpty ? nil : recommendDrops(
        worker: worker,
        clients: clients,
        travelTimes: travelTimes,
        schedulingDays: schedulingDays,
        visitsNeeded: visitsNeeded,
        unmet: unmet
    )

    return WeekSchedule(
        weekStartDate: weekStartDate,
        days: days,
        totalTravelMinutes: totalTravel,
        totalTimeAwayMinutes: totalAway,
        clientGroups: clientGroups,
        unmetVisits: unmetVisits.isEmpty ? nil : unmetVisits,
        recommendedDrops: drops
    )
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

/// Copy one day's visits into another day and recalculate route timing for the target day.
func copyDaySchedule(
    from sourceDay: DaySchedule,
    to targetDay: DaySchedule,
    worker: WorkerProfile,
    clients: [Client],
    travelTimes: TravelTimeMatrix
) -> DaySchedule? {
    guard !sourceDay.visits.isEmpty else { return nil }

    let copiedVisits = sourceDay.visits.map { visit in
        ScheduledVisit(
            clientId: visit.clientId,
            startTime: visit.startTime,
            endTime: visit.endTime,
            travelTimeFromPrev: visit.travelTimeFromPrev,
            travelDistanceMiFromPrev: visit.travelDistanceMiFromPrev,
            manuallyPlaced: visit.manuallyPlaced
        )
    }

    return recalcDaySchedule(
        visits: copiedVisits,
        day: targetDay,
        worker: worker,
        clients: clients,
        travelTimes: travelTimes,
        preserveManualTimes: true
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
