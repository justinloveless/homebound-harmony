import SwiftUI

// Weekly schedule view with an interactive per-day timeline.
// Workers can drag visits to new times, delete visits, and add new visits from here.

struct ScheduleView: View {
    @Environment(AppState.self) private var appState
    @State private var selectedDay: DayOfWeek?
    @State private var saveError: String? = nil
    @State private var isSaving = false

    private var schedule: WeekSchedule? { appState.workspace?.lastSchedule }
    private var clients: [Client] { appState.workspace?.clients ?? [] }
    private var worker: WorkerProfile? { appState.workspace?.worker }
    private var travelTimes: TravelTimeMatrix { appState.workspace?.travelTimes ?? [:] }

    var body: some View {
        NavigationStack {
            Group {
                if let schedule, let worker {
                    scheduleContent(schedule, worker: worker)
                } else {
                    emptyState
                }
            }
            .navigationTitle("Schedule")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    if appState.isSyncing || isSaving {
                        ProgressView().scaleEffect(0.8)
                    } else {
                        Button { Task { await appState.refreshWorkspace() } } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                }
            }
            .alert("Save failed", isPresented: Binding(
                get: { saveError != nil },
                set: { if !$0 { saveError = nil } }
            )) {
                Button("OK") { saveError = nil }
            } message: {
                if let msg = saveError { Text(msg) }
            }
        }
    }

    // MARK: - Schedule content

    private func scheduleContent(_ schedule: WeekSchedule, worker: WorkerProfile) -> some View {
        VStack(spacing: 0) {
            weekSummary(schedule)

            if let unmet = schedule.unmetVisits, !unmet.isEmpty {
                unmetBanner(unmet)
            }

            // Day selector tabs
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(schedule.days) { day in
                        DayTab(
                            day: day,
                            isSelected: selectedDay == day.day,
                            hasVisits: !day.visits.isEmpty
                        ) { selectedDay = day.day }
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .background(Color(.secondarySystemBackground))

            Divider()

            // Day timeline
            if let daySchedule = schedule.days.first(where: {
                $0.day == (selectedDay ?? firstActiveDay(schedule))
            }) {
                dayHeader(daySchedule)
                Divider()
                TimelineDayView(
                    day: daySchedule,
                    worker: worker,
                    clients: clients,
                    travelTimes: travelTimes
                ) { updatedDay in
                    save(updatedDay)
                }
            }
        }
        .onAppear {
            if selectedDay == nil { selectedDay = firstActiveDay(schedule) }
        }
    }

    // MARK: - Day header

    private func dayHeader(_ day: DaySchedule) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(formatDate(day.date))
                    .font(.subheadline.weight(.medium))
                HStack(spacing: 12) {
                    Label("Depart \(day.leaveHomeTime.formatted12h)", systemImage: "house.fill")
                    Label("Return \(day.arriveHomeTime.formatted12h)", systemImage: "house.fill")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Label("\(day.visits.count) visits", systemImage: "person.2")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    // MARK: - Save

    private func save(_ updatedDay: DaySchedule) {
        isSaving = true
        Task {
            do {
                try await appState.updateDaySchedule(updatedDay)
            } catch {
                saveError = error.localizedDescription
            }
            isSaving = false
        }
    }

    // MARK: - Week summary

    private func weekSummary(_ schedule: WeekSchedule) -> some View {
        let workDays = schedule.days.filter { !$0.visits.isEmpty }
        let totalVisits = schedule.days.reduce(0) { $0 + $1.visits.count }
        return HStack(spacing: 16) {
            summaryCell(value: "\(workDays.count)", label: "Work days")
            summaryCell(value: "\(totalVisits)", label: "Visits")
            summaryCell(value: formatMinutes(schedule.totalTravelMinutes), label: "Driving")
            summaryCell(value: formatMinutes(schedule.totalTimeAwayMinutes), label: "Away")
        }
        .padding()
        .background(Color(.systemBackground))
    }

    private func summaryCell(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.headline)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Unmet visits warning

    private func unmetBanner(_ unmet: [UnmetVisit]) -> some View {
        let names = unmet.compactMap { uv in
            appState.workspace?.clients.first { $0.id == uv.clientId }?.name
        }
        return Label(
            "Could not place all visits: \(names.joined(separator: ", "))",
            systemImage: "exclamationmark.triangle.fill"
        )
        .font(.caption)
        .foregroundStyle(.orange)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.1))
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "calendar.badge.exclamationmark")
                .font(.system(size: 52))
                .foregroundStyle(.tertiary)
            Text("No schedule yet")
                .font(.headline)
            Text("Generate a schedule in the web app, then come back here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private func firstActiveDay(_ schedule: WeekSchedule) -> DayOfWeek {
        schedule.days.first { !$0.visits.isEmpty }?.day ?? schedule.days.first?.day ?? .monday
    }

    private func formatMinutes(_ mins: Int) -> String {
        if mins < 60 { return "\(mins)m" }
        let h = mins / 60, m = mins % 60
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }

    private func formatDate(_ iso: String) -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        guard let d = fmt.date(from: iso) else { return iso }
        let out = DateFormatter()
        out.dateFormat = "EEEE, MMMM d"
        return out.string(from: d)
    }
}

// MARK: - Day tab button

struct DayTab: View {
    let day: DaySchedule
    let isSelected: Bool
    let hasVisits: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Text(day.day.label)
                    .font(.caption.weight(.semibold))
                Text("\(day.visits.count)")
                    .font(.caption2)
                    .foregroundStyle(hasVisits ? .primary : .tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(isSelected ? Color.blue : Color.clear)
            .foregroundStyle(isSelected ? .white : (hasVisits ? .primary : .secondary))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
}
