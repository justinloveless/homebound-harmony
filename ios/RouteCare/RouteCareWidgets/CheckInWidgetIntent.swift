import AppIntents
import Foundation
import WidgetKit
import UserNotifications

private enum CheckInIntentKeys {
    static let appGroupID = "group.com.lovelesslabs.RouteCare"
    static let runtimeState = "visitRuntimeState.v1"
    static let workspaceSnapshot = "widgetWorkspaceSnapshot.v1"
}

private struct RuntimeStateSnapshot: Codable {
    var states: [RuntimeVisitState]
}

private struct RuntimeVisitState: Codable {
    var visitKey: String
    var dayDate: String
    var visitIndex: Int
    var clientId: String
    var checkedInAt: Date
    var verifiedArrival: Bool
    var completedAt: Date?
}

struct ToggleCheckInIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Visit Check In"
    static var description = IntentDescription("Check in or complete the current/next visit without opening the app.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        let defaults = UserDefaults(suiteName: CheckInIntentKeys.appGroupID) ?? .standard
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601

        guard let workspaceData = defaults.data(forKey: CheckInIntentKeys.workspaceSnapshot),
              var workspace = try? decoder.decode(WidgetWorkspaceSnapshot.self, from: workspaceData),
              !workspace.todaysVisits.isEmpty,
              let target = WidgetCheckInVisitResolver.firstIncompleteVisit(in: workspace, defaults: defaults) else {
            return .result()
        }

        let runtimeData = defaults.data(forKey: CheckInIntentKeys.runtimeState)
        var runtime = (runtimeData.flatMap { try? decoder.decode(RuntimeStateSnapshot.self, from: $0) }) ?? RuntimeStateSnapshot(states: [])

        let key = "\(target.dayDate)#\(target.visitIndex)"
        if let idx = runtime.states.firstIndex(where: { $0.visitKey == key }),
           runtime.states[idx].completedAt == nil {
            // Complete existing check-in.
            let completedAt = Date()
            runtime.states[idx].completedAt = completedAt
            let completedRow = WidgetVisitRuntimeStateSnapshot(
                dayDate: target.dayDate,
                visitIndex: target.visitIndex,
                completedAt: completedAt
            )
            if let rsIdx = workspace.runtimeStates.firstIndex(where: {
                $0.dayDate == target.dayDate && $0.visitIndex == target.visitIndex
            }) {
                workspace.runtimeStates[rsIdx] = completedRow
            } else {
                workspace.runtimeStates.append(completedRow)
            }
            clearVisitDurationAlarm(dayDate: target.dayDate, visitIndex: target.visitIndex)
        } else {
            // Check in this visit.
            let state = RuntimeVisitState(
                visitKey: key,
                dayDate: target.dayDate,
                visitIndex: target.visitIndex,
                clientId: target.clientId,
                checkedInAt: Date(),
                verifiedArrival: false,
                completedAt: nil
            )
            runtime.states.removeAll { $0.visitKey == key }
            runtime.states.append(state)

            workspace.runtimeStates.removeAll { $0.dayDate == target.dayDate && $0.visitIndex == target.visitIndex }
            workspace.runtimeStates.append(
                WidgetVisitRuntimeStateSnapshot(dayDate: target.dayDate, visitIndex: target.visitIndex, completedAt: nil)
            )

            if let client = workspace.clients.first(where: { $0.id == target.clientId }) {
                await scheduleVisitDurationAlarm(
                    clientName: client.name,
                    dayDate: target.dayDate,
                    visitIndex: target.visitIndex,
                    checkInAt: Date(),
                    durationMinutes: max(client.visitDurationMinutes ?? 1, 1)
                )
            }
        }

        workspace.refreshedAt = Date()
        if let runtimeEncoded = try? encoder.encode(runtime) {
            defaults.set(runtimeEncoded, forKey: CheckInIntentKeys.runtimeState)
        }
        if let workspaceEncoded = try? encoder.encode(workspace) {
            defaults.set(workspaceEncoded, forKey: CheckInIntentKeys.workspaceSnapshot)
        }

        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }

    private func clearVisitDurationAlarm(dayDate: String, visitIndex: Int) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(
            withIdentifiers: ["hh-visit-alarm-\(dayDate)-\(visitIndex)"]
        )
    }

    private func scheduleVisitDurationAlarm(
        clientName: String,
        dayDate: String,
        visitIndex: Int,
        checkInAt: Date,
        durationMinutes: Int
    ) async {
        let fireAt = checkInAt.addingTimeInterval(TimeInterval(durationMinutes * 60))
        guard fireAt > Date() else { return }

        let content = UNMutableNotificationContent()
        content.title = "Visit time reached"
        content.body = "\(clientName): planned duration is complete."
        content.sound = .default
        if #available(iOS 15.0, *) {
            content.interruptionLevel = .timeSensitive
        }

        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: fireAt)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        let request = UNNotificationRequest(
            identifier: "hh-visit-alarm-\(dayDate)-\(visitIndex)",
            content: content,
            trigger: trigger
        )
        try? await UNUserNotificationCenter.current().add(request)
    }
}
