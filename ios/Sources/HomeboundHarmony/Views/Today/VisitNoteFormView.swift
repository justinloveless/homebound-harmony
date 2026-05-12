import SwiftUI

struct VisitNoteFormView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var appState

    let evvVisitId: String
    let dayDate: String
    let visitIndex: Int

    @State private var templates: [TaskTemplate] = []
    @State private var tasks: [TaskItem] = []
    @State private var freeText: String = ""
    @State private var noteId: String?
    @State private var isSigned = false
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var showSignature = false
    @State private var errorMessage: String?

    @State private var autoSaveTask: Task<Void, Never>?

    private var evvService: EvvService { EvvService(api: appState.api) }

    private var canSign: Bool {
        !isSigned && (tasks.contains { $0.completed } || !freeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    Form {
                        if !tasks.isEmpty {
                            Section("Tasks") {
                                ForEach($tasks) { $task in
                                    Button {
                                        guard !isSigned else { return }
                                        task.completed.toggle()
                                        scheduleAutoSave()
                                    } label: {
                                        HStack {
                                            Image(systemName: task.completed ? "checkmark.square.fill" : "square")
                                                .foregroundStyle(task.completed ? .green : .secondary)
                                            Text(task.label)
                                                .foregroundStyle(.primary)
                                        }
                                    }
                                    .disabled(isSigned)
                                }
                            }
                        }

                        Section("Notes") {
                            TextEditor(text: $freeText)
                                .frame(minHeight: 100)
                                .disabled(isSigned)
                                .onChange(of: freeText) { scheduleAutoSave() }
                        }

                        if isSigned {
                            Section {
                                Label("Signed and submitted", systemImage: "checkmark.seal.fill")
                                    .foregroundStyle(.green)
                            }
                        }

                        if let errorMessage {
                            Section {
                                Text(errorMessage)
                                    .foregroundStyle(.red)
                                    .font(.caption)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Visit Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if !isSigned {
                        Button("Sign & Submit") { showSignature = true }
                            .disabled(!canSign || isSaving)
                    }
                }
            }
            .sheet(isPresented: $showSignature) {
                SignaturePadView(
                    onSign: { svg in
                        showSignature = false
                        Task { await submitSignature(svg) }
                    },
                    onCancel: { showSignature = false }
                )
                .presentationDetents([.medium])
            }
            .task { await loadInitialData() }
        }
    }

    private func loadInitialData() async {
        defer { isLoading = false }
        do {
            async let templatesResult = evvService.fetchTaskTemplates()
            async let notesResult = evvService.getNotes(visitId: evvVisitId)
            let (tmpl, notes) = try await (templatesResult, notesResult)

            templates = tmpl.templates.sorted { $0.sortOrder < $1.sortOrder }

            if let existing = notes.notes.first {
                noteId = existing.id
                tasks = existing.tasksCompleted
                freeText = existing.freeText
                isSigned = existing.signedAt != nil
            } else {
                tasks = templates.map { TaskItem(id: $0.id, label: $0.label, completed: false) }
                let req = EvvUpsertNoteRequest(tasksCompleted: tasks, freeText: "")
                let note = try await evvService.upsertNote(visitId: evvVisitId, req: req)
                noteId = note.id
                var st = appState.visitRuntimeStore.state(for: dayDate, visitIndex: visitIndex)
                if st != nil {
                    st!.evvNoteId = note.id
                    st!.evvNoteStatus = "draft"
                    appState.visitRuntimeStore.upsert(st!)
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func scheduleAutoSave() {
        autoSaveTask?.cancel()
        autoSaveTask = Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            await saveNote()
        }
    }

    private func saveNote() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await appState.upsertVisitNote(dayDate: dayDate, visitIndex: visitIndex, tasks: tasks, freeText: freeText)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func submitSignature(_ svg: String) async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await appState.upsertVisitNote(dayDate: dayDate, visitIndex: visitIndex, tasks: tasks, freeText: freeText)
            try await appState.signVisitNote(dayDate: dayDate, visitIndex: visitIndex, signature: svg)
            isSigned = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
