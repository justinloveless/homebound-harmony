import Foundation
import CryptoKit

struct ServerEventRow: Decodable {
    let clientEventId: String
    let seq: Int
    let ciphertext: String
    let iv: String
}

struct EventsListResponse: Decodable {
    let events: [ServerEventRow]
}

struct PostEventsResponse: Decodable {
    struct Accepted: Decodable {
        let clientEventId: String
        let seq: Int
        let hash: String
        let serverReceivedAt: String
    }
    let accepted: [Accepted]
}

struct PutSnapshotResponse: Decodable {
    let version: Int
    let snapshotSeq: Int
}

/// Encrypted event log + snapshot API (mirrors web `src/lib/outbox.ts` + `sync.ts`).
final class EventLogClient {
    private let api: APIService
    private let crypto: CryptoService

    init(api: APIService, crypto: CryptoService) {
        self.api = api
        self.crypto = crypto
    }

    func getSnapshot() async throws -> ServerSnapshot {
        try await api.get(path: "/api/snapshot")
    }

    func getEvents(since: Int) async throws -> [ServerEventRow] {
        let res: EventsListResponse = try await api.get(path: "/api/events?since=\(since)&limit=500")
        return res.events
    }

    func putSnapshot(ciphertext: String, iv: String, snapshotSeq: Int, expectedVersion: Int) async throws -> PutSnapshotResponse {
        struct Body: Encodable {
            let ciphertext: String
            let iv: String
            let snapshotSeq: Int
            let version: Int
        }
        return try await api.put(
            path: "/api/snapshot",
            body: Body(ciphertext: ciphertext, iv: iv, snapshotSeq: snapshotSeq, version: expectedVersion),
            headers: ["If-Match": "\"\(expectedVersion)\""]
        )
    }

    /// Decrypt event rows to JSON objects for `EventReducer`.
    func decryptEvents(_ rows: [ServerEventRow], key: SymmetricKey) throws -> [[String: Any]] {
        var out: [[String: Any]] = []
        for r in rows {
            let blob = EncryptedBlob(ciphertext: r.ciphertext, iv: r.iv)
            let data = try crypto.decryptJSONData(blob: blob, key: key)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            out.append(obj)
        }
        return out
    }

    /// Build encrypted wire row for POST /api/events.
    func buildWireRow(event: [String: Any], key: SymmetricKey, isClinical: Bool) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: event, options: [])
        let blob = try crypto.encryptJSONData(data, key: key)
        var row: [String: Any] = [
            "clientEventId": event["clientEventId"] as Any,
            "clientClaimedAt": event["claimedAt"] as Any,
            "isClinical": isClinical,
            "ciphertext": blob.ciphertext,
            "iv": blob.iv,
        ]
        if let gps = event["gps"] as? [String: Any] {
            row["gpsLat"] = gps["lat"] as Any
            row["gpsLon"] = gps["lon"] as Any
            row["gpsAccuracyM"] = gps["accuracyM"] as Any
            row["gpsCapturedAt"] = gps["capturedAt"] as Any
            if let stale = gps["staleSeconds"] as? Int { row["gpsStaleSeconds"] = stale }
        } else if isClinical {
            row["gpsLat"] = NSNull()
            row["gpsLon"] = NSNull()
        }
        return row
    }
}
