import Foundation

struct VisitCheckInResult {
    let dayDate: String
    let visitIndex: Int
    let state: VisitRuntimeState
    let verification: ArrivalVerificationResult
}

enum VisitCheckInError: LocalizedError {
    case outsideRadius(distanceMeters: Double)

    var errorDescription: String? {
        switch self {
        case .outsideRadius(let distanceMeters):
            return "You appear to be \(Int(distanceMeters))m away from the client."
        }
    }
}

@MainActor
final class VisitCheckInEngine {
    private let store: VisitRuntimeStore
    private let verifier = ArrivalVerificationService()

    init(store: VisitRuntimeStore) {
        self.store = store
    }

    func checkInCurrentOrNext(
        day: DaySchedule,
        clients: [Client],
        now: Date = Date(),
        bypassLocationCheck: Bool = false,
        allowOutsideRadius: Bool = false
    ) async throws -> VisitCheckInResult? {
        guard let idx = resolveCurrentOrNextVisitIndex(day: day, now: now),
              idx < day.visits.count else { return nil }

        let visit = day.visits[idx]
        guard let client = clients.first(where: { $0.id == visit.clientId }) else { return nil }
        let existing = store.state(for: day.date, visitIndex: idx)
        if let existing, !existing.isCompleted {
            return VisitCheckInResult(dayDate: day.date, visitIndex: idx, state: existing, verification: .verified)
        }

        let verification: ArrivalVerificationResult
        if bypassLocationCheck {
            verification = .unavailable
        } else {
            verification = await verifier.verifyArrival(client: client)
        }

        if case .outsideRadius(let distance) = verification, !allowOutsideRadius {
            throw VisitCheckInError.outsideRadius(distanceMeters: distance)
        }

        let verified = {
            if case .verified = verification { return true }
            return false
        }()

        let state = VisitRuntimeState(
            visitKey: VisitKey.make(dayDate: day.date, visitIndex: idx),
            dayDate: day.date,
            visitIndex: idx,
            clientId: client.id,
            checkedInAt: now,
            verifiedArrival: verified,
            completedAt: nil
        )
        store.upsert(state)
        return VisitCheckInResult(dayDate: day.date, visitIndex: idx, state: state, verification: verification)
    }

    func checkInVisit(
        at visitIndex: Int,
        day: DaySchedule,
        clients: [Client],
        now: Date = Date(),
        bypassLocationCheck: Bool = false,
        allowOutsideRadius: Bool = false
    ) async throws -> VisitCheckInResult? {
        guard visitIndex >= 0, visitIndex < day.visits.count else { return nil }

        let visit = day.visits[visitIndex]
        guard let client = clients.first(where: { $0.id == visit.clientId }) else { return nil }
        let existing = store.state(for: day.date, visitIndex: visitIndex)
        if let existing, !existing.isCompleted {
            return VisitCheckInResult(dayDate: day.date, visitIndex: visitIndex, state: existing, verification: .verified)
        }

        let verification: ArrivalVerificationResult
        if bypassLocationCheck {
            verification = .unavailable
        } else {
            verification = await verifier.verifyArrival(client: client)
        }

        if case .outsideRadius(let distance) = verification, !allowOutsideRadius {
            throw VisitCheckInError.outsideRadius(distanceMeters: distance)
        }

        let verified = {
            if case .verified = verification { return true }
            return false
        }()

        let state = VisitRuntimeState(
            visitKey: VisitKey.make(dayDate: day.date, visitIndex: visitIndex),
            dayDate: day.date,
            visitIndex: visitIndex,
            clientId: client.id,
            checkedInAt: now,
            verifiedArrival: verified,
            completedAt: nil
        )
        store.upsert(state)
        return VisitCheckInResult(dayDate: day.date, visitIndex: visitIndex, state: state, verification: verification)
    }

    func markVisitCompleted(dayDate: String, visitIndex: Int) {
        store.markCompleted(dayDate: dayDate, visitIndex: visitIndex)
    }

    func state(for dayDate: String, visitIndex: Int) -> VisitRuntimeState? {
        store.state(for: dayDate, visitIndex: visitIndex)
    }

    func resolveCurrentOrNextVisitIndex(day: DaySchedule, now: Date = Date()) -> Int? {
        for (idx, visit) in day.visits.enumerated() {
            guard let start = visit.startTime.asTimeOn(isoDate: day.date),
                  let end = visit.endTime.asTimeOn(isoDate: day.date) else { continue }
            if now >= start && now <= end {
                return idx
            }
        }
        for (idx, visit) in day.visits.enumerated() {
            guard let start = visit.startTime.asTimeOn(isoDate: day.date) else { continue }
            if start >= now { return idx }
        }
        return nil
    }

    func nextUnstartedVisit(day: DaySchedule) -> (index: Int, visit: ScheduledVisit)? {
        for (idx, visit) in day.visits.enumerated() {
            if state(for: day.date, visitIndex: idx) == nil {
                return (idx, visit)
            }
        }
        return nil
    }

    /// First visit in order that is not fully completed (no runtime row, checked-in, or completed). Used for widget-style flow.
    func firstIncompleteVisitIndex(day: DaySchedule) -> Int? {
        for idx in day.visits.indices {
            if let s = state(for: day.date, visitIndex: idx) {
                if !s.isCompleted { return idx }
            } else {
                return idx
            }
        }
        return nil
    }
}
