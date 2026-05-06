import Foundation

@MainActor
final class VisitRuntimeStore {
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults? = UserDefaults(suiteName: SharedAppGroup.id)) {
        self.defaults = defaults ?? .standard
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
    }

    func allStates() -> [VisitRuntimeState] {
        guard let data = defaults.data(forKey: SharedStoreKeys.runtimeState),
              let snapshot = try? decoder.decode(VisitRuntimeSnapshot.self, from: data) else {
            return []
        }
        return snapshot.states
    }

    func state(for dayDate: String, visitIndex: Int) -> VisitRuntimeState? {
        let key = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)
        return allStates().first { $0.visitKey == key }
    }

    func upsert(_ state: VisitRuntimeState) {
        var states = allStates().filter { $0.visitKey != state.visitKey }
        states.append(state)
        save(states: states)
    }

    func markCompleted(dayDate: String, visitIndex: Int, at date: Date = Date()) {
        guard var current = state(for: dayDate, visitIndex: visitIndex) else { return }
        current.completedAt = date
        upsert(current)
    }

    func remove(dayDate: String, visitIndex: Int) {
        let key = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)
        let remaining = allStates().filter { $0.visitKey != key }
        save(states: remaining)
    }

    func prune(forSchedule schedule: WeekSchedule?) {
        guard let schedule else {
            save(states: [])
            return
        }
        let validKeys = Set(schedule.days.flatMap { day in
            day.visits.indices.map { VisitKey.make(dayDate: day.date, visitIndex: $0) }
        })
        let pruned = allStates().filter { validKeys.contains($0.visitKey) }
        save(states: pruned)
    }

    func clear() {
        defaults.removeObject(forKey: SharedStoreKeys.runtimeState)
    }

    private func save(states: [VisitRuntimeState]) {
        let snapshot = VisitRuntimeSnapshot(states: states.sorted { $0.checkedInAt < $1.checkedInAt })
        guard let data = try? encoder.encode(snapshot) else { return }
        defaults.set(data, forKey: SharedStoreKeys.runtimeState)
    }
}
