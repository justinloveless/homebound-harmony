import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @State private var showWorkerEdit    = false
    @State private var showServerConfig  = false
    @State private var showNotifSettings = false
    @State private var showLogoutAlert   = false
    @State private var isSyncing         = false

    var body: some View {
        NavigationStack {
            List {
                // Worker profile
                Section("Worker Profile") {
                    if let worker = appState.workspace?.worker {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(worker.name.isEmpty ? "No name set" : worker.name)
                                .font(.headline)
                            Text(worker.homeAddress.isEmpty ? "No address set" : worker.homeAddress)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 4)
                    }
                    Button("Edit Worker Profile") { showWorkerEdit = true }
                }

                // Notifications
                Section("Reminders") {
                    Button("Notification Settings") { showNotifSettings = true }
                    Button("Reschedule Today's Reminders") {
                        Task {
                            let granted = await appState.notifications.requestAuthorization()
                            if granted { await appState.scheduleNotifications() }
                        }
                    }
                }

                // Connection
                Section("Connection") {
                    HStack {
                        Text("Server")
                        Spacer()
                        Text(UserDefaults.standard.string(forKey: "apiBaseURL") ?? "Not set")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Button("Configure Server URL") { showServerConfig = true }

                    if let email = appState.userEmail {
                        HStack {
                            Text("Signed in as")
                            Spacer()
                            Text(email)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Button(isSyncing ? "Syncing…" : "Sync Now") {
                        isSyncing = true
                        Task {
                            await appState.refreshWorkspace()
                            isSyncing = false
                        }
                    }
                    .disabled(isSyncing)
                }

                // Account
                Section("Account") {
                    Button("Sign Out", role: .destructive) {
                        showLogoutAlert = true
                    }
                }

                // App info
                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(appVersion)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Encryption")
                        Spacer()
                        Text("AES-256-GCM · Argon2id")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .listStyle(.insetGrouped)
            .sheet(isPresented: $showWorkerEdit) {
                WorkerProfileEditView()
            }
            .sheet(isPresented: $showServerConfig) {
                ServerConfigView()
            }
            .sheet(isPresented: $showNotifSettings) {
                NotificationSettingsView()
            }
            .alert("Sign Out", isPresented: $showLogoutAlert) {
                Button("Sign Out", role: .destructive) {
                    Task { await appState.logout() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your encrypted data stays on the server. You can sign back in any time.")
            }
        }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }
}

// MARK: - Worker profile edit

struct WorkerProfileEditView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var name           = ""
    @State private var homeAddress    = ""
    @State private var workStart      = "08:00"
    @State private var workEnd        = "17:00"
    @State private var daysOff        = Set<DayOfWeek>()
    @State private var strategy       = SchedulingStrategy.spread
    @State private var isSaving       = false
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Identity") {
                    TextField("Your name", text: $name)
                    TextField("Home address", text: $homeAddress)
                        .autocorrectionDisabled()
                }

                Section("Working Hours") {
                    HStack {
                        Text("Start")
                        Spacer()
                        TimePickerField(time: $workStart)
                    }
                    HStack {
                        Text("End")
                        Spacer()
                        TimePickerField(time: $workEnd)
                    }
                }

                Section("Days Off") {
                    ForEach(DayOfWeek.allCases) { day in
                        Toggle(day.fullLabel, isOn: Binding(
                            get: { daysOff.contains(day) },
                            set: { on in
                                if on { daysOff.insert(day) }
                                else  { daysOff.remove(day) }
                            }
                        ))
                    }
                }

                Section("Scheduling Strategy") {
                    Picker("Strategy", selection: $strategy) {
                        ForEach(SchedulingStrategy.allCases, id: \.self) {
                            Text($0.label).tag($0)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }

                if let err = saveError {
                    Section {
                        Text(err).foregroundStyle(.red).font(.footnote)
                    }
                }
            }
            .navigationTitle("Worker Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { save() }
                        .disabled(isSaving)
                }
            }
            .onAppear(perform: load)
        }
    }

    private func load() {
        guard let w = appState.workspace?.worker else { return }
        name        = w.name
        homeAddress = w.homeAddress
        workStart   = w.workingHours.startTime
        workEnd     = w.workingHours.endTime
        daysOff     = Set(w.daysOff)
        strategy    = w.schedulingStrategy
    }

    private func save() {
        isSaving   = true
        saveError  = nil
        let profile = WorkerProfile(
            name:             name,
            homeAddress:      homeAddress,
            workingHours:     WorkerProfile.WorkingHours(startTime: workStart, endTime: workEnd),
            daysOff:          Array(daysOff),
            breaks:           appState.workspace?.worker.breaks ?? [],
            schedulingStrategy: strategy
        )
        Task {
            defer { isSaving = false }
            do {
                try await appState.saveWorkerProfile(profile)
                dismiss()
            } catch {
                saveError = error.localizedDescription
            }
        }
    }
}

// MARK: - Server URL config

struct ServerConfigView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var url = UserDefaults.standard.string(forKey: "apiBaseURL") ?? ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://yourserver.example.com", text: $url)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("API Base URL")
                } footer: {
                    Text("The root URL of your Homebound Harmony server. Do not include a trailing slash.")
                        .font(.caption)
                }
            }
            .navigationTitle("Server URL")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        UserDefaults.standard.set(
                            url.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                            forKey: "apiBaseURL"
                        )
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Notification settings

struct NotificationSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var leadMinutes: Int = UserDefaults.standard.integer(forKey: "reminderLeadMinutes").nonZeroOrDefault(5)

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Stepper("Remind \(leadMinutes) min before departure", value: $leadMinutes, in: 1...60, step: 1)
                } header: {
                    Text("Departure Reminder")
                } footer: {
                    Text("A notification fires this many minutes before you need to leave for each visit.")
                        .font(.caption)
                }
            }
            .navigationTitle("Reminders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        UserDefaults.standard.set(leadMinutes, forKey: "reminderLeadMinutes")
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

private extension Int {
    var nonZero: Int? { self == 0 ? nil : self }
    func nonZeroOrDefault(_ d: Int) -> Int { self == 0 ? d : self }
}
