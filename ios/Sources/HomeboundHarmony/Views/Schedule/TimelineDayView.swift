import SwiftUI
import UIKit

// MARK: - Layout model

private struct VisitLayout {
    var visit: ScheduledVisit
    var index: Int      // position in day.visits
    var column: Int     // horizontal column within an overlap group
    var totalColumns: Int
}

// MARK: - Timeline constants

private let hourHeight: CGFloat = 64          // points per hour
private let minuteHeight: CGFloat = 64.0 / 60 // points per minute
private let hourLabelWidth: CGFloat = 44
private let eventPad: CGFloat = 2
private let visibleStartHour = 6
private let visibleEndHour = 21

/// FNV-1a 32-bit — deterministic for a given string. `String.hashValue` is seeded per process, so it changes every app launch.
private func fnv1aHash32(_ string: String) -> UInt32 {
    var hash: UInt32 = 2_166_136_261
    for byte in string.utf8 {
        hash ^= UInt32(byte)
        hash &*= 16_777_619
    }
    return hash
}

// MARK: - TimelineDayView

/// Draggable vertical timeline for a single day's schedule.
/// Long-press an event to select it (shows delete FAB), then drag to reschedule.
struct TimelineDayView: View {
    let day: DaySchedule
    let worker: WorkerProfile
    let clients: [Client]
    let travelTimes: TravelTimeMatrix
    let onScheduleUpdated: (DaySchedule) -> Void

    @State private var activeIdx: Int? = nil     // selected visit index
    @State private var dragOffset: CGFloat = 0   // live drag translation (points)
    @State private var isDragging = false         // finger is actively moving
    @State private var showAddSheet = false

    private var totalHeight: CGFloat { CGFloat(visibleEndHour - visibleStartHour) * hourHeight }
    private var visibleStartMin: Int { visibleStartHour * 60 }

    private var clientMap: [String: Client] {
        Dictionary(uniqueKeysWithValues: clients.map { ($0.id, $0) })
    }

    private func yPos(_ minute: Int) -> CGFloat {
        CGFloat(minute - visibleStartMin) * minuteHeight
    }

    private func minuteForY(_ y: CGFloat) -> Int {
        Int((y / minuteHeight).rounded()) + visibleStartMin
    }

    // MARK: - Body

    var body: some View {
        GeometryReader { geo in
            let containerWidth = geo.size.width
            ZStack(alignment: .bottomTrailing) {
                ScrollView(.vertical, showsIndicators: false) {
                    ZStack(alignment: .topLeading) {
                        // Invisible sizer
                        Color.clear.frame(height: totalHeight)

                        // Hour grid lines
                        ForEach(visibleStartHour..<visibleEndHour, id: \.self) { hour in
                            hourLine(hour: hour)
                        }

                        // Red "now" line
                        currentTimeLine

                        // Availability band sits under visit blocks; dashed preview is drawn above (see below).
                        dragAvailabilityBand(containerWidth: containerWidth)

                        // Visit blocks — width from enclosing GeometryReader (avoids stale default on first tab appear)
                        visitLayer(containerWidth: containerWidth)

                        dragDropPreviewOverlay(containerWidth: containerWidth)
                    }
                    .frame(maxWidth: .infinity, minHeight: totalHeight)
                    // Tap empty area to deselect
                    .contentShape(Rectangle())
                    .onTapGesture { exitEditMode() }
                }
                // Only disable scroll while finger is actively dragging an event
                .scrollDisabled(isDragging)

                // FAB: trash when an event is selected, plus otherwise
                if activeIdx != nil {
                    deleteFAB
                } else {
                    addFAB
                }
            }
        }
        .sheet(isPresented: $showAddSheet) {
            AddVisitSheet(
                day: day,
                worker: worker,
                clients: clients,
                travelTimes: travelTimes
            ) { newDay in
                onScheduleUpdated(newDay)
                showAddSheet = false
            }
        }
    }

    // MARK: - Hour grid

    private func hourLine(hour: Int) -> some View {
        HStack(spacing: 0) {
            Text(hourLabel(hour))
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .frame(width: hourLabelWidth, alignment: .trailing)
                .padding(.trailing, 6)
            Rectangle()
                .fill(Color.secondary.opacity(0.15))
                .frame(height: 0.5)
        }
        .frame(maxWidth: .infinity)
        .offset(y: yPos(hour * 60) - 7)
    }

    private func hourLabel(_ hour: Int) -> String {
        let h12 = hour == 0 ? 12 : (hour > 12 ? hour - 12 : hour)
        return "\(h12)\(hour < 12 ? "AM" : "PM")"
    }

