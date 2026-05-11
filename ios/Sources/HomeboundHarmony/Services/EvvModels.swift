import Foundation
import CoreLocation

// MARK: - GPS payload (matches web app's gps object shape)

struct EvvGpsPayload: Codable {
    var lat: Double
    var lon: Double
    var accuracyM: Double
    var capturedAt: String
    var staleSeconds: Int?

    init(from location: CLLocation) {
        lat = location.coordinate.latitude
        lon = location.coordinate.longitude
        accuracyM = location.horizontalAccuracy
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime]
        capturedAt = fmt.string(from: location.timestamp)
        staleSeconds = max(0, Int(-location.timestamp.timeIntervalSinceNow))
    }
}

// MARK: - Check-in

struct EvvCheckInRequest: Codable {
    var clientId: String
    var gps: EvvGpsPayload
    var verificationMethod: String
    var serviceCode: String?
    var scheduleVisitId: String?
    var dayDate: String?
    var visitIndex: Int?
}

struct EvvCheckInResponse: Codable {
    var id: String
}

// MARK: - Check-out

struct EvvCheckOutRequest: Codable {
    var gps: EvvGpsPayload
    var dayDate: String?
    var visitIndex: Int?
}

struct EvvCheckOutResponse: Codable {
    var durationMinutes: Int
    var billableUnits: Int
}

// MARK: - Active visit

struct EvvActiveVisit: Codable {
    var id: String
    var clientId: String
    var clientName: String
    var clientAddress: String
    var checkInAt: String
    var visitStatus: String
}

struct EvvActiveVisitResponse: Codable {
    var visit: EvvActiveVisit?
}

// MARK: - Task templates

struct TaskTemplate: Codable, Identifiable {
    var id: String
    var label: String
    var category: String
    var sortOrder: Int
}

struct TaskTemplatesResponse: Codable {
    var templates: [TaskTemplate]
}

// MARK: - Visit notes

struct TaskItem: Codable, Identifiable, Equatable {
    var id: String
    var label: String
    var completed: Bool
}

struct EvvUpsertNoteRequest: Codable {
    var tasksCompleted: [TaskItem]
    var freeText: String
}

struct EvvVisitNote: Codable, Identifiable {
    var id: String
    var version: Int
    var tasksCompleted: [TaskItem]
    var freeText: String
    var isFinal: Bool
    var signedAt: String?
    var caregiverSignature: String?
    var submittedAt: String?
}

struct EvvNotesResponse: Codable {
    var notes: [EvvVisitNote]
}

struct EvvSignNoteRequest: Codable {
    var signature: String
    var gps: EvvGpsPayload?
}
