import SwiftUI

// Weekly schedule view with an interactive per-day timeline.
// Workers can drag visits to new times, delete visits, and add new visits from here.

struct ScheduleView: View {
    @Environment(AppState.self) private var appState
    @Namespace private var dayPickerGlassNS
    @State private var selectedDay: DayOfWeek?
    @State private var saveError: String? = nil
    @State private var isSaving = false
    @State private var isGenerating = false

    private var schedule: WeekSchedule? { appState.workspace?.lastSchedule }
    private var clients: [Client] { appState.workspace?.clients ?? [] }
    private var worker: WorkerProfile? { appState.workspace?.worker }
    private var travelTimes: TravelTimeMatrix { appState.workspace?.travelTimes ?? [:] }
    private var isBusy: Bool { appState.isSyncing || isSaving || isGenerating }

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
                    if isBusy {
                        ProgressView().scaleEffect(0.8)
                    } else {
                        HStack {
                            Button {
                                generateSchedule()
                            } label: {
                                Label(
                                    schedule == nil ? "Generate Schedule" : "Regenerate Schedule",
                                    systemImage: "calendar.badge.plus"
                                )
                            }
                            Button { Task { await appState.refreshWorkspace() } } label: {
                                Image(systemName: "arrow.clockwise")
                            }
                        }
                    }
                }
            }
            .alert("Schedule update failed", isPresented: Binding(
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
                dayHeader(daySchedule, selectorDays: selectorDays)
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
            daySelectorBar(
                selectorDays: selectorDays,
                effectiveSelected: selectedDay ?? firstActiveDay(schedule, worker: worker)
            )
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

    @ViewBuilder
    private func daySelectorBar(selectorDays: [DaySchedule], effectiveSelected: DayOfWeek) -> some View {
        if #available(iOS 26.0, *) {
            GlassDaySelectorBar(
                days: selectorDays,
                selectedDay: effectiveSelected,
                namespace: dayPickerGlassNS
            ) { selectedDay = $0 }
        } else {
            HStack(spacing: 0) {
                ForEach(selectorDays) { day in
                    DayTab(
                        day: day,
                        isSelected: effectiveSelected == day.day,
                        hasVisits: !day.visits.isEmpty
                    ) {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            selectedDay = day.day
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemBackground))
        }
    }

    // MARK: - Day header

    private func dayHeader(_ day: DaySchedule, selectorDays: [DaySchedule]) -> some View {
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
            Menu {
                ForEach(selectorDays.filter { $0.day != day.day }) { targetDay in
                    Button("Copy to \(targetDay.day.fullLabel)") {
                        copy(day, to: targetDay)
                    }
                }
            } label: {
                Label("Copy Day", systemImage: "doc.on.doc")
                    .labelStyle(.iconOnly)
                    .font(.body)
                    .frame(width: 32, height: 32)
            }
            .disabled(day.visits.isEmpty || selectorDays.count < 2)
            .accessibilityLabel("Copy Day")
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

    private func generateSchedule() {
        isGenerating = true
        Task {
            do {
                try await appState.generateSchedule()
                if let schedule = appState.workspace?.lastSchedule {
                    selectedDay = firstActiveDay(schedule, worker: appState.workspace?.worker ?? defaultWorkspace.worker)
                }
            } catch {
                saveError = error.localizedDescription
            }
            isGenerating = false
        }
    }

    private func copy(_ sourceDay: DaySchedule, to targetDay: DaySchedule) {
        guard let worker else { return }
        guard let copiedDay = copyDaySchedule(
            from: sourceDay,
            to: targetDay,
            worker: worker,
            clients: clients,
            travelTimes: travelTimes
        ) else {
            saveError = "No visits on \(sourceDay.day.fullLabel) to copy."
            return
        }

        isSaving = true
        Task {
            do {
                try await appState.updateDaySchedule(copiedDay)
                selectedDay = targetDay.day
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
            Text("Generate an optimized schedule from your clients and travel times.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button {
                generateSchedule()
            } label: {
                if isGenerating {
                    ProgressView()
                } else {
                    Label("Generate Schedule", systemImage: "calendar.badge.plus")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isBusy || appState.workspace == nil)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    /// Days shown in the schedule tab strip: every worker working day for this week (not in `daysOff`).
    ///
    /// `lastSchedule.days` from the server only includes days that had visits when the schedule was built.
    /// If a day was a day off then, it has no row — when the worker later marks that day as working, we still
    /// need a tab and timeline, so missing working days get a placeholder `DaySchedule` until edits persist.
    private func scheduleDaysForSelector(_ schedule: WeekSchedule, worker: WorkerProfile) -> [DaySchedule] {
        let off = Set(worker.daysOff)
        let byDay = Dictionary(uniqueKeysWithValues: schedule.days.map { ($0.day, $0) })
        var out: [DaySchedule] = []
        for day in DayOfWeek.allCases {
            guard !off.contains(day) else { continue }
            if let existing = byDay[day] {
                out.append(existing)
            } else if let iso = isoDateInWeek(weekStart: schedule.weekStartDate, day: day) {
                out.append(
                    DaySchedule(
                        day: day,
                        date: iso,
                        visits: [],
                        totalTravelMinutes: 0,
                        leaveHomeTime: worker.workingHours.startTime,
                        arriveHomeTime: worker.workingHours.endTime
                    )
                )
            }
        }
        return out.isEmpty ? schedule.days : out
    }

    /// `weekStartDate` is Monday of the week (same as web `getMonday()` / `DAYS_OF_WEEK` indexing).
    private func isoDateInWeek(weekStart: String, day: DayOfWeek) -> String? {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(identifier: "UTC")
        guard let start = fmt.date(from: weekStart) else { return nil }
        guard let idx = DayOfWeek.allCases.firstIndex(of: day) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        guard let d = cal.date(byAdding: .day, value: idx, to: cal.startOfDay(for: start)) else { return nil }
        return fmt.string(from: d)
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

// MARK: - Liquid Glass day bar (iOS 26+)

@available(iOS 26.0, *)
private struct GlassDaySelectorBar: View {
    let days: [DaySchedule]
    var selectedDay: DayOfWeek
    var namespace: Namespace.ID
    var onSelect: (DayOfWeek) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(days) { day in
                let isSelected = selectedDay == day.day
                Button {
                    withAnimation(.smooth(duration: 0.35)) {
                        onSelect(day.day)
                    }
                } label: {
                    VStack(spacing: 2) {
                        Text(day.day.label)
                            .font(.caption.weight(.semibold))
                        Text("\(day.visits.count)")
                            .font(.caption2)
                            .foregroundStyle(day.visits.isEmpty ? .tertiary : .primary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 8)
                    .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        // Keep Liquid Glass only on the pill layer. Wrapping the labels in
        // `GlassEffectContainer` composites them with the material and blurs the text.
        .background(alignment: .leading) {
            GlassEffectContainer(spacing: 28) {
                GeometryReader { geo in
                    let count = max(CGFloat(days.count), 1)
                    let segmentWidth = geo.size.width / count
                    if let idx = days.firstIndex(where: { $0.day == selectedDay }) {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(.clear)
                            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .glassEffectID("scheduleDaySelection", in: namespace)
                            .frame(width: segmentWidth, height: geo.size.height)
                            .offset(x: segmentWidth * CGFloat(idx))
                    }
                }
            }
            .allowsHitTesting(false)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemBackground))
    }
}
