import Foundation

// Pull: REST workspace bundle (workers, clients, schedules, travel times) + domain events for visit replay.
// Push: POST /api/events with plaintext rows (matches server `routes/events.ts`).

enum SyncError: LocalizedError, Equatable {
    case noTenant
    case noWorkerProfile
    case badEventResponse
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .noTenant:
            return "No tenant selected. Sign in again or complete workspace setup on the web."
        case .noWorkerProfile:
            return "Worker profile not found. Finish onboarding in the web app first."
        case .badEventResponse:
            return "Could not read events from the server."
        case .serverError(let s):
            return "Server error (\(s)). Try again."
        }
    }
}

final class SyncService {
    private let api: APIService

    init(api: APIService) {
        self.api = api
    }

    /// Full workspace from relational API + max domain-event seq + visit events for `VisitRuntimeReplayer`.
    func pullFullSync() async throws -> (workspace: Workspace, snapshotSeq: Int, visitEventDicts: [[String: Any]]) {
        let bundle = try await fetchWorkspaceBundle()
        let (seq, visitDicts) = try await fetchAllVisitReplayEvents()
        return (bundle, seq, visitDicts)
    }

    func pushEvents(events: [[String: Any]]) async throws {
        var wires: [[String: Any]] = []
        for ev in events {
            wires.append(try buildPlainWireRow(event: ev))
        }
        let body: [String: Any] = ["events": wires]
        let _: PostEventsResponse = try await api.postJSONObject(path: "/api/events", object: body)
    }

    // MARK: - Bundle (mirrors web `fetchWorkspaceBundle`)

    private struct WorkerMeResponse: Decodable {
        let id: String
        let userId: String?
        let name: String
        let homeAddress: String
        let homeCoords: Coords?
        let workingHours: WorkerProfile.WorkingHours
        let daysOff: [DayOfWeek]
        let makeUpDays: [DayOfWeek]?
        let breaks: [WorkerProfile.WorkBreak]
        let schedulingStrategy: SchedulingStrategy

        func toProfile() -> WorkerProfile {
            WorkerProfile(
                name: name,
                homeAddress: homeAddress,
                homeCoords: homeCoords,
                workingHours: workingHours,
                daysOff: daysOff,
                makeUpDays: makeUpDays ?? [],
                breaks: breaks,
                schedulingStrategy: schedulingStrategy
            )
        }
    }

    private struct ClientsResponse: Decodable {
        let clients: [Client]
    }

    private struct TravelTimesResponse: Decodable {
        let travelTimes: TravelTimeMatrix?
        let travelTimeErrors: TravelTimeErrors?
    }

    private struct CurrentScheduleResponse: Decodable {
        struct Envelope: Decodable {
            let weekSchedule: WeekSchedule
        }
        let schedule: Envelope?
    }

    private struct SchedulesListResponse: Decodable {
        struct Row: Decodable {
            let id: String
            let isSaved: Bool
        }
        let schedules: [Row]
    }

    private struct ScheduleDetailResponse: Decodable {
        let id: String
        let weekSchedule: WeekSchedule
        let isSaved: Bool
        let savedName: String?
        let savedAt: String?
    }

    private func fetchWorkspaceBundle() async throws -> Workspace {
        let me: WorkerMeResponse
        do {
            me = try await api.get(path: "/api/workers/me")
        } catch APIError.httpError(404, _) {
            throw SyncError.noWorkerProfile
        }

        let clientsRes: ClientsResponse = try await api.get(path: "/api/clients")
        let tt: TravelTimesResponse = try await api.get(path: "/api/travel-times")
        let cur: CurrentScheduleResponse = try await api.get(path: "/api/schedules/current")
        let list: SchedulesListResponse = try await api.get(path: "/api/schedules")

        var savedSchedules: [SavedSchedule] = []
        for row in list.schedules where row.isSaved {
            let full: ScheduleDetailResponse = try await api.get(path: "/api/schedules/\(row.id)")
            if let name = full.savedName, let savedAt = full.savedAt {
                savedSchedules.append(
                    SavedSchedule(id: full.id, name: name, savedAt: savedAt, schedule: full.weekSchedule)
                )
            }
        }

        let lastSchedule = cur.schedule?.weekSchedule

        return Workspace(
            version: 1,
            worker: me.toProfile(),
            clients: clientsRes.clients,
            travelTimes: tt.travelTimes ?? [:],
            travelTimeErrors: tt.travelTimeErrors,
            lastSchedule: lastSchedule,
            savedSchedules: savedSchedules.isEmpty ? nil : savedSchedules
        )
    }

    // MARK: - Domain events (visit replay)

    private static let visitKinds: Set<String> = [
        "visit_started", "visit_completed", "visit_note_added",
        "evv_check_in", "evv_check_out", "visit_note_submitted", "visit_note_signed",
    ]

    private func fetchAllVisitReplayEvents() async throws -> (maxSeq: Int, dicts: [[String: Any]]) {
        var since = 0
        var maxSeq = 0
        var visitRows: [[String: Any]] = []

        while true {
            let data = try await api.getData(path: "/api/events?since=\(since)&limit=500")
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let events = root["events"] as? [[String: Any]] else {
                throw SyncError.badEventResponse
            }
            if events.isEmpty { break }

            for row in events {
                if let seq = row["seq"] as? Int {
                    maxSeq = max(maxSeq, seq)
                } else if let seq = (row["seq"] as? NSNumber)?.intValue {
                    maxSeq = max(maxSeq, seq)
                }
                guard let kind = row["kind"] as? String, Self.visitKinds.contains(kind) else { continue }
                guard let payload = row["payload"] as? [String: Any] else { continue }
                var wire: [String: Any] = ["kind": kind, "payload": payload]
                if let claimedAt = row["claimedAt"] { wire["claimedAt"] = claimedAt }
                visitRows.append(wire)
            }

            if events.count < 500 { break }
            since = maxSeq
            if since == 0 { break }
        }

        return (maxSeq, visitRows)
    }

    private func buildPlainWireRow(event: [String: Any]) throws -> [String: Any] {
        let kind = event["kind"] as? String ?? ""
        let clinical = [
            "client_added", "client_updated", "client_removed",
            "visit_started", "visit_completed", "visit_note_added",
            "evv_check_in", "evv_check_out", "visit_note_submitted", "visit_note_signed",
        ].contains(kind)
        guard let clientEventId = event["clientEventId"] as? String, !clientEventId.isEmpty else {
            throw SyncError.badEventResponse
        }
        guard let claimedAt = event["claimedAt"] as? String else {
            throw SyncError.badEventResponse
        }
        let payload = event["payload"] ?? [:]
        var row: [String: Any] = [
            "clientEventId": clientEventId,
            "clientClaimedAt": claimedAt,
            "kind": kind,
            "payload": payload,
            "isClinical": clinical,
        ]
        if let gps = event["gps"] as? [String: Any] {
            row["gpsLat"] = gps["lat"] as Any
            row["gpsLon"] = gps["lon"] as Any
            row["gpsAccuracyM"] = gps["accuracyM"] as Any
            row["gpsCapturedAt"] = gps["capturedAt"] as Any
            if let stale = gps["staleSeconds"] as? Int { row["gpsStaleSeconds"] = stale }
        } else if clinical {
            row["gpsLat"] = NSNull()
            row["gpsLon"] = NSNull()
        }
        return row
    }
}