    // MARK: - Current time line

    @ViewBuilder
    private var currentTimeLine: some View {
        let cal = Calendar.current
        let now = Date()
        let hour = cal.component(.hour, from: now)
        let minute = cal.component(.minute, from: now)
        let totalMin = hour * 60 + minute

        if totalMin >= visibleStartMin && totalMin < visibleEndHour * 60 {
            HStack(spacing: 0) {
                Circle()
                    .fill(Color.red)
                    .frame(width: 7, height: 7)
                    .offset(x: hourLabelWidth - 3)
                Rectangle()
                    .fill(Color.red.opacity(0.7))
                    .frame(height: 1.5)
                    .padding(.leading, hourLabelWidth)
            }
            .frame(maxWidth: .infinity)
            .offset(y: yPos(totalMin) - 3.5)
        }
    }

    // MARK: - Visit layer

    private func visitLayer(containerWidth: CGFloat) -> some View {
        let eventAreaWidth = containerWidth - hourLabelWidth - 8
        let layouts = computeOverlapLayout(day.visits)

        return ForEach(Array(layouts.enumerated()), id: \.offset) { pair in
            visitGroup(item: pair.element, idx: pair.offset, areaWidth: eventAreaWidth)
        }
    }

    @ViewBuilder
    private func visitGroup(item: VisitLayout, idx: Int, areaWidth: CGFloat) -> some View {
        let visit = item.visit
        let startMin = timeToMinutes(visit.startTime)
        let endMin = timeToMinutes(visit.endTime)
        let blockH = max(CGFloat(endMin - startMin) * minuteHeight - 1, 30)
        let colW = (areaWidth / CGFloat(item.totalColumns)) - eventPad
        let xPos = hourLabelWidth + CGFloat(item.column) * (areaWidth / CGFloat(item.totalColumns))
        let yBase = yPos(startMin)
        let lift: CGFloat = (activeIdx == idx && isDragging) ? dragOffset : 0
        let isSelected = activeIdx == idx
        let isDragSource = activeIdx == idx && isDragging
        let color = clientColor(for: visit.clientId)

        // Travel indicator just above this block (dashed line + label)
        if visit.travelTimeFromPrev > 0 {
            let travelH = CGFloat(visit.travelTimeFromPrev) * minuteHeight
            HStack(spacing: 3) {
                Image(systemName: "car.fill")
                    .font(.system(size: 9))
                Text("\(visit.travelTimeFromPrev)m drive")
                    .font(.system(size: 10))
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, xPos + 4)
            .offset(y: yBase - travelH * 0.5 - 8 + lift)
        }

        // "Events overlapping" label — show once per overlap group on the first column
        if item.column == 0 && item.totalColumns > 1 {
            Text("Events overlapping")
                .font(.caption2)
                .foregroundStyle(.orange)
                .offset(x: hourLabelWidth + 2, y: yBase - 14 + lift)
        }

        // Main event block
        visitBlock(
            visit: visit, client: clientMap[visit.clientId],
            width: colW, height: blockH,
            color: color, isSelected: isSelected,
            dimmed: isDragSource
        )
        .offset(x: xPos + eventPad / 2, y: yBase + lift)
        .onLongPressGesture(minimumDuration: 0.3) {
            withAnimation(.spring(response: 0.2, dampingFraction: 0.7)) {
                activeIdx = idx
            }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 8)
                .onChanged { val in
                    guard activeIdx == idx else { return }
                    isDragging = true
                    dragOffset = val.translation.height
                }
                .onEnded { val in
                    guard activeIdx == idx && isDragging else { return }
                    commitDrop(visitIdx: idx, translation: val.translation.height)
                }
        )
    }

    @ViewBuilder
    // MARK: - Drag preview & availability

    private func dragAvailabilityBand(containerWidth: CGFloat) -> some View {
        let eventAreaWidth = containerWidth - hourLabelWidth - 8
        return Group {
            if isDragging,
               let idx = activeIdx,
               idx < day.visits.count,
               let client = clientMap[day.visits[idx].clientId] {
                availabilityBand(for: client, eventAreaWidth: eventAreaWidth)
            }
        }
        .allowsHitTesting(false)
    }

    private func dragDropPreviewOverlay(containerWidth: CGFloat) -> some View {
        let eventAreaWidth = containerWidth - hourLabelWidth - 8
        return Group {
            if isDragging,
               let idx = activeIdx,
               idx < day.visits.count,
               let prop = proposedDropForDrag(visitIdx: idx, translationY: dragOffset) {
                dropPreviewOverlay(
                    startMin: prop.start,
                    endMin: prop.end,
                    isValid: prop.isValid,
                    eventAreaWidth: eventAreaWidth
                )
            }
        }
        .allowsHitTesting(false)
    }

    /// Resulting start/end if the user releases at this vertical translation (same rules as `commitDrop`).
    private func proposedDropForDrag(visitIdx: Int, translationY: CGFloat) -> (start: Int, end: Int, isValid: Bool)? {
        guard visitIdx < day.visits.count else { return nil }
        let visit = day.visits[visitIdx]
        guard let client = clientMap[visit.clientId] else { return nil }

        let originalStart = timeToMinutes(visit.startTime)
        let minutesDelta = Int((translationY / minuteHeight).rounded())
        let rawStart = originalStart + minutesDelta
        let snapped = roundToNearestBlock(rawStart)

        let window = getClientWindowForDay(client: client, day: day.day)
        let whStart = timeToMinutes(worker.workingHours.startTime)
        let whEnd = timeToMinutes(worker.workingHours.endTime)
        let windowStart = window.map { timeToMinutes($0.startTime) } ?? whStart
        let windowEnd = window.map { timeToMinutes($0.endTime) } ?? whEnd
        let duration = client.visitDurationMinutes

        let clampedStart = max(snapped, windowStart, whStart)
        let newEnd = clampedStart + duration

        var valid = newEnd <= windowEnd && newEnd <= whEnd
        if valid {
            for brk in worker.breaks {
                let bs = timeToMinutes(brk.startTime)
                let be = timeToMinutes(brk.endTime)
                if clampedStart < be && newEnd > bs {
                    valid = false
                    break
                }
            }
        }
        return (clampedStart, newEnd, valid)
    }

    private func availabilityBand(for client: Client, eventAreaWidth: CGFloat) -> some View {
        let whStart = timeToMinutes(worker.workingHours.startTime)
        let whEnd = timeToMinutes(worker.workingHours.endTime)
        let window = getClientWindowForDay(client: client, day: day.day)
        let bandStart = window.map { timeToMinutes($0.startTime) } ?? whStart
        let bandEnd = window.map { timeToMinutes($0.endTime) } ?? whEnd
        let label = "\(minutesToTime(bandStart).formatted12h) – \(minutesToTime(bandEnd).formatted12h)"

        return ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Color.green.opacity(0.12))
            Rectangle()
                .strokeBorder(Color.green.opacity(0.4), lineWidth: 2)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(Color.green.opacity(0.9))
                .padding(.horizontal, 4)
                .padding(.top, 2)
        }
        .frame(width: eventAreaWidth, height: max(CGFloat(bandEnd - bandStart) * minuteHeight, 3))
        .offset(x: hourLabelWidth + 4, y: yPos(bandStart))
    }

    private func dropPreviewOverlay(startMin: Int, endMin: Int, isValid: Bool, eventAreaWidth: CGFloat) -> some View {
        let h = max(CGFloat(endMin - startMin) * minuteHeight, 4)
        let stroke = isValid ? Color.green.opacity(0.75) : Color.red.opacity(0.85)
        let fill = isValid ? Color.green.opacity(0.12) : Color.red.opacity(0.12)

        return ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 6)
                .fill(fill)
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(stroke, style: StrokeStyle(lineWidth: 2, dash: [6, 5]))
            Text(minutesToTime(startMin).formatted12h)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(isValid ? Color.green.opacity(0.95) : Color.red)
                .padding(.horizontal, 4)
                .padding(.top, 3)
        }
        .frame(width: eventAreaWidth - 4, height: h, alignment: .topLeading)
        .offset(x: hourLabelWidth + 6, y: yPos(startMin))
    }

    private func visitBlock(
        visit: ScheduledVisit,
        client: Client?,
        width: CGFloat,
        height: CGFloat,
        color: Color,
        isSelected: Bool,
        dimmed: Bool = false
    ) -> some View {
        HStack(alignment: .top, spacing: 4) {
            VStack(alignment: .leading, spacing: 2) {
                // Travel label inside block (if tall enough)
                if visit.travelTimeFromPrev > 0 && height >= 46 {
                    HStack(spacing: 2) {
                        Image(systemName: "car.fill")
                            .font(.system(size: 9))
                        Text("\(visit.travelTimeFromPrev)m drive")
                            .font(.system(size: 10))
                    }
                    .foregroundStyle(.white.opacity(0.8))
                }

                Text(client?.name ?? "Unknown")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(height < 46 ? 1 : 2)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Text("\(visit.startTime.formatted12h) – \(visit.endTime.formatted12h)")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.white.opacity(0.9))
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .frame(width: width, height: height, alignment: .topLeading)
        .background(color.opacity(dimmed ? 0.28 : (isSelected ? 0.55 : 0.82)))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(isSelected ? Color.white : Color.clear, lineWidth: 2)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .shadow(color: isSelected ? color.opacity(0.4) : .clear, radius: 6, y: 3)
    }

    // MARK: - Drop commit

    private func commitDrop(visitIdx: Int, translation: CGFloat) {
        defer { exitEditMode() }

        let visit = day.visits[visitIdx]
        guard let client = clientMap[visit.clientId] else { return }

        let originalStart = timeToMinutes(visit.startTime)
        let minutesDelta = Int((translation / minuteHeight).rounded())
        let rawStart = originalStart + minutesDelta
        let snapped = roundToNearestBlock(rawStart)

        let window = getClientWindowForDay(client: client, day: day.day)
        let whStart = timeToMinutes(worker.workingHours.startTime)
        let whEnd = timeToMinutes(worker.workingHours.endTime)
        let windowStart = window.map { timeToMinutes($0.startTime) } ?? whStart
        let windowEnd = window.map { timeToMinutes($0.endTime) } ?? whEnd
        let duration = client.visitDurationMinutes

        let clampedStart = max(snapped, windowStart, whStart)
        let newEnd = clampedStart + duration

        // Validate time bounds
        guard newEnd <= windowEnd && newEnd <= whEnd else {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return
        }

        // Reject drops that land inside a break
        for brk in worker.breaks {
            let bs = timeToMinutes(brk.startTime)
            let be = timeToMinutes(brk.endTime)
            if clampedStart < be && newEnd > bs {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                return
            }
        }

        var updatedVisit = visit
        updatedVisit.startTime = minutesToTime(clampedStart)
        updatedVisit.endTime = minutesToTime(newEnd)
        updatedVisit.manuallyPlaced = true

        let otherVisits = day.visits.enumerated()
            .filter { $0.offset != visitIdx }
            .map { $0.element }

        let result = resolveConflicts(
            droppedVisit: updatedVisit,
            existingVisits: otherVisits,
            dayOfWeek: day.day,
            worker: worker,
            clients: clients,
            travelTimes: travelTimes
        )

        if let newDay = recalcDaySchedule(
            visits: result.resolvedVisits,
            day: day,
            worker: worker,
            clients: clients,
            travelTimes: travelTimes,
            preserveManualTimes: true
        ) {
            onScheduleUpdated(newDay)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }

    private func exitEditMode() {
        withAnimation(.easeOut(duration: 0.15)) {
            activeIdx = nil
            dragOffset = 0
            isDragging = false
        }
    }

    // MARK: - Delete

    private func deleteSelectedVisit() {
        guard let idx = activeIdx else { return }
        var remaining = day.visits
        remaining.remove(at: idx)

        let newDay: DaySchedule
        if let recalced = recalcDaySchedule(
            visits: remaining,
            day: day,
            worker: worker,
            clients: clients,
            travelTimes: travelTimes,
            preserveManualTimes: false
        ) {
            newDay = recalced
        } else {
            newDay = DaySchedule(
                day: day.day, date: day.date, visits: [],
                totalTravelMinutes: 0,
                leaveHomeTime: worker.workingHours.startTime,
                arriveHomeTime: worker.workingHours.startTime
            )
        }
        onScheduleUpdated(newDay)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        exitEditMode()
    }

    // MARK: - FABs

    private var addFAB: some View {
        Button { showAddSheet = true } label: {
            Image(systemName: "plus")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Color.blue)
                .clipShape(Circle())
                .shadow(radius: 4)
        }
        .padding()
    }

    private var deleteFAB: some View {
        Button { deleteSelectedVisit() } label: {
            Image(systemName: "trash")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Color.red)
                .clipShape(Circle())
                .shadow(radius: 4)
        }
        .padding()
    }

    // MARK: - Overlap layout

    private func computeOverlapLayout(_ visits: [ScheduledVisit]) -> [VisitLayout] {
        var layouts: [VisitLayout] = []

        for (idx, visit) in visits.enumerated() {
            let s = timeToMinutes(visit.startTime)
            let e = timeToMinutes(visit.endTime)

            // Which columns are already occupied by overlapping visits processed so far?
            let takenCols = layouts.compactMap { lv -> Int? in
                let ls = timeToMinutes(lv.visit.startTime)
                let le = timeToMinutes(lv.visit.endTime)
                guard ls < e && le > s else { return nil }
                return lv.column
            }

            var col = 0
            while takenCols.contains(col) { col += 1 }
            layouts.append(VisitLayout(visit: visit, index: idx, column: col, totalColumns: 1))
        }

        // Fix totalColumns for each layout item (max column+1 across its overlap group)
        for i in layouts.indices {
            let si = timeToMinutes(layouts[i].visit.startTime)
            let ei = timeToMinutes(layouts[i].visit.endTime)
            let maxCol = layouts.reduce(0) { acc, lv in
                let ls = timeToMinutes(lv.visit.startTime)
                let le = timeToMinutes(lv.visit.endTime)
                guard ls < ei && le > si else { return acc }
                return max(acc, lv.column)
            }
            layouts[i].totalColumns = maxCol + 1
        }

        return layouts
    }

    // MARK: - Color

    private func clientColor(for id: String) -> Color {
        let palette: [Color] = [.blue, .green, .orange, .purple, .pink, .teal, .indigo, .cyan]
        let idx = Int(fnv1aHash32(id) % UInt32(palette.count))
        return palette[idx]
    }
}

