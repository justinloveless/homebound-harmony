import Foundation
import CryptoKit

// Mirrors the pull / push logic in src/lib/sync.ts.
// The server holds a versioned encrypted blob; the iOS app uses
// optimistic concurrency (If-Match) and re-pulls on 412 conflicts.

enum SyncError: LocalizedError {
    case noWorkspaceKey
    case conflict(serverVersion: Int)
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .noWorkspaceKey:
            return "Workspace key not available. Please unlock the app."
        case .conflict:
            return "Your schedule was updated on another device. Refreshing..."
        case .serverError(let s):
            return "Server error (\(s)). Try again."
        }
    }
}

final class SyncService {
    private let api: APIService
    private let crypto: CryptoService

    init(api: APIService, crypto: CryptoService) {
        self.api    = api
        self.crypto = crypto
    }

    // MARK: - Pull

    /// Fetches the encrypted blob and decrypts it with `key`.
    /// Returns `nil` if the server blob is empty (new account).
    func pull(key: SymmetricKey) async throws -> (workspace: Workspace?, version: Int) {
        let blob: ServerBlob = try await api.get(path: "/api/workspace")
        guard !blob.ciphertext.isEmpty, !blob.iv.isEmpty else {
            return (nil, blob.version)
        }
        let ws = try crypto.decryptWorkspace(
            blob: EncryptedBlob(ciphertext: blob.ciphertext, iv: blob.iv),
            key: key
        )
        return (ws, blob.version)
    }

    // MARK: - Push

    /// Encrypts `workspace` and uploads it. Returns the new server version.
    /// Throws `SyncError.conflict` on 412 so the caller can re-pull and retry.
    func push(workspace: Workspace, key: SymmetricKey, expectedVersion: Int) async throws -> Int {
        let blob = try crypto.encryptWorkspace(workspace, key: key)
        let body = PutWorkspaceRequest(ciphertext: blob.ciphertext, iv: blob.iv)
        let headers = ["If-Match": "\"\(expectedVersion)\""]

        do {
            let res: PutWorkspaceResponse = try await api.put(
                path: "/api/workspace",
                body: body,
                headers: headers
            )
            return res.version
        } catch APIError.httpError(412, _) {
            // Server has a newer version; caller should pull first.
            throw SyncError.conflict(serverVersion: expectedVersion)
        }
    }
}
