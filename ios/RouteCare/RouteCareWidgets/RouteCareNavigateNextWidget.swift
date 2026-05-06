import SwiftUI
import WidgetKit

struct RouteCareNavigateEntry: TimelineEntry {
    let date: Date
    let title: String
    let subtitle: String
}

struct RouteCareNavigateProvider: TimelineProvider {
    func placeholder(in context: Context) -> RouteCareNavigateEntry {
        RouteCareNavigateEntry(date: Date(), title: "Next Client", subtitle: "Open navigation")
    }

    func getSnapshot(in context: Context, completion: @escaping (RouteCareNavigateEntry) -> Void) {
        completion(entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RouteCareNavigateEntry>) -> Void) {
        let refresh = Calendar.current.date(byAdding: .minute, value: 5, to: Date()) ?? Date().addingTimeInterval(300)
        completion(Timeline(entries: [entry()], policy: .after(refresh)))
    }

    private func entry() -> RouteCareNavigateEntry {
        guard let snapshot = WidgetSharedSnapshotReader.load(),
              let next = snapshot.todaysVisits.first(where: { visit in
                  !snapshot.runtimeStates.contains(where: { $0.dayDate == visit.dayDate && $0.visitIndex == visit.visitIndex })
              }),
              let client = snapshot.clients.first(where: { $0.id == next.clientId }) else {
            return RouteCareNavigateEntry(date: Date(), title: "Next Client", subtitle: "No unstarted visits")
        }

        return RouteCareNavigateEntry(
            date: Date(),
            title: client.name,
            subtitle: "Tap to start directions"
        )
    }
}

struct RouteCareNavigateNextWidget: Widget {
    let kind = "RouteCareNavigateNextWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: RouteCareNavigateProvider()) { entry in
            VStack(alignment: .leading, spacing: 6) {
                Label("Navigate Next", systemImage: "car.fill")
                    .font(.headline)
                Text(entry.title)
                    .font(.caption)
                Text(entry.subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .widgetURL(URL(string: "routecare://navigate-next"))
            .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Navigate to Next Client")
        .description("Open driving directions for the next unstarted visit.")
        .supportedFamilies([.systemSmall])
    }
}
