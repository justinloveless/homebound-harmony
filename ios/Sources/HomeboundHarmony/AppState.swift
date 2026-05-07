import Foundation
import CryptoKit
import CoreLocation
import Observation
import WidgetKit

// MARK: - Auth state machine

enum AuthState: Equatable {
    case checking
    case unauthenticated
    case needsUnlock(email: String)
    case authenticated
    case appUpdateRequired(serverMin: String, message: String?)
}

// MARK: - App-level errors

enum AppError: LocalizedError {
    case noWorkspaceKey
    case noSalt
    case wrongPassword
    case noWorkspace
    case noTodaySchedule
    case noCheckInTarget
    case cannotCheckInVisit
    case locationRequired

    var errorDescription: String? {
        switch self {
        case .noWorkspaceKey: return "Workspace key not loaded. Please unlock."
        case .noSalt:         return "Salt not available. Please log in again."
        case .wrongPassword:  return "Incorrect password."
        case .noWorkspace:    return "No workspace data found."
        case .noTodaySchedule: return "No visits scheduled for today."
        case .noCheckInTarget: return "No visit is currently active or upcoming."
        case .cannotCheckInVisit: return "Unable to check in for this visit."
        case .locationRequired: return "Location is required for this action."
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
    /// Server snapshot row `snapshot_seq` — tail events have `seq > snapshotSeq`.
    var snapshotSeq: Int = 0
    var isSyncing = false

    private let arrivalVerifier = ArrivalVerificationService()
    private let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Bumped when local visit check-in state changes so SwiftUI refreshes (store is not `@Observable`).
    private(set) var visitRuntimeRevision: Int = 0

    // UI feedback
    var errorMessage: String?
    var isLoading = false

    // Services
    let api = APIService()
    let crypto = CryptoService()
    let notifications = NotificationService()
    let visitRuntimeStore = VisitRuntimeStore()
    private var checkInEngine: VisitCheckInEngine { VisitCheckInEngine(store: visitRuntimeStore) }

    private let keychain = KeychainService()
    /// Sync is stateless; a fresh instance keeps `@Observable` macro compatibility (no `lazy` stored props).
    private var sync: SyncService { SyncService(api: api, crypto: crypto) }
    private var workspaceKey: SymmetricKey?

    @ObservationIgnored private var eventStreamTask: Task<Void, Never>?
    @ObservationIgnored private var eventStreamDebounceTask: Task<Void, Never>?

    /// Call when `Notification.Name.appUpdateRequired` fires (410 or stale build vs `X-Min-Client-Version`).
    func handleAppUpdateRequiredNotification(_ notification: Notification) {
        stopEventStream()
        let min = (notification.userInfo?["minClientVersion"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let serverMin = (min?.isEmpty == false) ? min! : "unknown"
        let message = notification.userInfo?["message"] as? String
        authState = .appUpdateRequired(serverMin: serverMin, message: message)
    }

    // MARK: - Startup

    func checkAuthState() async {
        isLoading = true
        defer { isLoading = false }
        defer { reconcileEventStream() }
        errorMessage = nil

        do {
            let me: MeResponse = try await api.getAuthMeValidatingClientVersion()
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
            if case APIError.requiresAppUpdate(let min, let msg) = error {
                authState = .appUpdateRequired(serverMin: min, message: msg)
                return
            }
            errorMessage = error.localizedDescription
            authState    = .unauthenticated
        }
    }

    // MARK: - Login (email + password, optional TOTP)

    func login(email: String, password: String, totpCode: String?) async throws {
        isLoading = true
        defer { isLoading = false }
        defer { reconcileEventStream() }
        errorMessage = nil

        let loginResp: LoginResponse = try await api.post(
            path: "/api/auth/login",
            body: LoginRequest(email: email, password: password, code: totpCode)
        )

        userEmail = email.lowercased()
        pdkSalt   = loginResp.pdkSalt
        keychain.savePdkSalt(loginResp.pdkSalt)
        keychain.saveUserEmail(userEmail!)

        do {
            _ = try await api.getAuthMeValidatingClientVersion()
        } catch {
            if case APIError.requiresAppUpdate(let min, let msg) = error {
                authState = .appUpdateRequired(serverMin: min, message: msg)
                return
            }
            throw error
        }

        // Derive password-derived key off the main thread.
        let pdk = try await Task.detached(priority: .userInitiated) { [crypto, loginResp, password] in
            try crypto.derivePDK(password: password, saltBase64: loginResp.pdkSalt)
        }.value

        let snap: ServerSnapshot = try await api.get(path: "/api/snapshot")
        if let wid = snap.workspaceId { APIService.activeWorkspaceId = wid }
        workspaceVersion = snap.version
        snapshotSeq = snap.snapshotSeq
        let wk: SymmetricKey
        do {
            wk = try crypto.unwrapWorkspaceKeyFromServer(envelope: snap.wrappedWorkspaceKey, wrappingKey: pdk)
        } catch let ce as CryptoError {
            if case .deviceKeyInviteNotSupportedOnIOS = ce { throw ce }
            throw ce
        }
        workspaceKey = wk

        wk.withUnsafeBytes { keychain.saveWorkspaceKey(Data($0)) }

        let (ws, ver, seq, evs) = try await sync.pull(key: wk)
        workspace = ws
        workspaceVersion = ver
        snapshotSeq = seq
        mergeVisitRuntimeFromServerEvents(evs)
        syncWidgetSnapshot()

        authState = .authenticated
        await scheduleNotifications()
    }

    // MARK: - Unlock (session still valid, WK not in memory)

    func unlock(password: String) async throws {
        isLoading = true
        defer { isLoading = false }
        defer { reconcileEventStream() }
        errorMessage = nil

        guard let salt = pdkSalt ?? keychain.loadPdkSalt() else {
            throw AppError.noSalt
        }

        let pdk = try await Task.detached(priority: .userInitiated) { [crypto, salt, password] in
            try crypto.derivePDK(password: password, saltBase64: salt)
        }.value

        do {
            _ = try await api.getAuthMeValidatingClientVersion()
        } catch {
            if case APIError.requiresAppUpdate(let min, let msg) = error {
                authState = .appUpdateRequired(serverMin: min, message: msg)
                return
            }
            throw error
        }

        let snap: ServerSnapshot = try await api.get(path: "/api/snapshot")
        if let wid = snap.workspaceId { APIService.activeWorkspaceId = wid }
        workspaceVersion = snap.version
        snapshotSeq = snap.snapshotSeq

        do {
            workspaceKey = try crypto.unwrapWorkspaceKeyFromServer(
                envelope: snap.wrappedWorkspaceKey,
                wrappingKey: pdk
            )
        } catch let ce as CryptoError {
            if case .deviceKeyInviteNotSupportedOnIOS = ce { throw ce }
            throw AppError.wrongPassword
        } catch {
            throw AppError.wrongPassword
        }

        workspaceKey!.withUnsafeBytes { keychain.saveWorkspaceKey(Data($0)) }

        if let wk = workspaceKey {
            let (ws, ver, seq, evs) = try await sync.pull(key: wk)
            workspaceVersion = ver
            snapshotSeq = seq
            workspace = ws
            mergeVisitRuntimeFromServerEvents(evs)
            syncWidgetSnapshot()
        }

        authState = .authenticated
        await scheduleNotifications()
    }

    // MARK: - Logout

    func logout() async {
        stopEventStream()
        EventOutboxStore.shared.clear()
        let _: EmptyResponse? = try? await api.post(path: "/api/auth/logout", body: Optional<String>.none)
        APIService.activeWorkspaceId = nil
        workspaceKey = nil
        workspace    = nil
        keychain.deleteAll()
        visitRuntimeStore.clear()
        clearWidgetSnapshot()
        notifications.clearAllReminders()
        authState = .unauthenticated
    }

    // MARK: - Workspace sync

    func refreshWorkspace() async {
        guard let wk = workspaceKey, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let (ws, version, seq, evs) = try await sync.pull(key: wk)
            workspaceVersion = version
            snapshotSeq = seq
            if let ws { workspace = ws }
            mergeVisitRuntimeFromServerEvents(evs)
            syncWidgetSnapshot()
            await scheduleNotifications()
            await drainOutboxIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pullWorkspace() async throws {
        guard let wk = workspaceKey else { return }
        let (ws, version, seq, evs) = try await sync.pull(key: wk)
        workspaceVersion = version
        snapshotSeq = seq
        if let ws { workspace = ws }
        mergeVisitRuntimeFromServerEvents(evs)
        syncWidgetSnapshot()
        await drainOutboxIfNeeded()
    }

    /// Replay `visit_*` events from the server log into `VisitRuntimeStore`, merge with local rows still pending upload.
    private func mergeVisitRuntimeFromServerEvents(_ decryptedEvents: [[String: Any]]) {
        let fromLog = VisitRuntimeReplayer.buildStates(from: decryptedEvents)
        var map = Dictionary(uniqueKeysWithValues: fromLog.map { ($0.visitKey, $0) })
        for local in visitRuntimeStore.allStates() {
            if map[local.visitKey] == nil {
                map[local.visitKey] = local
            }
        }
        visitRuntimeStore.replaceAll(with: map.values.sorted { $0.checkedInAt < $1.checkedInAt })
        visitRuntimeStore.prune(forSchedule: workspace?.lastSchedule)
        touchVisitRuntimeUI()
    }

    /// Retries any batches saved after a failed `POST /api/events` (offline / 5xx).
    func drainOutboxIfNeeded() async {
        do {
            try await EventOutboxStore.shared.drainAllBatches { events, _ in
                guard let wk = self.workspaceKey, let ws = self.workspace else { return }
                self.workspaceVersion = try await self.sync.pushEvents(
                    events: events,
                    key: wk,
                    workspace: ws,
                    expectedVersion: self.workspaceVersion
                )
            }
            syncWidgetSnapshot()
        } catch {
            // Leave remaining batches for the next foreground pull or user action.
        }
    }

    private func encodablePayload<T: Encodable>(_ v: T) throws -> Any {
        let data = try JSONEncoder().encode(v)
        return try JSONSerialization.jsonObject(with: data)
    }

    private func gpsObject(from loc: CLLocation?) -> [String: Any]? {
        guard let loc else { return nil }
        return [
            "lat": loc.coordinate.latitude,
            "lon": loc.coordinate.longitude,
            "accuracyM": loc.horizontalAccuracy,
            "capturedAt": iso8601.string(from: loc.timestamp),
        ]
    }

    private func newEvent(kind: String, payload: Any, gps: [String: Any]?) -> [String: Any] {
        var ev: [String: Any] = [
            "clientEventId": UUID().uuidString,
            "kind": kind,
            "claimedAt": iso8601.string(from: Date()),
            "payload": payload,
        ]
        if let gps { ev["gps"] = gps }
        return ev
    }

    private func persistEvents(_ events: [[String: Any]]) async throws {
        guard let wk = workspaceKey, let ws = workspace else {
            throw AppError.noWorkspaceKey
        }
        await drainOutboxIfNeeded()
        do {
            workspaceVersion = try await sync.pushEvents(
                events: events,
                key: wk,
                workspace: ws,
                expectedVersion: workspaceVersion
            )
            syncWidgetSnapshot()
        } catch {
            if Self.shouldRetryPersistInOutbox(error) {
                try EventOutboxStore.shared.enqueue(events: events, expectedVersion: workspaceVersion)
                return
            }
            throw error
        }
    }

    private static func shouldRetryPersistInOutbox(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost,
                 .cannotFindHost, .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed:
                return true
            default:
                return false
            }
        }
        if case APIError.httpError(let status, _) = error {
            if status == 401 || status == 410 || status == 422 { return false }
            return status >= 500
        }
        return false
    }

    private func reconcileEventStream() {
        if authState == .authenticated, workspaceKey != nil {
            startEventStream()
        } else {
            stopEventStream()
        }
    }

    private func startEventStream() {
        stopEventStream()
        let box = WeakAppStateBox(self)
        eventStreamTask = EventStreamRunner.start(
            isActive: {
                await MainActor.run { box.app?.isEventStreamEligible ?? false }
            },
            onRemoteSeq: { seq in
                await MainActor.run { box.app?.debounceStreamCatchUp(remoteSeq: seq) }
            }
        )
    }

    private func stopEventStream() {
        eventStreamTask?.cancel()
        eventStreamTask = nil
        eventStreamDebounceTask?.cancel()
        eventStreamDebounceTask = nil
    }

    private var isEventStreamEligible: Bool {
        authState == .authenticated && workspaceKey != nil
    }

    private func debounceStreamCatchUp(remoteSeq: Int) {
        eventStreamDebounceTask?.cancel()
        eventStreamDebounceTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            guard remoteSeq > snapshotSeq else { return }
            await refreshWorkspace()
            await drainOutboxIfNeeded()
        }
    }

    private func emitVisitStarted(for result: VisitCheckInResult) async throws {
        guard let gps = gpsObject(from: await arrivalVerifier.captureLocation()) else {
            throw AppError.locationRequired
        }
        let payload: [String: Any] = [
            "dayDate": result.dayDate,
            "visitIndex": result.visitIndex,
            "clientId": result.state.clientId,
            "verifiedArrival": result.state.verifiedArrival,
            "checkedInAt": iso8601.string(from: result.state.checkedInAt),
        ]
        let ev = newEvent(kind: "visit_started", payload: payload, gps: gps)
        try await persistEvents([ev])
    }

    private func emitVisitCompleted(
        dayDate: String,
        visitIndex: Int,
        clientId: String,
        completedAt: Date
    ) async throws {
        guard let gps = gpsObject(from: await arrivalVerifier.captureLocation()) else {
            throw AppError.locationRequired
        }
        let payload: [String: Any] = [
            "dayDate": dayDate,
            "visitIndex": visitIndex,
            "clientId": clientId,
            "completedAt": iso8601.string(from: completedAt),
        ]
        let ev = newEvent(kind: "visit_completed", payload: payload, gps: gps)
        try await persistEvents([ev])
    }

    // MARK: - Client mutations

    func saveClient(_ client: Client) async throws {
        guard let gps = gpsObject(from: await arrivalVerifier.captureLocation()) else {
            throw AppError.locationRequired
        }
        let isNew = !(workspace?.clients.contains(where: { $0.id == client.id }) ?? false)
        let kind = isNew ? "client_added" : "client_updated"
        let payload = try encodablePayload(client)
        let ev = newEvent(kind: kind, payload: payload, gps: gps)
        workspace = try EventReducer.apply(workspace ?? defaultWorkspace, event: ev)
        try await persistEvents([ev])
    }

    func deleteClient(id: String) async throws {
        guard let gps = gpsObject(from: await arrivalVerifier.captureLocation()) else {
            throw AppError.locationRequired
        }
        let ev = newEvent(kind: "client_removed", payload: ["id": id], gps: gps)
        workspace = try EventReducer.apply(workspace ?? defaultWorkspace, event: ev)
        try await persistEvents([ev])
    }

    // MARK: - Schedule editing

    func generateSchedule() async throws {
        guard var ws = workspace else { throw AppError.noWorkspace }

        let schedule = generateWeekSchedule(
            worker: ws.worker,
            allClients: ws.clients,
            travelTimes: ws.travelTimes,
            weekStartDate: currentMondayISODate()
        )

        ws.lastSchedule = schedule
        let ev = newEvent(kind: "schedule_set", payload: try encodablePayload(schedule), gps: nil)
        let next = try EventReducer.apply(ws, event: ev)
        workspace = next
        visitRuntimeStore.prune(forSchedule: next.lastSchedule)
        touchVisitRuntimeUI()
        try await persistEvents([ev])
        await scheduleNotifications()
    }

    func updateDaySchedule(_ updatedDay: DaySchedule) async throws {
        guard var ws = workspace, var sched = ws.lastSchedule else { return }

        if let idx = sched.days.firstIndex(where: {
            $0.day == updatedDay.day && $0.date == updatedDay.date
        }) {
            sched.days[idx] = updatedDay
        } else {
            sched.days.append(updatedDay)
        }

        // Recalculate week-level totals
        sched.totalTravelMinutes = sched.days.reduce(0) { $0 + $1.totalTravelMinutes }
        sched.totalTimeAwayMinutes = sched.days.reduce(0) { acc, d in
            let leave = timeToMinutes(d.leaveHomeTime)
            let arrive = timeToMinutes(d.arriveHomeTime)
            return acc + max(0, arrive - leave)
        }

        ws.lastSchedule = sched
        let ev = newEvent(kind: "schedule_set", payload: try encodablePayload(sched), gps: nil)
        let next = try EventReducer.apply(ws, event: ev)
        workspace = next
        visitRuntimeStore.prune(forSchedule: next.lastSchedule)
        touchVisitRuntimeUI()
        try await persistEvents([ev])
        await scheduleNotifications()
    }

    // MARK: - Worker profile

    func saveWorkerProfile(_ profile: WorkerProfile) async throws {
        let ws = workspace ?? defaultWorkspace
        let ev = newEvent(kind: "worker_updated", payload: try encodablePayload(profile), gps: nil)
        workspace = try EventReducer.apply(ws, event: ev)
        try await persistEvents([ev])
    }

    // MARK: - Notification helpers

    func scheduleNotifications() async {
        guard let ws = workspace, let schedule = ws.lastSchedule else { return }
        await notifications.scheduleForToday(schedule: schedule, clients: ws.clients)
    }

    func visitRuntimeState(dayDate: String, visitIndex: Int) -> VisitRuntimeState? {
        visitRuntimeStore.state(for: dayDate, visitIndex: visitIndex)
    }

    func checkInCurrentOrNextVisit(
        bypassLocationCheck: Bool = false,
        allowOutsideRadius: Bool = false
    ) async throws -> VisitCheckInResult {
        guard let ws = workspace, let day = todaysSchedule() else { throw AppError.noTodaySchedule }
        guard let result = try await checkInEngine.checkInCurrentOrNext(
            day: day,
            clients: ws.clients,
            bypassLocationCheck: bypassLocationCheck,
            allowOutsideRadius: allowOutsideRadius
        ) else {
            throw AppError.noCheckInTarget
        }

        if let client = ws.clients.first(where: { $0.id == result.state.clientId }) {
            await notifications.scheduleVisitDurationAlarm(
                clientName: client.name,
                dayDate: result.dayDate,
                visitIndex: result.visitIndex,
                checkInAt: result.state.checkedInAt,
                durationMinutes: max(client.visitDurationMinutes, 1)
            )
        }
        touchVisitRuntimeUI()
        syncWidgetSnapshot()
        WidgetCenter.shared.reloadAllTimelines()
        if result.isNewCheckIn {
            Task {
                do {
                    try await emitVisitStarted(for: result)
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
        return result
    }

    func checkInWidgetPrimaryAction() async {
        guard let day = todaysSchedule(),
              let targetIndex = checkInEngine.firstIncompleteVisitIndex(day: day) else { return }

        if let existing = visitRuntimeStore.state(for: day.date, visitIndex: targetIndex), !existing.isCompleted {
            completeVisit(dayDate: day.date, visitIndex: targetIndex)
            return
        }

        _ = try? await checkInVisit(
            dayDate: day.date,
            visitIndex: targetIndex,
            bypassLocationCheck: true,
            allowOutsideRadius: true
        )
    }

    func checkInVisit(
        dayDate: String,
        visitIndex: Int,
        bypassLocationCheck: Bool = false,
        allowOutsideRadius: Bool = false
    ) async throws -> VisitCheckInResult {
        guard let ws = workspace, let day = todaysSchedule(), day.date == dayDate else {
            throw AppError.noTodaySchedule
        }
        guard let result = try await checkInEngine.checkInVisit(
            at: visitIndex,
            day: day,
            clients: ws.clients,
            bypassLocationCheck: bypassLocationCheck,
            allowOutsideRadius: allowOutsideRadius
        ) else {
            throw AppError.cannotCheckInVisit
        }

        if let client = ws.clients.first(where: { $0.id == result.state.clientId }) {
            await notifications.scheduleVisitDurationAlarm(
                clientName: client.name,
                dayDate: result.dayDate,
                visitIndex: result.visitIndex,
                checkInAt: result.state.checkedInAt,
                durationMinutes: max(client.visitDurationMinutes, 1)
            )
        }
        touchVisitRuntimeUI()
        syncWidgetSnapshot()
        WidgetCenter.shared.reloadAllTimelines()
        if result.isNewCheckIn {
            Task {
                do {
                    try await emitVisitStarted(for: result)
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
        return result
    }

    func completeVisit(dayDate: String, visitIndex: Int) {
        let prior = visitRuntimeStore.state(for: dayDate, visitIndex: visitIndex)
        let wasIncomplete = prior.map { !$0.isCompleted } ?? false
        let clientId = prior?.clientId
        let completedAt = Date()

        checkInEngine.markVisitCompleted(dayDate: dayDate, visitIndex: visitIndex, at: completedAt)
        notifications.clearVisitDurationAlarm(dayDate: dayDate, visitIndex: visitIndex)
        touchVisitRuntimeUI()
        syncWidgetSnapshot()
        WidgetCenter.shared.reloadAllTimelines()

        if wasIncomplete, let clientId {
            Task {
                do {
                    try await emitVisitCompleted(
                        dayDate: dayDate,
                        visitIndex: visitIndex,
                        clientId: clientId,
                        completedAt: completedAt
                    )
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    func uncheckInVisit(dayDate: String, visitIndex: Int) {
        visitRuntimeStore.remove(dayDate: dayDate, visitIndex: visitIndex)
        notifications.clearVisitDurationAlarm(dayDate: dayDate, visitIndex: visitIndex)
        touchVisitRuntimeUI()
        syncWidgetSnapshot()
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Persists a clinical `visit_note_added` event (E2EE payload) and updates local runtime state.
    func addVisitNote(dayDate: String, visitIndex: Int, text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let st = visitRuntimeStore.state(for: dayDate, visitIndex: visitIndex) else { return }
        guard let gps = gpsObject(from: await arrivalVerifier.captureLocation()) else {
            throw AppError.locationRequired
        }
        let payload: [String: Any] = [
            "dayDate": dayDate,
            "visitIndex": visitIndex,
            "clientId": st.clientId,
            "note": trimmed,
        ]
        let ev = newEvent(kind: "visit_note_added", payload: payload, gps: gps)
        var next = st
        let merged = [st.visitNote, trimmed]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        next.visitNote = merged.isEmpty ? nil : merged
        visitRuntimeStore.upsert(next)
        try await persistEvents([ev])
        touchVisitRuntimeUI()
        syncWidgetSnapshot()
        WidgetCenter.shared.reloadAllTimelines()
    }

    func nextUnstartedVisitForToday() -> (client: Client, dayDate: String, visitIndex: Int)? {
        guard let ws = workspace, let day = todaysSchedule(),
              let next = checkInEngine.nextUnstartedVisit(day: day),
              let client = ws.clients.first(where: { $0.id == next.visit.clientId }) else { return nil }
        return (client, day.date, next.index)
    }

    private func todaysSchedule() -> DaySchedule? {
        guard let schedule = workspace?.lastSchedule else { return nil }
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        let todayStr = fmt.string(from: Date())
        return schedule.days.first { $0.date == todayStr }
    }

    private func syncWidgetSnapshot() {
        guard let ws = workspace, let day = todaysSchedule() else {
            clearWidgetSnapshot()
            return
        }
        let visits = day.visits.enumerated().map { idx, visit in
            WidgetWorkspaceSnapshot.WidgetVisit(
                dayDate: day.date,
                visitIndex: idx,
                clientId: visit.clientId,
                startTime: visit.startTime,
                endTime: visit.endTime
            )
        }
        let snapshot = WidgetWorkspaceSnapshot(
            clients: ws.clients.map { client in
                WidgetWorkspaceSnapshot.WidgetClient(
                    id: client.id,
                    name: client.name,
                    address: client.address,
                    visitDurationMinutes: client.visitDurationMinutes
                )
            },
            todaysVisits: visits,
            runtimeStates: visitRuntimeStore.allStates().filter { $0.dayDate == day.date },
            refreshedAt: Date()
        )
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        guard let data = try? enc.encode(snapshot) else { return }
        let defaults = UserDefaults(suiteName: SharedAppGroup.id) ?? .standard
        defaults.set(data, forKey: SharedStoreKeys.workspaceSnapshot)
    }

    private func clearWidgetSnapshot() {
        let defaults = UserDefaults(suiteName: SharedAppGroup.id) ?? .standard
        defaults.removeObject(forKey: SharedStoreKeys.workspaceSnapshot)
    }

    private func touchVisitRuntimeUI() {
        visitRuntimeRevision &+= 1
    }
}

// MARK: - SSE weak box (detached stream must not retain AppState strongly)

private final class WeakAppStateBox: @unchecked Sendable {
    weak var app: AppState?
    init(_ app: AppState) { self.app = app }
}
