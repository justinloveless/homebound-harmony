import Foundation
import UserNotifications

// Schedules local "time to leave" notifications for today's client visits.
// Call scheduleForToday() each morning (or when the schedule changes).

final class NotificationService {

    // Minutes before computed departure to fire the notification.
    var reminderLeadMinutes: Int {
        UserDefaults.standard.integer(forKey: "reminderLeadMinutes").nonZero ?? 5
    }

    // MARK: - Permission

    func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            return try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            return false
        }
    }

    // MARK: - Schedule reminders for today

    func scheduleForToday(schedule: WeekSchedule, clients: [Client]) async {
        let center = UNUserNotificationCenter.current()
        // Remove old reminders before adding new ones.
        center.removePendingNotificationRequests(withIdentifiers: pendingIdentifiers(for: schedule))

        guard let today = todaySchedule(in: schedule) else { return }
        let clientMap = Dictionary(uniqueKeysWithValues: clients.map { ($0.id, $0) })

        for (idx, visit) in today.visits.enumerated() {
            guard let client = clientMap[visit.clientId] else { continue }

            // Departure time = visit start − travel time from previous location.
            guard let startDate = visit.startTime.asTimeOn(isoDate: today.date) else { continue }
            let travelMinutes = max(0, visit.travelTimeFromPrev)
            let departureDate = startDate.addingTimeInterval(TimeInterval(-travelMinutes * 60))
            let notifyDate    = departureDate.addingTimeInterval(TimeInterval(-reminderLeadMinutes * 60))

            guard notifyDate > Date() else { continue }

            let content = UNMutableNotificationContent()
            content.title = "Time to leave for \(client.name)"

            if travelMinutes > 0 {
                content.body  = "\(travelMinutes) min drive · depart by \(visit.startTime.formatted12h)"
            } else {
                content.body  = "Visit starts at \(visit.startTime.formatted12h)"
            }
            content.sound = .default

            let comps     = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: notifyDate)
            let trigger   = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            let id        = notificationID(scheduleDate: today.date, visitIndex: idx)
            let request   = UNNotificationRequest(identifier: id, content: content, trigger: trigger)

            try? await center.add(request)
        }
    }

    // MARK: - Clear

    func clearAllReminders() {
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
    }

    // MARK: - Helpers

    private func todaySchedule(in schedule: WeekSchedule) -> DaySchedule? {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        let todayStr = fmt.string(from: Date())
        return schedule.days.first { $0.date == todayStr }
    }

    private func notificationID(scheduleDate: String, visitIndex: Int) -> String {
        "hh-reminder-\(scheduleDate)-\(visitIndex)"
    }

    private func pendingIdentifiers(for schedule: WeekSchedule) -> [String] {
        schedule.days.flatMap { day in
            day.visits.indices.map { notificationID(scheduleDate: day.date, visitIndex: $0) }
        }
    }
}

// MARK: - Helpers

private extension Int {
    var nonZero: Int? { self == 0 ? nil : self }
}

extension String {
    /// Convert "HH:MM" 24h to "H:MM AM/PM".
    var formatted12h: String {
        let parts = split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return self }
        let h = parts[0], m = parts[1]
        let ampm = h < 12 ? "AM" : "PM"
        let h12  = h == 0 ? 12 : (h > 12 ? h - 12 : h)
        return String(format: "%d:%02d %@", h12, m, ampm)
    }
}
