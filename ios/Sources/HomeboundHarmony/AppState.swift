import Foundation
import CryptoKit
import Observation

// MARK: - Auth state machine

enum AuthState: Equatable {
    case checking
    case unauthenticated
    case needsUnlock(email: String)
    case authenticated
}

// MARK: - App-level errors

enum AppError: LocalizedError {
    case noWorkspaceKey
    case noSalt
    case wrongPassword
    case noWorkspace

    var errorDescription: String? {
        switch self {
        case .noWorkspaceKey: return "Workspace key not loaded. Please unlock."
        case .noSalt:         return "Salt not available. Please log in again."
        case .wrongPassword:  return "Incorrect password."
        case .noWorkspace:    return "No workspace data found."
        }
    }
}

// MARK: - AppState

@MainActor
@Observable
final class AppState {

    // Auth
    var authState: AuthState = .checking
    var userEmail: String?
    var pdkSalt: String?

    // Workspace
    var workspace: Workspace?
    var workspaceVersion: Int = 0
    var isSyncing = false

    // UI feedback
    var errorMessage: String?
    var isLoading = false

    // Services
    let api = APIService()
    let crypto = CryptoService()
    let notifications = NotificationService()

    private let keychain = KeychainService()
    /// Sync is stateless; a fresh instance keeps `@Observable` macro compatibility (no `lazy` stored props).
    private var sync: SyncService { SyncService(api: api, crypto: crypto) }
    private var workspaceKey: SymmetricKey?

    // MARK: - Startup

    func checkAuthState() async {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil

        do {
            let me: MeResponse = try await api.get(path: "/api/auth/me")
            userEmail = me.email
            pdkSalt   = me.pdkSalt ?? keychain.loadPdkSalt()
            keychain.saveUserEmail(me.email)
            if let salt = pdkSalt { keychain.savePdkSalt(salt) }

            if let wkData = keychain.loadWorkspaceKey() {
                workspaceKey = SymmetricKey(data: wkData)
                try await pullWorkspace()
                authState = .authenticated
            } else {
                authState = .needsUnlock(email: me.email)
            }
        } catch APIError.httpError(401, _) {
            // Session expired or missing — clear cached key, show login.
            keychain.deleteWorkspaceKey()
            workspaceKey = nil
            authState    = .unauthenticated
        } catch {
            errorMessage = error.localizedDescription
            authState    = .unauthenticated
        }
    }

    // MARK: - Login (email + password + TOTP)

    func login(email: String, password: String, totpCode: String) async throws {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil

        let loginResp: LoginResponse = try await api.post(
            path: "/api/auth/login",
            body: LoginRequest(email: email, password: password, code: totpCode)
        )

        userEmail = email.lowercased()
        pdkSalt   = loginResp.pdkSalt
        keychain.savePdkSalt(loginResp.pdkSalt)
        keychain.saveUserEmail(userEmail!)

        // Derive password-derived key off the main thread.
        let pdk = try await Task.detached(priority: .userInitiated) { [crypto, loginResp, password] in
            try crypto.derivePDK(password: password, saltBase64: loginResp.pdkSalt)
        }.value

        // Fetch wrapped workspace key and unwrap it.
        let serverBlob: ServerBlob = try await api.get(path: "/api/workspace")
        workspaceVersion = serverBlob.version
        let wk = try crypto.unwrapWorkspaceKey(envelope: serverBlob.wrappedWorkspaceKey, wrappingKey: pdk)
        workspaceKey = wk

        // Persist WK in Keychain.
        wk.withUnsafeBytes { keychain.saveWorkspaceKey(Data($0)) }

        // Decrypt workspace if the blob has data.
        if !serverBlob.ciphertext.isEmpty {
            workspace = try crypto.decryptWorkspace(
                blob: EncryptedBlob(ciphertext: serverBlob.ciphertext, iv: serverBlob.iv),
                key: wk
            )
        }

        authState = .authenticated
        await scheduleNotifications()
    }

    // MARK: - Unlock (session still valid, WK not in memory)

    func unlock(password: String) async throws {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil

        guard let salt = pdkSalt ?? keychain.loadPdkSalt() else {
            throw AppError.noSalt
        }

        let pdk = try await Task.detached(priority: .userInitiated) { [crypto, salt, password] in
            try crypto.derivePDK(password: password, saltBase64: salt)
        }.value

        let serverBlob: ServerBlob = try await api.get(path: "/api/workspace")
        workspaceVersion = serverBlob.version

        // If unwrap fails with decryption error the password is wrong.
        do {
            workspaceKey = try crypto.unwrapWorkspaceKey(
                envelope: serverBlob.wrappedWorkspaceKey,
                wrappingKey: pdk
            )
        } catch {
            throw AppError.wrongPassword
        }

        workspaceKey!.withUnsafeBytes { keychain.saveWorkspaceKey(Data($0)) }

        if !serverBlob.ciphertext.isEmpty, let wk = workspaceKey {
            workspace = try crypto.decryptWorkspace(
                blob: EncryptedBlob(ciphertext: serverBlob.ciphertext, iv: serverBlob.iv),
                key: wk
            )
        }

        authState = .authenticated
        await scheduleNotifications()
    }

    // MARK: - Logout

    func logout() async {
        let _: EmptyResponse? = try? await api.post(path: "/api/auth/logout", body: Optional<String>.none)
        workspaceKey = nil
        workspace    = nil
        keychain.deleteAll()
        notifications.clearAllReminders()
        authState = .unauthenticated
    }

    // MARK: - Workspace sync

    func refreshWorkspace() async {
        guard let wk = workspaceKey, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let (ws, version) = try await sync.pull(key: wk)
            workspaceVersion = version
            if let ws { workspace = ws }
            await scheduleNotifications()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pullWorkspace() async throws {
        guard let wk = workspaceKey else { return }
        let (ws, version) = try await sync.pull(key: wk)
        workspaceVersion = version
        if let ws { workspace = ws }
    }

    private func persistWorkspace() async throws {
        guard let wk = workspaceKey, let ws = workspace else {
            throw AppError.noWorkspaceKey
        }
        do {
            workspaceVersion = try await sync.push(
                workspace: ws, key: wk, expectedVersion: workspaceVersion
            )
        } catch SyncError.conflict {
            // Pull the newer version; surface a message.
            errorMessage = "Schedule updated on another device — refreshed."
            try await pullWorkspace()
        }
    }

    // MARK: - Client mutations

    func saveClient(_ client: Client) async throws {
        var ws = workspace ?? defaultWorkspace
        if let idx = ws.clients.firstIndex(where: { $0.id == client.id }) {
            ws.clients[idx] = client
        } else {
            ws.clients.append(client)
        }
        workspace = ws
        try await persistWorkspace()
    }

    func deleteClient(id: String) async throws {
        workspace?.clients.removeAll { $0.id == id }
        try await persistWorkspace()
    }

    // MARK: - Worker profile

    func saveWorkerProfile(_ profile: WorkerProfile) async throws {
        workspace?.worker = profile
        try await persistWorkspace()
    }

    // MARK: - Notification helpers

    func scheduleNotifications() async {
        guard let ws = workspace, let schedule = ws.lastSchedule else { return }
        await notifications.scheduleForToday(schedule: schedule, clients: ws.clients)
    }
}
