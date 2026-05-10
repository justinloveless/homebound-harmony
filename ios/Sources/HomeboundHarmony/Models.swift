// Data models mirroring the TypeScript types in src/types/models.ts.
// Must be kept in sync with the web app's JSON format — the workspace blob
// is produced by the web app and decoded here.

import Foundation

// MARK: - Primitive types

typealias TravelTimeMatrix = [String: Double]
typealias TravelTimeErrors = [String: String]

enum DayOfWeek: String, Codable, CaseIterable, Identifiable {
    case monday, tuesday, wednesday, thursday, friday, saturday, sunday
    var id: String { rawValue }
    var label: String {
        switch self {
        case .monday: return "Mon"
        case .tuesday: return "Tue"
        case .wednesday: return "Wed"
        case .thursday: return "Thu"
        case .friday: return "Fri"
        case .saturday: return "Sat"
        case .sunday: return "Sun"
        }
    }
    var fullLabel: String {
        switch self {
        case .monday: return "Monday"
        case .tuesday: return "Tuesday"
        case .wednesday: return "Wednesday"
        case .thursday: return "Thursday"
        case .friday: return "Friday"
        case .saturday: return "Saturday"
        case .sunday: return "Sunday"
        }
    }
}

enum Priority: String, Codable, CaseIterable {
    case high, medium, low
    var label: String { rawValue.capitalized }
}

enum SchedulePeriod: String, Codable, CaseIterable {
    case week
    case twoWeeks = "2weeks"
    case month

    var label: String {
        switch self {
        case .week: return "per week"
        case .twoWeeks: return "per 2 weeks"
        case .month: return "per month"
        }
    }
}

enum SchedulingStrategy: String, Codable, CaseIterable {
    case pack, alternate, spread
    var label: String {
        switch self {
        case .pack: return "Pack days (Mon-Tue, Wed-Thu)"
        case .alternate: return "Alternate days (Mon→Wed, Tue→Thu mirror)"
        case .spread: return "Spread evenly across the week"
        }
    }
}

// MARK: - Core models

struct Coords: Codable, Equatable {
    var lat: Double
    var lon: Double
}

/// One availability window per calendar day in the workspace JSON (`day` + times only).
/// A stable `id` is kept for SwiftUI lists and is not encoded — web and API payloads stay unchanged.
struct TimeWindow: Codable, Identifiable, Equatable {
    var id: UUID
    var day: DayOfWeek
    var startTime: String  // "HH:MM" 24h
    var endTime: String

    enum CodingKeys: String, CodingKey {
        case day, startTime, endTime
    }

    init(id: UUID = UUID(), day: DayOfWeek, startTime: String, endTime: String) {
        self.id = id
        self.day = day
        self.startTime = startTime
        self.endTime = endTime
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = UUID()
        day = try c.decode(DayOfWeek.self, forKey: .day)
        startTime = try c.decode(String.self, forKey: .startTime)
        endTime = try c.decode(String.self, forKey: .endTime)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(day, forKey: .day)
        try c.encode(startTime, forKey: .startTime)
        try c.encode(endTime, forKey: .endTime)
    }
}

struct Client: Codable, Identifiable {
    var id: String
    var name: String
    var address: String
    var coords: Coords?
    var visitDurationMinutes: Int
    var visitsPerPeriod: Int
    var period: SchedulePeriod
    var priority: Priority
    var timeWindows: [TimeWindow]
    var notes: String
    var excludedFromSchedule: Bool?

    var isExcluded: Bool { excludedFromSchedule == true }
}

struct WorkerProfile: Codable {
    var name: String
    var homeAddress: String
    var homeCoords: Coords?
    var workingHours: WorkingHours
    var daysOff: [DayOfWeek]
    /// Weekdays for manual-only visits; excluded from `generateWeekSchedule`.
    var makeUpDays: [DayOfWeek]
    var breaks: [WorkBreak]
    var schedulingStrategy: SchedulingStrategy

    struct WorkingHours: Codable {
        var startTime: String
        var endTime: String
    }

    struct WorkBreak: Codable, Identifiable {
        var startTime: String
        var endTime: String
        var label: String
        var id: String { "\(startTime)-\(endTime)-\(label)" }

        /// Omit computed `id` so synthesis matches web JSON (no `id` on breaks).
        private enum CodingKeys: String, CodingKey {
            case startTime, endTime, label
        }
    }

    private enum CodingKeys: String, CodingKey {
        case name, homeAddress, homeCoords, workingHours, daysOff, makeUpDays, breaks, schedulingStrategy
    }

