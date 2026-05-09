import Foundation

/// Persists failed `POST /api/events` batches so they can be retried after reconnect (mirrors web outbox).
@MainActor
final class EventOutboxStore {
    static let shared = EventOutboxStore()

    private let fileURL: URL

    private struct PersistedBatch: Codable {
        var eventsJSON: Data
    }

    private struct FileContents: Codable {
        var batches: [PersistedBatch]
    }

    private init() {
        let fm = FileManager.default
        let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("com.lovelesslabs.RouteCare", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("pending-events-outbox-v2.json", isDirectory: false)
    }

    var hasPending: Bool {
        (try? loadRoot())?.batches.isEmpty == false
    }

    func enqueue(events: [[String: Any]]) throws {
        let eventsJSON = try JSONSerialization.data(withJSONObject: events)
        var root = (try? loadRoot()) ?? FileContents(batches: [])
        root.batches.append(PersistedBatch(eventsJSON: eventsJSON))
        try saveRoot(root)
    }

    func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Flushes batches in order until the first failure (queue unchanged after failure).
    func drainAllBatches(using process: ([[String: Any]]) async throws -> Void) async throws {
        var root = (try? loadRoot()) ?? FileContents(batches: [])
        while let first = root.batches.first {
            guard let events = try JSONSerialization.jsonObject(with: first.eventsJSON) as? [[String: Any]] else {
                root.batches.removeFirst()
                try saveRoot(root)
                continue
            }
            try await process(events)
            root.batches.removeFirst()
            try saveRoot(root)
        }
    }

    private func loadRoot() throws -> FileContents {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return FileContents(batches: [])
        }
        let data = try Data(contentsOf: fileURL)
        return try JSONDecoder().decode(FileContents.self, from: data)
    }

    private func saveRoot(_ root: FileContents) throws {
        let data = try JSONEncoder().encode(root)
        try data.write(to: fileURL, options: [.atomic])
    }
}
