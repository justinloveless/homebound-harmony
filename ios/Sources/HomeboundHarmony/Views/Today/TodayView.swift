import Combine
import SwiftUI

// The worker's primary daily view: today's visit list in chronological order,
// departure countdowns, and one-tap navigation to each client's address.

struct TodayView: View {
    @Environment(AppState.self) private var appState
    @State private var now = Date()

    private let timer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    // Today's day schedule from the last generated schedule.
    private var todaySchedule: DaySchedule? {
        guard let schedule = appState.workspace?.lastSchedule else { return nil }
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        let todayStr = fmt.string(from: Date())
        return schedule.days.first { $0.date == todayStr }
    }

    private var clients: [String: Client] {
        let list = appState.workspace?.clients ?? []
        return Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
    }

    var body: some View {
        NavigationStack {
            Group {
                if appState.workspace == nil {
                    emptyState("No schedule data.\nGenerate a schedule in the web app first.")
                } else if let day = todaySchedule {
                    if day.visits.isEmpty {
                        emptyState("No visits scheduled today.")
                    } else {
                        dayView(day: day)
                    }
                } else {
                    emptyState("No visits scheduled for today.")
                }
            }
            .navigationTitle(todayTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    if appState.isSyncing {
                        ProgressView().scaleEffect(0.8)
                    } else {
                        Button {
                            Task { await appState.refreshWorkspace() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                }
            }
        }
        .onReceive(timer) { now = $0 }
    }

    // MARK: - Day view

    private func dayView(day: DaySchedule) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                // Day summary banner
                summaryBanner(day: day)

                // Visit cards
                LazyVStack(spacing: 12) {
                    ForEach(Array(day.visits.enumerated()), id: \.offset) { idx, visit in
                        if let client = clients[visit.clientId] {
                            VisitCard(
                                visit: visit,
                                client: client,
                                isFirst: idx == 0,
                                now: now,
                                dayDate: day.date,
                                visitIndex: idx
                            )
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
        }
        .refreshable { await appState.refreshWorkspace() }
    }

    // MARK: - Summary banner

    private func summaryBanner(day: DaySchedule) -> some View {
        VStack(spacing: 4) {
            HStack(spacing: 24) {
                statPill(
                    icon: "figure.walk",
                    value: "\(day.visits.count)",
                    label: "visits"
                )
                statPill(
                    icon: "car.fill",
                    value: formatMinutes(day.totalTravelMinutes),
                    label: "driving"
                )
                statPill(
                    icon: "clock.fill",
                    value: day.leaveHomeTime.formatted12h,
                    label: "depart"
                )
                statPill(
                    icon: "house.fill",
                    value: day.arriveHomeTime.formatted12h,
                    label: "home"
                )
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .padding(.bottom, 12)
    }

    private func statPill(icon: String, value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.blue)
            Text(value)
                .font(.callout.bold())
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Empty state

    private func emptyState(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "calendar.badge.clock")
                .font(.system(size: 52))
                .foregroundStyle(.tertiary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private var todayTitle: String {
        let fmt = DateFormatter()
        fmt.dateFormat = "EEEE, MMM d"
        return fmt.string(from: Date())
    }

    private func formatMinutes(_ mins: Int) -> String {
        if mins < 60 { return "\(mins)m" }
        let h = mins / 60, m = mins % 60
        return m == 0 ? "\(h)h" : "\(h)h\(m)m"
    }
}

// MARK: - Visit card

struct VisitCard: View {
    @Environment(AppState.self) private var appState
    let visit: ScheduledVisit
    let client: Client
    let isFirst: Bool
    let now: Date
    let dayDate: String
    let visitIndex: Int

    @AppStorage(MapsAppPreference.userDefaultsKey) private var preferredMapsAppRaw = MapsAppPreference.appleMaps.rawValue
    @State private var showNotes = false
    @State private var checkInError: String?
    @State private var showOutsideRadiusConfirm = false
    @State private var showVisitNoteSheet = false
    @State private var visitNoteDraft = ""
    @State private var visitNoteError: String?

    private var runtimeState: VisitRuntimeState? {
        appState.visitRuntimeState(dayDate: dayDate, visitIndex: visitIndex)
    }

    private var departureTime: Date? {
        guard let start = visit.startTime.asTimeOn(isoDate: dayDate) else { return nil }
        return start.addingTimeInterval(TimeInterval(-max(0, visit.travelTimeFromPrev) * 60))
    }

    private var minutesToDepart: Int? {
        guard let dep = departureTime else { return nil }
        let diff = dep.timeIntervalSince(now)
        guard diff > 0 else { return nil }
        return Int(diff / 60)
    }

    private var visitStatus: VisitStatus {
        if let state = runtimeState {
            return state.isCompleted ? .completed : .active
        }
        guard let start = visit.startTime.asTimeOn(isoDate: dayDate),
              let end   = visit.endTime.asTimeOn(isoDate: dayDate) else { return .upcoming }
        if now >= start && now <= end { return .active }
        if now > end { return .completed }
        return .upcoming
    }

    var body: some View {
        let _ = appState.visitRuntimeRevision
        VStack(alignment: .leading, spacing: 0) {
            // Travel indicator between visits
            if visit.travelTimeFromPrev > 0 {
                travelIndicator
            }

            // Main card
            VStack(alignment: .leading, spacing: 10) {
                // Header row: client name + status badge
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(client.name)
                            .font(.headline)
                        Text(client.address)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer()
                    statusBadge
                }

                // Time row
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("\(visit.startTime.formatted12h) – \(visit.endTime.formatted12h)")
                        .font(.subheadline)
                    Text("(\(visit.startTime.durationString(to: visit.endTime)))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                // Departure countdown
                if runtimeState == nil, let mins = minutesToDepart {
                    HStack(spacing: 4) {
                        Image(systemName: "figure.walk.departure")
                            .font(.caption)
                            .foregroundStyle(mins <= 10 ? .orange : .blue)
                        Text(departureText(mins: mins))
                            .font(.subheadline)
                            .foregroundStyle(mins <= 10 ? .orange : .primary)
                            .fontWeight(mins <= 10 ? .semibold : .regular)
                    }
                }

                if let runtimeState {
                    HStack(spacing: 4) {
                        Image(systemName: "timer")
                            .font(.caption)
                            .foregroundStyle(.blue)
                        if runtimeState.isCompleted {
                            Text("Completed at \(runtimeState.completedAt?.formatted(date: .omitted, time: .shortened) ?? "")")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            Text(remainingDurationText(from: runtimeState.checkedInAt))
                                .font(.subheadline)
                        }
                    }
                }

                // Notes (expandable)
                if !client.notes.isEmpty {
                    Divider()
                    Button {
                        withAnimation { showNotes.toggle() }
                    } label: {
                        HStack {
                            Label("Notes", systemImage: "note.text")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Image(systemName: showNotes ? "chevron.up" : "chevron.down")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if showNotes {
                        Text(client.notes)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.top, 2)
                    }
                }

                if let vn = runtimeState?.visitNote, !vn.isEmpty {
                    Divider()
                    VStack(alignment: .leading, spacing: 4) {
                        Label("Visit log", systemImage: "text.badge.plus")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(vn)
                            .font(.caption)
                            .foregroundStyle(.primary)
                    }
                }

                // Action buttons
                Divider()
                HStack {
                    NavigationButton(icon: "arrow.triangle.turn.up.right.circle.fill", label: "Navigate") {
                        let app = MapsAppPreference(rawValue: preferredMapsAppRaw) ?? .appleMaps
                        MapsNavigation.openDrivingDirections(to: client.address, preferredApp: app)
                    }
                    Spacer()
                    if runtimeState != nil {
                        Button {
                            visitNoteDraft = ""
                            visitNoteError = nil
                            showVisitNoteSheet = true
                        } label: {
                            Text("Add note")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color(.secondarySystemBackground))
                                .foregroundStyle(.primary)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        Button {
                            appState.uncheckInVisit(dayDate: dayDate, visitIndex: visitIndex)
                        } label: {
                            Text("Un-check In")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color(.tertiarySystemBackground))
                                .foregroundStyle(.primary)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                    Button {
                        handleCheckInTap()
                    } label: {
                        Text(checkInButtonTitle)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(checkInButtonBackground)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(checkInDisabled)
                }

                if let checkInError {
                    Text(checkInError)
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            }
            .padding()
            .background(cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .stroke(visitStatus == .active ? Color.blue.opacity(0.5) : Color.clear, lineWidth: 2)
            )
        }
        .alert("Start visit anyway?", isPresented: $showOutsideRadiusConfirm) {
            Button("Start Visit", role: .destructive) {
                Task {
                    _ = try? await appState.checkInVisit(
                        dayDate: dayDate,
                        visitIndex: visitIndex,
                        allowOutsideRadius: true
                    )
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You appear to be away from the client location.")
        }
        .sheet(isPresented: $showVisitNoteSheet) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Add a note for this visit. It is saved to your visit audit log.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $visitNoteDraft)
                        .frame(minHeight: 120)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
                    if let visitNoteError {
                        Text(visitNoteError)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .padding()
                .navigationTitle("Visit note")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showVisitNoteSheet = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            Task {
                                visitNoteError = nil
                                do {
                                    try await appState.addVisitNote(
                                        dayDate: dayDate,
                                        visitIndex: visitIndex,
                                        text: visitNoteDraft
                                    )
                                    showVisitNoteSheet = false
                                } catch {
                                    visitNoteError = error.localizedDescription
                                }
                            }
                        }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
    }

    // MARK: - Sub-views

    private var travelIndicator: some View {
        HStack {
            Rectangle()
                .fill(Color.secondary.opacity(0.3))
                .frame(width: 2)
                .frame(height: 24)
                .padding(.leading, 20)
            Image(systemName: "car")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("\(visit.travelTimeFromPrev) min drive")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let miles = visit.travelDistanceMiFromPrev {
                Text("· \(String(format: "%.1f", miles)) mi")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.leading, 8)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch visitStatus {
        case .active:
            Text("In Progress")
                .font(.caption2.bold())
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.blue.opacity(0.15))
                .foregroundStyle(.blue)
                .clipShape(Capsule())
        case .completed:
            Text("Done")
                .font(.caption2.bold())
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.green.opacity(0.15))
                .foregroundStyle(.green)
                .clipShape(Capsule())
        case .upcoming:
            EmptyView()
        }
    }

    private var cardBackground: Color {
        switch visitStatus {
        case .active:    return Color(.systemBackground)
        case .completed: return Color(.secondarySystemBackground)
        case .upcoming:  return Color(.systemBackground)
        }
    }

    private func departureText(mins: Int) -> String {
        if mins < 1 { return "Depart now!" }
        return "Depart in \(mins) min"
    }

    private var checkInDisabled: Bool {
        runtimeState?.isCompleted == true
    }

    private var checkInButtonTitle: String {
        guard let runtimeState else { return "Check In" }
        if runtimeState.isCompleted { return "Visit Complete" }
        return "Complete Visit"
    }

    private var checkInButtonBackground: Color {
        guard let runtimeState else { return .blue }
        return runtimeState.isCompleted ? .green : .orange
    }

    private func handleCheckInTap() {
        checkInError = nil
        if let state = runtimeState, !state.isCompleted {
            appState.completeVisit(dayDate: dayDate, visitIndex: visitIndex)
            return
        }
        Task {
            do {
                _ = try await appState.checkInVisit(dayDate: dayDate, visitIndex: visitIndex)
            } catch {
                await MainActor.run {
                    if error is VisitCheckInError {
                        showOutsideRadiusConfirm = true
                    } else {
                        checkInError = error.localizedDescription
                    }
                }
            }
        }
    }

    private func remainingDurationText(from checkInAt: Date) -> String {
        let end = checkInAt.addingTimeInterval(TimeInterval(max(client.visitDurationMinutes, 1) * 60))
        let diff = Int(end.timeIntervalSince(now) / 60)
        if diff <= 0 { return "Planned duration reached" }
        return "\(diff) min remaining"
    }
}

// MARK: - Visit status

private enum VisitStatus { case upcoming, active, completed }

// MARK: - Navigation action button

struct NavigationButton: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                Text(label)
            }
            .font(.caption.weight(.medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(.secondarySystemBackground))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - String helpers

extension String {
    func durationString(to endTime: String) -> String {
        let startParts = split(separator: ":").compactMap { Int($0) }
        let endParts   = endTime.split(separator: ":").compactMap { Int($0) }
        guard startParts.count == 2, endParts.count == 2 else { return "" }
        let totalMins = (endParts[0] * 60 + endParts[1]) - (startParts[0] * 60 + startParts[1])
        if totalMins <= 0 { return "" }
        if totalMins < 60 { return "\(totalMins)m" }
        let h = totalMins / 60, m = totalMins % 60
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }
}