// MARK: - Add visit sheet

struct AddVisitSheet: View {
    let day: DaySchedule
    let worker: WorkerProfile
    let clients: [Client]
    let travelTimes: TravelTimeMatrix
    let onAdd: (DaySchedule) -> Void

    @State private var selectedClientId: String? = nil
    @State private var startDate: Date = Date()
    @Environment(\.dismiss) private var dismiss

    private var eligibleClients: [Client] {
        clients
            .filter { !$0.isExcluded }
            .filter { client in
                client.timeWindows.contains { $0.day == day.day }
            }
            .sorted { $0.name < $1.name }
    }

    private var defaultStartDate: Date {
        // Default to the next open 15-min slot after the last visit
        let lastEnd = day.visits.last.map { timeToMinutes($0.endTime) }
            ?? timeToMinutes(worker.workingHours.startTime)
        let snapped = roundToNearestBlock(lastEnd + 15)
        let cal = Calendar.current
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        let base = fmt.date(from: day.date) ?? Date()
        return cal.date(bySettingHour: snapped / 60, minute: snapped % 60, second: 0, of: base) ?? base
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Client") {
                    if eligibleClients.isEmpty {
                        Text("No clients available on \(day.day.fullLabel)")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Select client", selection: $selectedClientId) {
                            Text("Choose…").tag(Optional<String>.none)
                            ForEach(eligibleClients) { client in
                                Text(client.name).tag(Optional(client.id))
                            }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                }

                Section("Start time") {
                    DatePicker(
                        "Start time",
                        selection: $startDate,
                        displayedComponents: .hourAndMinute
                    )
                    .datePickerStyle(.wheel)
                    .labelsHidden()
                }

                if let clientId = selectedClientId,
                   let client = clients.first(where: { $0.id == clientId }) {
                    Section("Duration") {
                        Text("\(client.visitDurationMinutes) minutes")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Add Visit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { addVisit() }
                        .disabled(selectedClientId == nil)
                }
            }
            .onAppear { startDate = defaultStartDate }
        }
    }

    private func addVisit() {
        guard let clientId = selectedClientId,
              let client = clients.first(where: { $0.id == clientId }) else { return }

        let cal = Calendar.current
        let hour = cal.component(.hour, from: startDate)
        let minute = cal.component(.minute, from: startDate)
        let rawStart = hour * 60 + minute
        let snapped = roundToNearestBlock(rawStart)

        let newVisit = ScheduledVisit(
            clientId: clientId,
            startTime: minutesToTime(snapped),
            endTime: minutesToTime(snapped + client.visitDurationMinutes),
            travelTimeFromPrev: 0,
            travelDistanceMiFromPrev: nil,
            manuallyPlaced: true
        )

        let existing = day.visits.filter { $0.clientId != clientId }
        let result = resolveConflicts(
            droppedVisit: newVisit,
            existingVisits: existing,
            dayOfWeek: day.day,
            worker: worker,
            clients: clients,
            travelTimes: travelTimes
        )

        if let newDay = recalcDaySchedule(
            visits: result.resolvedVisits,
            day: day,
            worker: worker,
            clients: clients,
            travelTimes: travelTimes,
            preserveManualTimes: true
        ) {
            onAdd(newDay)
        }
    }
}