    init(
        name: String,
        homeAddress: String,
        homeCoords: Coords? = nil,
        workingHours: WorkingHours,
        daysOff: [DayOfWeek],
        makeUpDays: [DayOfWeek] = [],
        breaks: [WorkBreak],
        schedulingStrategy: SchedulingStrategy
    ) {
        self.name = name
        self.homeAddress = homeAddress
        self.homeCoords = homeCoords
        self.workingHours = workingHours
        self.daysOff = daysOff
        self.makeUpDays = makeUpDays
        self.breaks = breaks
        self.schedulingStrategy = schedulingStrategy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        homeAddress = try c.decode(String.self, forKey: .homeAddress)
        homeCoords = try c.decodeIfPresent(Coords.self, forKey: .homeCoords)
        workingHours = try c.decode(WorkingHours.self, forKey: .workingHours)
        daysOff = try c.decode([DayOfWeek].self, forKey: .daysOff)
        makeUpDays = try c.decodeIfPresent([DayOfWeek].self, forKey: .makeUpDays) ?? []
        breaks = try c.decode([WorkBreak].self, forKey: .breaks)
        schedulingStrategy = try c.decode(SchedulingStrategy.self, forKey: .schedulingStrategy)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(homeAddress, forKey: .homeAddress)
        try c.encodeIfPresent(homeCoords, forKey: .homeCoords)
        try c.encode(workingHours, forKey: .workingHours)
        try c.encode(daysOff, forKey: .daysOff)
        try c.encode(makeUpDays, forKey: .makeUpDays)
        try c.encode(breaks, forKey: .breaks)
        try c.encode(schedulingStrategy, forKey: .schedulingStrategy)
    }

    /// Calendar tabs: not a day off (includes make-up days).
    var visibleCalendarDays: [DayOfWeek] {
        DayOfWeek.allCases.filter { !daysOff.contains($0) }
    }

    /// Days eligible for automatic placement.
    var autoSchedulingDays: [DayOfWeek] {
        let makeup = Set(makeUpDays)
        return DayOfWeek.allCases.filter { !daysOff.contains($0) && !makeup.contains($0) }
    }
}

// MARK: - Schedule models

struct ScheduledVisit: Codable {
    var clientId: String
    var startTime: String  // "HH:MM"
    var endTime: String
    var travelTimeFromPrev: Int  // minutes
    var travelDistanceMiFromPrev: Double?
    var manuallyPlaced: Bool?
}

struct DaySchedule: Codable, Identifiable {
    var id: String { "\(day.rawValue)-\(date)" }
    var day: DayOfWeek
    var date: String  // ISO date "YYYY-MM-DD"
    var visits: [ScheduledVisit]
    var totalTravelMinutes: Int
    var leaveHomeTime: String
    var arriveHomeTime: String

    /// Omit computed `id` so JSON matches the web payload (no `id` on day rows).
    private enum CodingKeys: String, CodingKey {
        case day, date, visits, totalTravelMinutes, leaveHomeTime, arriveHomeTime
    }
}

struct UnmetVisit: Codable {
    var clientId: String
    var missing: Int
}

struct WeekSchedule: Codable {
    var weekStartDate: String
    var days: [DaySchedule]
    var totalTravelMinutes: Int
    var totalTimeAwayMinutes: Int
    var clientGroups: [String: String]?
    var unmetVisits: [UnmetVisit]?
    var recommendedDrops: [String]?
}

struct SavedSchedule: Codable, Identifiable {
    var id: String
    var name: String
    var savedAt: String
    var schedule: WeekSchedule
}

// MARK: - Workspace root

struct Workspace: Codable {
    var version: Int
    var worker: WorkerProfile
    var clients: [Client]
    var travelTimes: TravelTimeMatrix
    var travelTimeErrors: TravelTimeErrors?
    var lastSchedule: WeekSchedule?
    var savedSchedules: [SavedSchedule]?
}

// MARK: - Travel key helper

func travelKey(_ a: String, _ b: String) -> String {
    [a, b].sorted().joined(separator: "|")
}

// MARK: - Time parsing helpers

extension String {
    /// Parse "HH:MM" into today's Date, nil if invalid.
    func asTimeToday() -> Date? {
        let parts = split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        let cal = Calendar.current
        return cal.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date())
    }

    /// Parse "HH:MM" into a Date on a specific day (ISO date string "YYYY-MM-DD").
    func asTimeOn(isoDate: String) -> Date? {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd HH:mm"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        return fmt.date(from: "\(isoDate) \(self)")
    }
}

// MARK: - Default workspace

let defaultWorkspace = Workspace(
    version: 1,
    worker: WorkerProfile(
        name: "",
        homeAddress: "",
        workingHours: WorkerProfile.WorkingHours(startTime: "08:00", endTime: "17:00"),
        daysOff: [.saturday, .sunday],
        makeUpDays: [],
        breaks: [WorkerProfile.WorkBreak(startTime: "12:00", endTime: "13:00", label: "Lunch")],
        schedulingStrategy: .spread
    ),
    clients: [],
    travelTimes: [:],
    travelTimeErrors: nil,
    lastSchedule: nil,
    savedSchedules: nil
)

// MARK: - API request/response types

struct LoginRequest: Encodable {
    let email: String
    let password: String
    let code: String?
}

struct TenantMembership: Decodable, Equatable {
    let id: String
    let slug: String
    let name: String?
    let role: String
}

struct MeResponse: Decodable {
    let id: String
    let email: String
    let tenants: [TenantMembership]
    let totpEnrolled: Bool
    let mfaDisabled: Bool?
    let isAdmin: Bool?
}

struct PostEventsResponse: Decodable {
    struct Accepted: Decodable {
        let clientEventId: String
        let seq: Int
        let serverReceivedAt: String
    }
    let accepted: [Accepted]
}

struct EmptyResponse: Decodable {}
