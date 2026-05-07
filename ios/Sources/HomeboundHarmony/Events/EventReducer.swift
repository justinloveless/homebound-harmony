import Foundation

/// Pure workspace reducer mirroring `src/lib/events.ts`.
enum EventReducer {

    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    private static func decodePayload<T: Decodable>(_ payload: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        return try decoder.decode(T.self, from: data)
    }

    private static func estimateTravelMinutes(_ a: Coords, _ b: Coords) -> Int {
        let R = 6371.0
        func toRad(_ deg: Double) -> Double { deg * .pi / 180 }
        let dLat = toRad(b.lat - a.lat)
        let dLon = toRad(b.lon - a.lon)
        let sinLat = sin(dLat / 2)
        let sinLon = sin(dLon / 2)
        let h = sinLat * sinLat + cos(toRad(a.lat)) * cos(toRad(b.lat)) * sinLon * sinLon
        let distKm = 2 * R * asin(sqrt(min(1, max(0, h))))
        let driveKm = distKm * 1.3
        return max(5, Int((driveKm / 40.0 * 60.0).rounded()))
    }

    private static func recalcTravelTimes(_ ws: Workspace) -> TravelTimeMatrix {
        var matrix = ws.travelTimes
        struct Loc { var id: String; var coords: Coords? }
        var locs: [Loc] = [Loc(id: "home", coords: ws.worker.homeCoords)]
        locs.append(contentsOf: ws.clients.map { Loc(id: $0.id, coords: $0.coords) })
        for i in 0..<locs.count {
            for j in (i + 1)..<locs.count {
                let a = locs[i], b = locs[j]
                if let ca = a.coords, let cb = b.coords {
                    matrix[travelKey(a.id, b.id)] = Double(estimateTravelMinutes(ca, cb))
                }
            }
        }
        return matrix
    }

    static func apply(_ state: Workspace, event: [String: Any]) throws -> Workspace {
        guard let kind = event["kind"] as? String else { return state }
        let payload = event["payload"]

        switch kind {
        case "worker_updated":
            let w: WorkerProfile = try decodePayload(payload!)
            var next = state
            next.worker = w
            next.travelTimes = recalcTravelTimes(next)
            return next
        case "clients_set":
            let clients: [Client] = try decodePayload(payload!)
            var next = state
            next.clients = clients
            next.travelTimes = recalcTravelTimes(next)
            return next
        case "client_added":
            let c: Client = try decodePayload(payload!)
            var next = state
            next.clients.append(c)
            next.travelTimes = recalcTravelTimes(next)
            return next
        case "client_updated":
            let c: Client = try decodePayload(payload!)
            var next = state
            next.clients = next.clients.map { $0.id == c.id ? c : $0 }
            next.travelTimes = recalcTravelTimes(next)
            return next
        case "client_removed":
            struct P: Decodable { let id: String }
            let p: P = try decodePayload(payload!)
            var next = state
            next.clients.removeAll { $0.id == p.id }
            return next
        case "travel_times_set":
            let m: TravelTimeMatrix = try decodePayload(payload!)
            var next = state
            next.travelTimes = m
            return next
        case "travel_time_errors_set":
            let e: TravelTimeErrors = try decodePayload(payload!)
            var next = state
            next.travelTimeErrors = e
            return next
        case "schedule_set":
            var next = state
            if payload is NSNull || payload == nil {
                next.lastSchedule = nil
            } else {
                next.lastSchedule = try decodePayload(payload!)
            }
            return next
        case "saved_schedule_added":
            let s: SavedSchedule = try decodePayload(payload!)
            var next = state
            var arr = next.savedSchedules ?? []
            arr.append(s)
            next.savedSchedules = arr
            return next
        case "saved_schedule_loaded":
            struct P: Decodable { let id: String }
            let p: P = try decodePayload(payload!)
            guard let saved = (state.savedSchedules ?? []).first(where: { $0.id == p.id }) else { return state }
            var next = state
            next.lastSchedule = saved.schedule
            return next
        case "saved_schedule_removed":
            struct P: Decodable { let id: String }
            let p: P = try decodePayload(payload!)
            var next = state
            next.savedSchedules = (next.savedSchedules ?? []).filter { $0.id != p.id }
            return next
        case "saved_schedule_renamed":
            struct P: Decodable { let id: String; let name: String }
            let p: P = try decodePayload(payload!)
            var next = state
            next.savedSchedules = (next.savedSchedules ?? []).map { $0.id == p.id ? SavedSchedule(id: $0.id, name: p.name, savedAt: $0.savedAt, schedule: $0.schedule) : $0 }
            return next
        case "workspace_imported":
            return try decodePayload(payload!)
        case "share_create", "visit_started", "visit_completed", "visit_note_added":
            return state
        default:
            return state
        }
    }

    static func replay(_ snapshot: Workspace, events: [[String: Any]]) throws -> Workspace {
        try events.reduce(snapshot) { try apply($0, event: $1) }
    }
}
