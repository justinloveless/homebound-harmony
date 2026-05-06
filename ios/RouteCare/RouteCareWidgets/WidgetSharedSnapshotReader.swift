import Foundation

private enum WidgetSharedKeys {
    static let appGroupID = "group.com.lovelesslabs.RouteCare"
    static let workspaceSnapshot = "widgetWorkspaceSnapshot.v1"
    static let runtimeState = "visitRuntimeState.v1"
}

/// Matches the app’s `VisitRuntimeSnapshot` / `VisitRuntimeState` JSON in the shared app group.
private struct SharedRuntimeStateFile: Codable {
    var states: [SharedRuntimeVisitRow]
}

private struct SharedRuntimeVisitRow: Codable {
    var visitKey: String
    var dayDate: String
    var visitIndex: Int
    var clientId: String
    var checkedInAt: Date
    var verifiedArrival: Bool
    var completedAt: Date?
}

struct WidgetClientSnapshot: Codable {
    var id: String
    var name: String
    var address: String
    var visitDurationMinutes: Int?
}

struct WidgetVisitRuntimeStateSnapshot: Codable {
    var dayDate: String
    var visitIndex: Int
    var completedAt: Date?
}

struct WidgetVisitSnapshot: Codable, Identifiable {
    var id: String { "\(dayDate)#\(visitIndex)" }
    var dayDate: String
    var visitIndex: Int
    var clientId: String
    var startTime: String
    var endTime: String
}

struct WidgetWorkspaceSnapshot: Codable {
    var clients: [WidgetClientSnapshot]
    var todaysVisits: [WidgetVisitSnapshot]
    var runtimeStates: [WidgetVisitRuntimeStateSnapshot]
    var refreshedAt: Date
}

enum WidgetSharedSnapshotReader {
    static func load() -> WidgetWorkspaceSnapshot? {
        let defaults = UserDefaults(suiteName: WidgetSharedKeys.appGroupID) ?? .standard
        guard let data = defaults.data(forKey: WidgetSharedKeys.workspaceSnapshot) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return try? dec.decode(WidgetWorkspaceSnapshot.self, from: data)
    }

    static func appGroupDefaults() -> UserDefaults {
        UserDefaults(suiteName: WidgetSharedKeys.appGroupID) ?? .standard
    }
}

/// First visit in schedule order that still needs action (not fully completed). Skips completed visits even if still inside their scheduled window.
enum WidgetCheckInVisitResolver {
    /// Merges `widgetWorkspaceSnapshot.v1` runtime rows with `visitRuntimeState.v1` (canonical; wins on conflicts).
    static func mergedRuntimeStates(snapshot: WidgetWorkspaceSnapshot, defaults: UserDefaults) -> [WidgetVisitRuntimeStateSnapshot] {
        var map: [String: WidgetVisitRuntimeStateSnapshot] = [:]
        for s in snapshot.runtimeStates {
            map[runtimeKey(dayDate: s.dayDate, visitIndex: s.visitIndex)] = s
        }
        if let fromFile = loadRuntimeStatesFromSharedStore(defaults: defaults) {
            for s in fromFile {
                map[runtimeKey(dayDate: s.dayDate, visitIndex: s.visitIndex)] = s
            }
        }
        return Array(map.values)
    }

    static func firstIncompleteVisit(in snapshot: WidgetWorkspaceSnapshot, defaults: UserDefaults) -> WidgetVisitSnapshot? {
        let states = mergedRuntimeStates(snapshot: snapshot, defaults: defaults)
        return snapshot.todaysVisits.first { !isFullyCompleted($0, runtimeStates: states) }
    }

    static func isFullyCompleted(_ visit: WidgetVisitSnapshot, runtimeStates: [WidgetVisitRuntimeStateSnapshot]) -> Bool {
        runtimeStates.contains {
            $0.dayDate == visit.dayDate && $0.visitIndex == visit.visitIndex && $0.completedAt != nil
        }
    }

    static func hasOpenCheckIn(_ visit: WidgetVisitSnapshot, runtimeStates: [WidgetVisitRuntimeStateSnapshot]) -> Bool {
        runtimeStates.contains {
            $0.dayDate == visit.dayDate && $0.visitIndex == visit.visitIndex && $0.completedAt == nil
        }
    }

    private static func runtimeKey(dayDate: String, visitIndex: Int) -> String {
        "\(dayDate)#\(visitIndex)"
    }

    private static func loadRuntimeStatesFromSharedStore(defaults: UserDefaults) -> [WidgetVisitRuntimeStateSnapshot]? {
        guard let data = defaults.data(forKey: WidgetSharedKeys.runtimeState) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        guard let file = try? dec.decode(SharedRuntimeStateFile.self, from: data) else { return nil }
        return file.states.map {
            WidgetVisitRuntimeStateSnapshot(dayDate: $0.dayDate, visitIndex: $0.visitIndex, completedAt: $0.completedAt)
        }
    }
}
