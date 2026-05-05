import SwiftUI
import MapKit

// Create or edit a client. When `client` is nil a new one is created on save.

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

    // Time window sheet
    @State private var showAddWindow = false
    @State private var newWindowDay  = DayOfWeek.monday
    @State private var newStart      = "09:00"
    @State private var newEnd        = "17:00"

    // Save state
    @State private var isSaving  = false
    @State private var saveError: String?

    private var isNew: Bool { existingClient == nil }

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
                        ForEach(Priority.allCases, id: \.self) {
                            HStack {
                                Circle()
                                    .fill(priorityColor($0))
                                    .frame(width: 8, height: 8)
                                Text($0.label)
                            }.tag($0)
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
                            HStack {
                                Text(tw.day.fullLabel)
                                    .frame(width: 90, alignment: .leading)
                                Text("\(tw.startTime.formatted12h) – \(tw.endTime.formatted12h)")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .onDelete { indices in timeWindows.remove(atOffsets: indices) }
                    }
                    Button("Add Time Window") { showAddWindow = true }
                } header: {
                    Text("Availability Windows")
                } footer: {
                    Text("Leave empty to allow visits at any time during working hours.")
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
            .sheet(isPresented: $showAddWindow) {
                addTimeWindowSheet
            }
        }
    }

    // MARK: - Add time window sheet

    private var addTimeWindowSheet: some View {
        NavigationStack {
            Form {
                Picker("Day", selection: $newWindowDay) {
                    ForEach(DayOfWeek.allCases) { day in
                        Text(day.fullLabel).tag(day)
                    }
                }
                HStack {
                    Text("Start")
                    Spacer()
                    TimePickerField(time: $newStart)
                }
                HStack {
                    Text("End")
                    Spacer()
                    TimePickerField(time: $newEnd)
                }
            }
            .navigationTitle("Add Window")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showAddWindow = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        timeWindows.append(TimeWindow(day: newWindowDay, startTime: newStart, endTime: newEnd))
                        showAddWindow = false
                    }
                    .disabled(newStart >= newEnd)
                }
            }
        }
        .presentationDetents([.medium])
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

// MARK: - Simple HH:MM picker

struct TimePickerField: View {
    @Binding var time: String
    @State private var date = Date()

    var body: some View {
        DatePicker("", selection: $date, displayedComponents: .hourAndMinute)
            .labelsHidden()
            .onChange(of: date) { _, new in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: new)
                time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
            }
            .onAppear {
                let parts = time.split(separator: ":").compactMap { Int($0) }
                if parts.count == 2,
                   let d = Calendar.current.date(
                    bySettingHour: parts[0], minute: parts[1], second: 0, of: Date()
                   ) {
                    date = d
                }
            }
    }
}
