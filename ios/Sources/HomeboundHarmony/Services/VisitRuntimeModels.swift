import Foundation

public enum SharedAppGroup {
    public static let id = "group.com.lovelesslabs.RouteCare"
}

public struct VisitRuntimeState: Codable, Equatable {
    public var visitKey: String
    public var dayDate: String
    public var visitIndex: Int
    public var clientId: String
    public var checkedInAt: Date
    public var verifiedArrival: Bool
    public var completedAt: Date?

    public var isCompleted: Bool { completedAt != nil }
}

struct VisitRuntimeSnapshot: Codable {
    var states: [VisitRuntimeState]
}

enum VisitKey {
    static func make(dayDate: String, visitIndex: Int) -> String {
        "\(dayDate)#\(visitIndex)"
    }
}

public struct WidgetWorkspaceSnapshot: Codable {
    public struct WidgetVisit: Codable, Identifiable {
        public var id: String { VisitKey.make(dayDate: dayDate, visitIndex: visitIndex) }
        public var dayDate: String
        public var visitIndex: Int
        public var clientId: String
        public var startTime: String
        public var endTime: String
    }

    public struct WidgetClient: Codable {
        public var id: String
        public var name: String
        public var address: String
        public var visitDurationMinutes: Int
    }

    public var clients: [WidgetClient]
    public var todaysVisits: [WidgetVisit]
    public var runtimeStates: [VisitRuntimeState]
    public var refreshedAt: Date
}

public enum SharedStoreKeys {
    public static let runtimeState = "visitRuntimeState.v1"
    public static let workspaceSnapshot = "widgetWorkspaceSnapshot.v1"
}
