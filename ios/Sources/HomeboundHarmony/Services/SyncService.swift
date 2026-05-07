import Foundation
import CryptoKit

// Pull: GET /api/snapshot + GET /api/events?since=snapshotSeq, decrypt, replay.
// Push: POST /api/events with encrypted rows (replaces legacy PUT /api/workspace).

enum SyncError: LocalizedError {
    case noWorkspaceKey
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .noWorkspaceKey:
            return "Workspace key not available. Please unlock the app."
        case .serverError(let s):
            return "Server error (\(s)). Try again."
        }
    }
}

final class SyncService {
    private let api: APIService
    private let crypto: CryptoService

    init(api: APIService, crypto: CryptoService) {
        self.api = api
        self.crypto = crypto
    }

    private var log: EventLogClient { EventLogClient(api: api, crypto: crypto) }

    func pull(key: SymmetricKey) async throws -> (
        workspace: Workspace?,
        version: Int,
        snapshotSeq: Int,
        decryptedEvents: [[String: Any]]
    ) {
        let snap = try await log.getSnapshot()
        var base: Workspace
        if snap.ciphertext.isEmpty {
            base = defaultWorkspace
        } else {
            base = try crypto.decryptWorkspace(
                blob: EncryptedBlob(ciphertext: snap.ciphertext, iv: snap.iv),
                key: key
            )
        }
        let rows = try await log.getEvents(since: snap.snapshotSeq)
        let dicts = try log.decryptEvents(rows, key: key)
        let merged = try EventReducer.replay(base, events: dicts)
        let wsOut: Workspace? = snap.ciphertext.isEmpty && dicts.isEmpty ? nil : merged
        return (wsOut, snap.version, snap.snapshotSeq, dicts)
    }

    /// Encrypt + POST one or more events, then optionally rollup snapshot.
    func pushEvents(
        events: [[String: Any]],
        key: SymmetricKey,
        workspace: Workspace,
        expectedVersion: Int
    ) async throws -> Int {
        let log = self.log
        var wires: [[String: Any]] = []
        for ev in events {
            let kind = ev["kind"] as? String ?? ""
            let clinical = ["client_added", "client_updated", "client_removed", "share_create", "visit_started", "visit_completed", "visit_note_added"].contains(kind)
            wires.append(try log.buildWireRow(event: ev, key: key, isClinical: clinical))
        }
        let body: [String: Any] = ["events": wires]
        let _: PostEventsResponse = try await api.postJSONObject(path: "/api/events", object: body)
        // Snapshot rollup (PUT /api/snapshot) is optional on mobile; server `version` advances only on rollup.
        return expectedVersion
    }
}
