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
    /// Visit-scoped notes from replayed `visit_note_added` events (not client profile notes).
    public var visitNote: String?

    public var isCompleted: Bool { completedAt != nil }

    enum CodingKeys: String, CodingKey {
        case visitKey, dayDate, visitIndex, clientId, checkedInAt, verifiedArrival, completedAt, visitNote
    }

    public init(
        visitKey: String,
        dayDate: String,
        visitIndex: Int,
        clientId: String,
        checkedInAt: Date,
        verifiedArrival: Bool,
        completedAt: Date?,
        visitNote: String? = nil
    ) {
        self.visitKey = visitKey
        self.dayDate = dayDate
        self.visitIndex = visitIndex
        self.clientId = clientId
        self.checkedInAt = checkedInAt
        self.verifiedArrival = verifiedArrival
        self.completedAt = completedAt
        self.visitNote = visitNote
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        visitKey = try c.decode(String.self, forKey: .visitKey)
        dayDate = try c.decode(String.self, forKey: .dayDate)
        visitIndex = try c.decode(Int.self, forKey: .visitIndex)
        clientId = try c.decode(String.self, forKey: .clientId)
        checkedInAt = try c.decode(Date.self, forKey: .checkedInAt)
        verifiedArrival = try c.decode(Bool.self, forKey: .verifiedArrival)
        completedAt = try c.decodeIfPresent(Date.self, forKey: .completedAt)
        visitNote = try c.decodeIfPresent(String.self, forKey: .visitNote)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(visitKey, forKey: .visitKey)
        try c.encode(dayDate, forKey: .dayDate)
        try c.encode(visitIndex, forKey: .visitIndex)
        try c.encode(clientId, forKey: .clientId)
        try c.encode(checkedInAt, forKey: .checkedInAt)
        try c.encode(verifiedArrival, forKey: .verifiedArrival)
        try c.encodeIfPresent(completedAt, forKey: .completedAt)
        try c.encodeIfPresent(visitNote, forKey: .visitNote)
    }
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
