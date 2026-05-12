import Foundation

enum EvvOutboxAction: Codable {
    case checkIn(visitKey: String, request: EvvCheckInRequest)
    case checkOut(visitKey: String, request: EvvCheckOutRequest)
    case upsertNote(visitKey: String, request: EvvUpsertNoteRequest)
    case signNote(visitKey: String, noteId: String?, request: EvvSignNoteRequest)
}

struct EvvOutboxEntry: Codable {
    var id: UUID
    var action: EvvOutboxAction
    var createdAt: Date
}

@MainActor
final class EvvOutboxStore {
    static let shared = EvvOutboxStore()

    private let fileURL: URL

    private struct FileContents: Codable {
        var entries: [EvvOutboxEntry]
    }

    private init() {
        let fm = FileManager.default
        let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("com.lovelesslabs.RouteCare", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("pending-evv-outbox-v1.json", isDirectory: false)
    }

    var hasPending: Bool {
        (try? loadRoot())?.entries.isEmpty == false
    }

    func enqueue(_ action: EvvOutboxAction) throws {
        var root = (try? loadRoot()) ?? FileContents(entries: [])
        root.entries.append(EvvOutboxEntry(id: UUID(), action: action, createdAt: Date()))
        try saveRoot(root)
    }

    func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Drains entries sequentially, resolving evvVisitId dependencies across check-in → check-out chains.
    func drainAll(using service: EvvService, runtimeStore: VisitRuntimeStore) async throws {
        var root = (try? loadRoot()) ?? FileContents(entries: [])
        var resolvedVisitIds: [String: String] = [:]

        while let entry = root.entries.first {
            do {
                try await process(entry, using: service, runtimeStore: runtimeStore, resolvedVisitIds: &resolvedVisitIds)
                root.entries.removeFirst()
                try saveRoot(root)
            } catch let error as APIError {
                if case .httpError(409, _) = error {
                    root.entries.removeFirst()
                    try saveRoot(root)
                    continue
                }
                throw error
            }
        }
    }

    private func process(
        _ entry: EvvOutboxEntry,
        using service: EvvService,
        runtimeStore: VisitRuntimeStore,
        resolvedVisitIds: inout [String: String]
    ) async throws {
        switch entry.action {
        case .checkIn(let visitKey, let request):
            let resp = try await service.checkIn(request)
            resolvedVisitIds[visitKey] = resp.id
            if let state = findState(visitKey: visitKey, in: runtimeStore) {
                var updated = state
                updated.evvVisitId = resp.id
                runtimeStore.upsert(updated)
            }

        case .checkOut(let visitKey, let request):
            guard let evvVisitId = resolveVisitId(visitKey: visitKey, resolvedVisitIds: resolvedVisitIds, runtimeStore: runtimeStore) else {
                throw EvvOutboxError.dependencyUnresolved
            }
            _ = try await service.checkOut(visitId: evvVisitId, req: request)

        case .upsertNote(let visitKey, let request):
            guard let evvVisitId = resolveVisitId(visitKey: visitKey, resolvedVisitIds: resolvedVisitIds, runtimeStore: runtimeStore) else {
                throw EvvOutboxError.dependencyUnresolved
            }
            let note = try await service.upsertNote(visitId: evvVisitId, req: request)
            if let state = findState(visitKey: visitKey, in: runtimeStore) {
                var updated = state
                updated.evvNoteId = note.id
                updated.evvNoteStatus = "draft"
                runtimeStore.upsert(updated)
            }

        case .signNote(let visitKey, let noteId, let request):
            guard let evvVisitId = resolveVisitId(visitKey: visitKey, resolvedVisitIds: resolvedVisitIds, runtimeStore: runtimeStore) else {
                throw EvvOutboxError.dependencyUnresolved
            }
            guard let resolvedNoteId = noteId ?? findState(visitKey: visitKey, in: runtimeStore)?.evvNoteId else {
                throw EvvOutboxError.dependencyUnresolved
            }
            _ = try await service.signNote(visitId: evvVisitId, noteId: resolvedNoteId, req: request)
            if let state = findState(visitKey: visitKey, in: runtimeStore) {
                var updated = state
                updated.evvNoteStatus = "signed"
                runtimeStore.upsert(updated)
            }
        }
    }

    private func resolveVisitId(visitKey: String, resolvedVisitIds: [String: String], runtimeStore: VisitRuntimeStore) -> String? {
        if let id = resolvedVisitIds[visitKey] { return id }
        return runtimeStore.allStates().first { $0.visitKey == visitKey }?.evvVisitId
    }

    private func findState(visitKey: String, in store: VisitRuntimeStore) -> VisitRuntimeState? {
        store.allStates().first { $0.visitKey == visitKey }
    }

    private func loadRoot() throws -> FileContents {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return FileContents(entries: [])
        }
        let data = try Data(contentsOf: fileURL)
        return try JSONDecoder().decode(FileContents.self, from: data)
    }

    private func saveRoot(_ root: FileContents) throws {
        let data = try JSONEncoder().encode(root)
        try data.write(to: fileURL, options: [.atomic])
    }
}

enum EvvOutboxError: Error {
    case dependencyUnresolved
}
