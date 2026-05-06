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
        let selectorDays = scheduleDaysForSelector(schedule, worker: worker)
        return VStack(spacing: 0) {
            if let unmet = schedule.unmetVisits, !unmet.isEmpty {
                unmetBanner(unmet)
            }

            // Day timeline
            if let daySchedule = selectorDays.first(where: {
                $0.day == (selectedDay ?? firstActiveDay(schedule, worker: worker))
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
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            Divider()

            // Day selector: only working days; equal width across the bar
            HStack(spacing: 0) {
                ForEach(selectorDays) { day in
                    DayTab(
                        day: day,
                        isSelected: selectedDay == day.day,
                        hasVisits: !day.visits.isEmpty
                    ) { selectedDay = day.day }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemBackground))
        }
        .onAppear {
            if selectedDay == nil { selectedDay = firstActiveDay(schedule, worker: worker) }
            clampSelectedDay(schedule, worker: worker, visibleDays: selectorDays)
        }
        .onChange(of: worker.daysOff) { _, _ in
            clampSelectedDay(schedule, worker: worker, visibleDays: scheduleDaysForSelector(schedule, worker: worker))
        }
        .onChange(of: schedule.weekStartDate) { _, _ in
            clampSelectedDay(schedule, worker: worker, visibleDays: scheduleDaysForSelector(schedule, worker: worker))
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

    /// Days shown in the schedule tab strip: worker working days only (not in `daysOff`).
    /// Falls back to all `schedule.days` if that would hide every day (misconfigured profile).
    private func scheduleDaysForSelector(_ schedule: WeekSchedule, worker: WorkerProfile) -> [DaySchedule] {
        let off = Set(worker.daysOff)
        let filtered = schedule.days.filter { !off.contains($0.day) }
        return filtered.isEmpty ? schedule.days : filtered
    }

    private func firstActiveDay(_ schedule: WeekSchedule, worker: WorkerProfile) -> DayOfWeek {
        let days = scheduleDaysForSelector(schedule, worker: worker)
        return days.first { !$0.visits.isEmpty }?.day ?? days.first?.day ?? .monday
    }

    private func clampSelectedDay(_ schedule: WeekSchedule, worker: WorkerProfile, visibleDays: [DaySchedule]) {
        let visible = Set(visibleDays.map(\.day))
        if let s = selectedDay, !visible.contains(s) {
            selectedDay = firstActiveDay(schedule, worker: worker)
        }
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
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
            .background(isSelected ? Color.blue : Color.clear)
            .foregroundStyle(isSelected ? .white : (hasVisits ? .primary : .secondary))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
}
