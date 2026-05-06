import SwiftUI
import MapKit

// Create or edit a client. When `client` is nil a new one is created on save.

private enum TimeWindowDayPreset: String, CaseIterable {
    case everyday
    case weekdays
    case weekends
    case mwf
    case tth
    case singleDay
    case custom

    var menuLabel: String {
        switch self {
        case .everyday: return "Every day"
        case .weekdays: return "Weekdays (Mon–Fri)"
        case .weekends: return "Weekends"
        case .mwf: return "Mon, Wed, Fri"
        case .tth: return "Tue, Thu"
        case .singleDay: return "One day"
        case .custom: return "Custom days"
        }
    }

    func resolvedDays(singleDay: DayOfWeek, customSelection: Set<DayOfWeek>) -> [DayOfWeek] {
        switch self {
        case .everyday: return Array(DayOfWeek.allCases)
        case .weekdays: return [.monday, .tuesday, .wednesday, .thursday, .friday]
        case .weekends: return [.saturday, .sunday]
        case .mwf: return [.monday, .wednesday, .friday]
        case .tth: return [.tuesday, .thursday]
        case .singleDay: return [singleDay]
        case .custom:
            return DayOfWeek.allCases.filter { customSelection.contains($0) }
        }
    }
}

struct ClientEditView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    let existingClient: Client?
    init(client: Client?) { self.existingClient = client }

    // Form state
    @State private var name              = ""
    @State private var address           = ""
    @State private var visitDuration     = 60
    @State private var visitsPerPeriod   = 1
    @State private var period            = SchedulePeriod.week
    @State private var priority          = Priority.medium
    @State private var notes             = ""
    @State private var excluded          = false
    @State private var timeWindows       = [TimeWindow]()

    // Address geocoding
    @State private var coords: Coords?
    @State private var isGeocoding  = false
    @State private var geocodeError = false

    // Time window sheet (add or edit)
    @State private var showWindowSheet = false
    @State private var editingWindowId: UUID?
    @State private var sheetPreset     = TimeWindowDayPreset.singleDay
    @State private var newWindowDay    = DayOfWeek.monday
    @State private var customSelectedDays = Set<DayOfWeek>()
    @State private var newStart        = "09:00"
    @State private var newEnd          = "17:00"

    // Save state
    @State private var isSaving  = false
    @State private var saveError: String?

    private var isNew: Bool { existingClient == nil }

    private var isEditingWindow: Bool { editingWindowId != nil }

    private var windowSheetAddDisabled: Bool {
        if newStart >= newEnd { return true }
        if sheetPreset == .custom && customSelectedDays.isEmpty { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            Form {
                // Basic info
                Section("Client Info") {
                    TextField("Full name", text: $name)
                    VStack(alignment: .leading, spacing: 4) {
                        TextField("Address", text: $address)
                            .autocorrectionDisabled()
                        if isGeocoding {
                            HStack {
                                ProgressView().scaleEffect(0.7)
                                Text("Looking up address…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else if geocodeError {
                            Label("Address not found — coordinates not set", systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        } else if let c = coords {
                            Label(String(format: "%.4f, %.4f", c.lat, c.lon), systemImage: "location.fill")
                                .font(.caption)
                                .foregroundStyle(.green)
                        }
                    }
                    Button("Geocode Address") { geocodeAddress() }
                        .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty || isGeocoding)
                }

                // Visit schedule
                Section("Visit Frequency") {
                    Stepper("Duration: \(visitDuration) min", value: $visitDuration, in: 15...480, step: 15)
                    Stepper("Visits: \(visitsPerPeriod)", value: $visitsPerPeriod, in: 1...30)
                    Picker("Period", selection: $period) {
                        ForEach(SchedulePeriod.allCases, id: \.self) {
                            Text($0.label).tag($0)
                        }
                    }
                    Picker("Priority", selection: $priority) {
                        ForEach(Priority.allCases, id: \.self) { p in
                            HStack {
                                Circle()
                                    .fill(priorityColor(p))
                                    .frame(width: 8, height: 8)
                                Text(p.label)
                            }
                            .tag(p)
                        }
                    }
                }

                // Availability windows
                Section {
                    if timeWindows.isEmpty {
                        Text("No restrictions — available any working hour")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(timeWindows) { tw in
                            HStack(alignment: .center, spacing: 8) {
                                HStack {
                                    Text(tw.day.fullLabel)
                                        .frame(width: 90, alignment: .leading)
                                        .foregroundStyle(.primary)
                                    Text("\(tw.startTime.formatted12h) – \(tw.endTime.formatted12h)")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                                .onTapGesture { openWindowSheetForEdit(tw) }

                                Button(role: .destructive) {
                                    timeWindows.removeAll { $0.id == tw.id }
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.body)
                                        .frame(minWidth: 44, minHeight: 44)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Delete time window")
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button("Delete", role: .destructive) {
                                    timeWindows.removeAll { $0.id == tw.id }
                                }
                            }
                            .contextMenu {
                                Button("Edit") { openWindowSheetForEdit(tw) }
                                Button("Delete", role: .destructive) {
                                    timeWindows.removeAll { $0.id == tw.id }
                                }
                            }
                        }
                    }
                    Button("Add Time Window") { openWindowSheetForAdd() }
                } header: {
                    Text("Availability Windows")
                } footer: {
                    Text(
                        "Leave empty to allow visits at any time during working hours. "
                            + "Scheduling uses at most one window per weekday (15-minute times). "
                            + "Tap a row to edit, or the trash button to remove it."
                    )
                    .font(.caption)
                }

                // Notes
                Section("Notes") {
                    TextEditor(text: $notes)
                        .frame(minHeight: 80)
                }

                // Scheduling toggle
                Section {
                    Toggle("Exclude from auto-scheduling", isOn: $excluded)
                } footer: {
                    Text("When excluded, this client stays in your roster but won't be placed in new schedules.")
                        .font(.caption)
                }

                // Error
                if let err = saveError {
                    Section {
                        Text(err)
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle(isNew ? "New Client" : "Edit Client")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { save() }
                        .disabled(isSaving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear(perform: loadExisting)
            .sheet(isPresented: $showWindowSheet, onDismiss: { editingWindowId = nil }) {
                windowSheet
            }
        }
    }

    // MARK: - Time window sheet

    private var windowSheet: some View {
        NavigationStack {
            Form {
                if isEditingWindow {
                    Picker("Day", selection: $newWindowDay) {
                        ForEach(DayOfWeek.allCases) { day in
                            Text(day.fullLabel).tag(day)
                        }
                    }
                } else {
                    Section {
                        Picker("Repeat", selection: $sheetPreset) {
                            ForEach(TimeWindowDayPreset.allCases, id: \.self) { preset in
                                Text(preset.menuLabel).tag(preset)
                            }
                        }
                    }

                    if sheetPreset == .singleDay {
                        Picker("Day", selection: $newWindowDay) {
                            ForEach(DayOfWeek.allCases) { day in
                                Text(day.fullLabel).tag(day)
                            }
                        }
                    }

                    if sheetPreset == .custom {
                        Section("Days") {
                            ForEach(DayOfWeek.allCases) { day in
                                Toggle(isOn: customDayBinding(day)) {
                                    Text(day.fullLabel)
                                }
                            }
                        }
                    }
                }

                Section {
                    LabeledContent("Start") {
                        QuarterHourTimePicker(timeHHMM: $newStart)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    LabeledContent("End") {
                        QuarterHourTimePicker(timeHHMM: $newEnd)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            }
            .navigationTitle(isEditingWindow ? "Edit Window" : "Add Window")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showWindowSheet = false
                        editingWindowId = nil
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isEditingWindow {
                        Button("Save") {
                            confirmEditWindow()
                        }
                        .disabled(newStart >= newEnd)
                    } else {
                        Button("Add") {
                            confirmAddWindows()
                        }
                        .disabled(windowSheetAddDisabled)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func customDayBinding(_ day: DayOfWeek) -> Binding<Bool> {
        Binding(
            get: { customSelectedDays.contains(day) },
            set: { on in
                if on { customSelectedDays.insert(day) }
                else { customSelectedDays.remove(day) }
            }
        )
    }

    private func openWindowSheetForAdd() {
        editingWindowId = nil
        sheetPreset = .singleDay
        newWindowDay = .monday
        customSelectedDays = []
        newStart = "09:00"
        newEnd = "17:00"
        showWindowSheet = true
    }

    private func openWindowSheetForEdit(_ tw: TimeWindow) {
        editingWindowId = tw.id
        sheetPreset = .singleDay
        newWindowDay = tw.day
        customSelectedDays = []
        newStart = snapToQuarterHHMM(tw.startTime)
        newEnd = snapToQuarterHHMM(tw.endTime)
        showWindowSheet = true
    }

    private func orderedDaysForAdd() -> [DayOfWeek] {
        let resolved = sheetPreset.resolvedDays(singleDay: newWindowDay, customSelection: customSelectedDays)
        let set = Set(resolved)
        return DayOfWeek.allCases.filter { set.contains($0) }
    }

    private func confirmAddWindows() {
        let days = orderedDaysForAdd()
        guard !days.isEmpty, newStart < newEnd else { return }
        let daySet = Set(days)
        timeWindows.removeAll { daySet.contains($0.day) }
        for d in days {
            timeWindows.append(TimeWindow(day: d, startTime: newStart, endTime: newEnd))
        }
        sortTimeWindows()
        showWindowSheet = false
        editingWindowId = nil
    }

    private func confirmEditWindow() {
        guard let id = editingWindowId, newStart < newEnd else { return }
        timeWindows.removeAll { $0.day == newWindowDay && $0.id != id }
        guard let idx = timeWindows.firstIndex(where: { $0.id == id }) else { return }
        timeWindows[idx] = TimeWindow(id: id, day: newWindowDay, startTime: newStart, endTime: newEnd)
        sortTimeWindows()
        showWindowSheet = false
        editingWindowId = nil
    }

    private func sortTimeWindows() {
        let order = DayOfWeek.allCases
        timeWindows.sort {
            let ia = order.firstIndex(of: $0.day) ?? 0
            let ib = order.firstIndex(of: $1.day) ?? 0
            if ia != ib { return ia < ib }
            if $0.startTime != $1.startTime { return $0.startTime < $1.startTime }
            return $0.id.uuidString < $1.id.uuidString
        }
    }

    private func snapToQuarterHHMM(_ s: String) -> String {
        let parts = s.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return s }
        var minutes = parts[0] * 60 + parts[1]
        minutes = min(23 * 60 + 45, max(0, (minutes + 7) / 15 * 15))
        return String(format: "%02d:%02d", minutes / 60, minutes % 60)
    }

    // MARK: - Actions

    private func loadExisting() {
        guard let c = existingClient else { return }
        name            = c.name
        address         = c.address
        coords          = c.coords
        visitDuration   = c.visitDurationMinutes
        visitsPerPeriod = c.visitsPerPeriod
        period          = c.period
        priority        = c.priority
        timeWindows     = c.timeWindows
        notes           = c.notes
        excluded        = c.isExcluded
    }

    private func save() {
        saveError = nil
        isSaving  = true
        let clientId = existingClient?.id ?? UUID().uuidString
        let client = Client(
            id:                   clientId,
            name:                 name.trimmingCharacters(in: .whitespaces),
            address:              address.trimmingCharacters(in: .whitespaces),
            coords:               coords,
            visitDurationMinutes: visitDuration,
            visitsPerPeriod:      visitsPerPeriod,
            period:               period,
            priority:             priority,
            timeWindows:          timeWindows,
            notes:                notes,
            excludedFromSchedule: excluded ? true : nil
        )
        Task {
            defer { isSaving = false }
            do {
                try await appState.saveClient(client)
                dismiss()
            } catch {
                saveError = error.localizedDescription
            }
        }
    }

    private func geocodeAddress() {
        let query = address.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return }
        isGeocoding = true
        geocodeError = false
        let geocoder = CLGeocoder()
        geocoder.geocodeAddressString(query) { placemarks, error in
            DispatchQueue.main.async {
                isGeocoding = false
                if let loc = placemarks?.first?.location {
                    coords = Coords(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude)
                } else {
                    geocodeError = true
                }
            }
        }
    }

    private func priorityColor(_ p: Priority) -> Color {
        switch p {
        case .high:   return .red
        case .medium: return .orange
        case .low:    return .green
        }
    }
}
