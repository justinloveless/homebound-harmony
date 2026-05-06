import SwiftUI
import WidgetKit

struct RouteCareCheckInEntry: TimelineEntry {
    let date: Date
    let actionTitle: String
    let actionIcon: String
    let title: String
    let subtitle: String
}

struct RouteCareCheckInProvider: TimelineProvider {
    func placeholder(in context: Context) -> RouteCareCheckInEntry {
        RouteCareCheckInEntry(
            date: Date(),
            actionTitle: "Check In",
            actionIcon: "checkmark.circle.fill",
            title: "Jane Doe",
            subtitle: "Tap to check in at 9:30 AM"
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (RouteCareCheckInEntry) -> Void) {
        completion(entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RouteCareCheckInEntry>) -> Void) {
        let refresh = Calendar.current.date(byAdding: .minute, value: 5, to: Date()) ?? Date().addingTimeInterval(300)
        completion(Timeline(entries: [entry()], policy: .after(refresh)))
    }

    private func entry() -> RouteCareCheckInEntry {
        guard let snapshot = WidgetSharedSnapshotReader.load(), !snapshot.todaysVisits.isEmpty else {
            return RouteCareCheckInEntry(
                date: Date(),
                actionTitle: "Check In",
                actionIcon: "checkmark.circle.fill",
                title: "No visits today",
                subtitle: "Nothing to check in"
            )
        }
        let defaults = WidgetSharedSnapshotReader.appGroupDefaults()
        let mergedRuntime = WidgetCheckInVisitResolver.mergedRuntimeStates(snapshot: snapshot, defaults: defaults)
        let now = Date()
        guard let target = WidgetCheckInVisitResolver.firstIncompleteVisit(in: snapshot, defaults: defaults),
              let client = snapshot.clients.first(where: { $0.id == target.clientId }) else {
            return RouteCareCheckInEntry(
                date: now,
                actionTitle: "Check In",
                actionIcon: "checkmark.circle.fill",
                title: "All set",
                subtitle: "No more visits to check in"
            )
        }

        let canComplete = WidgetCheckInVisitResolver.hasOpenCheckIn(target, runtimeStates: mergedRuntime)
        let actionTitle = canComplete ? "Complete Visit" : "Check In"
        let actionIcon = canComplete ? "checkmark.seal.fill" : "checkmark.circle.fill"
        let subtitle: String
        if canComplete {
            subtitle = "Tap to complete \(client.name)"
        } else if let start = dateFor(dayDate: target.dayDate, hhmm: target.startTime), now < start {
            subtitle = "Tap to check in early · starts \(target.startTime.formatted12h)"
        } else {
            subtitle = "Tap to check in at \(target.startTime.formatted12h)"
        }

        return RouteCareCheckInEntry(
            date: now,
            actionTitle: actionTitle,
            actionIcon: actionIcon,
            title: client.name,
            subtitle: subtitle
        )
    }

    private func dateFor(dayDate: String, hhmm: String) -> Date? {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd HH:mm"
        return fmt.date(from: "\(dayDate) \(hhmm)")
    }
}

struct RouteCareCheckInWidget: Widget {
    let kind = "RouteCareCheckInWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: RouteCareCheckInProvider()) { entry in
            VStack(alignment: .leading, spacing: 6) {
                Label(entry.actionTitle, systemImage: entry.actionIcon)
                    .font(.headline)
                Text(entry.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text(entry.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Button(intent: ToggleCheckInIntent()) {
                    Text(entry.actionTitle)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(.quaternarySystemFill))
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Check In / Complete Visit")
        .description("Check in or complete the current or next visit.")
        .supportedFamilies([.systemSmall])
    }
}

private extension String {
    var formatted12h: String {
        let parts = split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return self }
        let h = parts[0], m = parts[1]
        let ampm = h < 12 ? "AM" : "PM"
        let h12 = h == 0 ? 12 : (h > 12 ? h - 12 : h)
        return String(format: "%d:%02d %@", h12, m, ampm)
    }
}
