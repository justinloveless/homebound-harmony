import Foundation
import CoreLocation
import Observation
import WidgetKit

// MARK: - Auth state machine

enum AuthState: Equatable {
    case checking
    case unauthenticated
    case authenticated
    case appUpdateRequired(serverMin: String, message: String?)
}

// MARK: - App-level errors

enum AppError: LocalizedError {
    case noTenant
    case noWorkspace
    case noTodaySchedule
    case noCheckInTarget
    case cannotCheckInVisit
    case locationRequired

    var errorDescription: String? {
        switch self {
        case .noTenant: return "No workspace tenant for this account. Complete setup on the web."
        case .noWorkspace: return "No workspace data found."
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

    // Workspace
    var workspace: Workspace?
    var workspaceVersion: Int = 1
    /// Last applied domain_events `seq` from the server (SSE + pull).
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
    let notifications = NotificationService()
    let visitRuntimeStore = VisitRuntimeStore()
    private var checkInEngine: VisitCheckInEngine { VisitCheckInEngine(store: visitRuntimeStore) }

    private let keychain = KeychainService()
    private var sync: SyncService { SyncService(api: api) }
    private var evvService: EvvService { EvvService(api: api) }

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

    // MARK: - Tenant selection

    private func resolveActiveTenant(for memberships: [TenantMembership]) {
        if let saved = APIService.activeTenantId,
           memberships.contains(where: { $0.id == saved }) {
            return
        }
        APIService.activeTenantId = memberships[0].id
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
            keychain.saveUserEmail(me.email)
            keychain.deleteLegacyCryptoItems()

            guard !me.tenants.isEmpty else {
                authState = .unauthenticated
                errorMessage = AppError.noTenant.localizedDescription
                return
            }
            resolveActiveTenant(for: me.tenants)

            try await pullWorkspace()
            workspaceVersion = workspace?.version ?? 1
            authState = .authenticated
            await scheduleNotifications()
        } catch APIError.httpError(401, _) {
            APIService.activeTenantId = nil
            keychain.deleteLegacyCryptoItems()
            authState = .unauthenticated
        } catch {
            if case APIError.requiresAppUpdate(let min, let msg) = error {
                authState = .appUpdateRequired(serverMin: min, message: msg)
                return
            }
            if let se = error as? SyncError, se == .noWorkerProfile {
                workspace = nil
                snapshotSeq = 0
                authState = .authenticated
                errorMessage = se.localizedDescription
                clearWidgetSnapshot()
                return
            }
            errorMessage = error.localizedDescription
            authState = .unauthenticated
        }
    }

    // MARK: - Login (email + password, optional TOTP)

    func login(email: String, password: String, totpCode: String?) async throws {
        isLoading = true
        defer { isLoading = false }
        defer { reconcileEventStream() }
        errorMessage = nil

        let _: EmptyResponse = try await api.post(
            path: "/api/auth/login",
            body: LoginRequest(email: email, password: password, code: totpCode)
        )

        userEmail = email.lowercased()
        keychain.saveUserEmail(userEmail!)
        keychain.deleteLegacyCryptoItems()

        let me: MeResponse
        do {
            me = try await api.getAuthMeValidatingClientVersion()
        } catch {
            if case APIError.requiresAppUpdate(let min, let msg) = error {
                authState = .appUpdateRequired(serverMin: min, message: msg)
                return
            }
            throw error
        }

        guard !me.tenants.isEmpty else {
            throw AppError.noTenant
        }
        resolveActiveTenant(for: me.tenants)

        try await pullWorkspace()
        workspaceVersion = workspace?.version ?? 1

        authState = .authenticated
        await scheduleNotifications()
    }

    // MARK: - Logout

    func logout() async {
        stopEventStream()
        EventOutboxStore.shared.clear()
        EvvOutboxStore.shared.clear()
        let _: EmptyResponse? = try? await api.post(path: "/api/auth/logout", body: Optional<String>.none)
        APIService.activeTenantId = nil
        workspace = nil
        keychain.deleteAll()
        visitRuntimeStore.clear()
        clearWidgetSnapshot()
        notifications.clearAllReminders()
        authState = .unauthenticated
    }

    // MARK: - Workspace sync

    func refreshWorkspace() async {
        guard authState == .authenticated, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            try await pullWorkspace()
            workspaceVersion = workspace?.version ?? 1
            await scheduleNotifications()
            await drainOutboxIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pullWorkspace() async throws {
        let (ws, seq, evs) = try await sync.pullFullSync()
        workspace = ws
        snapshotSeq = seq
        mergeVisitRuntimeFromServerEvents(evs)
        await recoverActiveEvvVisit()
        syncWidgetSnapshot()
        await drainOutboxIfNeeded()
    }

    private func recoverActiveEvvVisit() async {
        guard let day = todaysSchedule() else { return }
        do {
            let resp = try await evvService.getActiveVisit()
            guard let active = resp.visit else { return }
            if visitRuntimeStore.allStates().contains(where: { $0.evvVisitId == active.id }) { return }
            if let idx = day.visits.firstIndex(where: { $0.clientId == active.clientId }) {
                let key = VisitKey.make(dayDate: day.date, visitIndex: idx)
                let state = VisitRuntimeState(
                    visitKey: key,
                    dayDate: day.date,
                    visitIndex: idx,
                    clientId: active.clientId,
                    checkedInAt: ISO8601DateFormatter().date(from: active.checkInAt) ?? Date(),
                    verifiedArrival: true,
                    completedAt: nil,
                    evvVisitId: active.id
                )
                visitRuntimeStore.upsert(state)
                touchVisitRuntimeUI()
            }
        } catch { /* non-fatal */ }
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

    /// Retries any batches saved after a failed `POST /api/events` or EVV API calls (offline / 5xx).
    func drainOutboxIfNeeded() async {
        do {
            try await EventOutboxStore.shared.drainAllBatches { events in
                try await self.sync.pushEvents(events: events)
            }
            syncWidgetSnapshot()
        } catch {
            // Leave remaining batches for the next foreground pull or user action.
        }
        do {
            try await EvvOutboxStore.shared.drainAll(using: evvService, runtimeStore: visitRuntimeStore)
            touchVisitRuntimeUI()
        } catch {
            // Leave remaining entries for the next attempt.
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
        guard workspace != nil else {
            throw AppError.noWorkspace
        }
        await drainOutboxIfNeeded()
        do {
            try await sync.pushEvents(events: events)
            syncWidgetSnapshot()
        } catch {
            if Self.shouldRetryPersistInOutbox(error) {
                try EventOutboxStore.shared.enqueue(events: events)
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
        if authState == .authenticated {
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
        authState == .authenticated
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

    private func evvCheckIn(for result: VisitCheckInResult) async {
        guard let loc = await arrivalVerifier.captureLocation() else { return }
        let gps = EvvGpsPayload(from: loc)
        let req = EvvCheckInRequest(
            clientId: result.state.clientId,
            gps: gps,
            verificationMethod: "gps",
            dayDate: result.dayDate,
            visitIndex: result.visitIndex
        )
        let visitKey = VisitKey.make(dayDate: result.dayDate, visitIndex: result.visitIndex)
        do {
            let resp = try await evvService.checkIn(req)
            var updated = result.state
            updated.evvVisitId = resp.id
            visitRuntimeStore.upsert(updated)
            touchVisitRuntimeUI()
        } catch {
            if Self.shouldRetryPersistInOutbox(error) {
                try? EvvOutboxStore.shared.enqueue(.checkIn(visitKey: visitKey, request: req))
            }
        }
    }

    private func evvCheckOut(dayDate: String, visitIndex: Int) async {
        guard let loc = await arrivalVerifier.captureLocation() else { return }
        let gps = EvvGpsPayload(from: loc)
        let req = EvvCheckOutRequest(gps: gps, dayDate: dayDate, visitIndex: visitIndex)
        let visitKey = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)

        if let evvVisitId = visitRuntimeStore.state(for: dayDate, visitIndex: visitIndex)?.evvVisitId {
            do {
                _ = try await evvService.checkOut(visitId: evvVisitId, req: req)
            } catch {
                if Self.shouldRetryPersistInOutbox(error) {
                    try? EvvOutboxStore.shared.enqueue(.checkOut(visitKey: visitKey, request: req))
                }
            }
        } else {
            try? EvvOutboxStore.shared.enqueue(.checkOut(visitKey: visitKey, request: req))
        }
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
            Task { await evvCheckIn(for: result) }
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
            Task { await evvCheckIn(for: result) }
        }
        return result
    }

    func completeVisit(dayDate: String, visitIndex: Int) {
        let prior = visitRuntimeStore.state(for: dayDate, visitIndex: visitIndex)
        let wasIncomplete = prior.map { !$0.isCompleted } ?? false
        let completedAt = Date()

        checkInEngine.markVisitCompleted(dayDate: dayDate, visitIndex: visitIndex, at: completedAt)
        notifications.clearVisitDurationAlarm(dayDate: dayDate, visitIndex: visitIndex)
        touchVisitRuntimeUI()
        syncWidgetSnapshot()
        WidgetCenter.shared.reloadAllTimelines()

        if wasIncomplete {
            Task { await evvCheckOut(dayDate: dayDate, visitIndex: visitIndex) }
        }
    }

    func uncheckInVisit(dayDate: String, visitIndex: Int) {
        visitRuntimeStore.remove(dayDate: dayDate, visitIndex: visitIndex)
        notifications.clearVisitDurationAlarm(dayDate: dayDate, visitIndex: visitIndex)
        touchVisitRuntimeUI()
        syncWidgetSnapshot()
        WidgetCenter.shared.reloadAllTimelines()
    }

    func upsertVisitNote(dayDate: String, visitIndex: Int, tasks: [TaskItem], freeText: String) async throws {
        guard let st = visitRuntimeStore.state(for: dayDate, visitIndex: visitIndex),
              let evvVisitId = st.evvVisitId else { return }
        let req = EvvUpsertNoteRequest(tasksCompleted: tasks, freeText: freeText)
        let visitKey = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)
        do {
            let note = try await evvService.upsertNote(visitId: evvVisitId, req: req)
            var updated = st
            updated.evvNoteId = note.id
            updated.evvNoteStatus = "draft"
            visitRuntimeStore.upsert(updated)
            touchVisitRuntimeUI()
        } catch {
            if Self.shouldRetryPersistInOutbox(error) {
                try? EvvOutboxStore.shared.enqueue(.upsertNote(visitKey: visitKey, request: req))
            } else {
                throw error
            }
        }
    }

    func signVisitNote(dayDate: String, visitIndex: Int, signature: String) async throws {
        guard let st = visitRuntimeStore.state(for: dayDate, visitIndex: visitIndex),
              let evvVisitId = st.evvVisitId else { return }
        let loc = await arrivalVerifier.captureLocation()
        let gps = loc.map { EvvGpsPayload(from: $0) }
        let req = EvvSignNoteRequest(signature: signature, gps: gps)
        let visitKey = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)
        do {
            _ = try await evvService.signNote(visitId: evvVisitId, noteId: st.evvNoteId ?? "", req: req)
            var updated = st
            updated.evvNoteStatus = "signed"
            visitRuntimeStore.upsert(updated)
            touchVisitRuntimeUI()
        } catch {
            if Self.shouldRetryPersistInOutbox(error) {
                try? EvvOutboxStore.shared.enqueue(.signNote(visitKey: visitKey, noteId: st.evvNoteId, request: req))
            } else {
                throw error
            }
        }
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
