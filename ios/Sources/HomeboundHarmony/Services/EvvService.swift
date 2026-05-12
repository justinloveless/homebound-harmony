import Foundation

struct EvvService {
    private let api: APIService

    init(api: APIService) {
        self.api = api
    }

    func checkIn(_ req: EvvCheckInRequest) async throws -> EvvCheckInResponse {
        try await api.post(path: "/api/evv/check-in", body: req)
    }

    func checkOut(visitId: String, req: EvvCheckOutRequest) async throws -> EvvCheckOutResponse {
        try await api.post(path: "/api/evv/\(visitId)/check-out", body: req)
    }

    func getActiveVisit() async throws -> EvvActiveVisitResponse {
        try await api.get(path: "/api/evv/active")
    }

    func fetchTaskTemplates() async throws -> TaskTemplatesResponse {
        try await api.get(path: "/api/task-templates")
    }

    func upsertNote(visitId: String, req: EvvUpsertNoteRequest) async throws -> EvvVisitNote {
        try await api.post(path: "/api/evv/\(visitId)/notes", body: req)
    }

    func signNote(visitId: String, noteId: String, req: EvvSignNoteRequest) async throws -> EvvVisitNote {
        try await api.post(path: "/api/evv/\(visitId)/notes/\(noteId)/sign", body: req)
    }

    func getNotes(visitId: String) async throws -> EvvNotesResponse {
        try await api.get(path: "/api/evv/\(visitId)/notes")
    }
}
