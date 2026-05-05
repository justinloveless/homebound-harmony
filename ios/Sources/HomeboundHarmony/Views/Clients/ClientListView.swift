import SwiftUI

struct ClientListView: View {
    @Environment(AppState.self) private var appState
    @State private var searchText = ""
    @State private var showingAddClient = false
    @State private var clientToDelete: Client?
    @State private var showDeleteAlert = false
    @State private var errorMsg: String?

    private var filteredClients: [Client] {
        let all = appState.workspace?.clients ?? []
        if searchText.isEmpty { return all }
        return all.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            $0.address.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if filteredClients.isEmpty && searchText.isEmpty {
                    emptyState
                } else {
                    clientList
                }
            }
            .navigationTitle("Clients")
            .searchable(text: $searchText, prompt: "Search by name or address")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showingAddClient = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showingAddClient) {
                ClientEditView(client: nil)
            }
            .alert("Delete Client", isPresented: $showDeleteAlert, presenting: clientToDelete) { client in
                Button("Delete", role: .destructive) {
                    Task {
                        do {
                            try await appState.deleteClient(id: client.id)
                        } catch {
                            errorMsg = error.localizedDescription
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { client in
                Text("Remove \(client.name) from your client list? This cannot be undone.")
            }
            .overlay {
                if let msg = errorMsg {
                    VStack {
                        Spacer()
                        Text(msg)
                            .font(.footnote)
                            .padding()
                            .background(Color.red.opacity(0.9))
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .padding()
                            .onTapGesture { errorMsg = nil }
                    }
                }
            }
        }
    }

    // MARK: - Sub-views

    private var clientList: some View {
        List {
            ForEach(filteredClients) { client in
                NavigationLink(destination: ClientEditView(client: client)) {
                    ClientRow(client: client)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        clientToDelete = client
                        showDeleteAlert = true
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.badge.plus")
                .font(.system(size: 52))
                .foregroundStyle(.tertiary)
            Text("No clients yet")
                .font(.headline)
            Text("Tap + to add your first client.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Add Client") { showingAddClient = true }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Client row

struct ClientRow: View {
    let client: Client

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(client.name)
                    .font(.headline)
                Spacer()
                if client.isExcluded {
                    Text("Excluded")
                        .font(.caption2.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.15))
                        .foregroundStyle(.orange)
                        .clipShape(Capsule())
                }
                priorityDot(client.priority)
            }
            Text(client.address)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            HStack(spacing: 8) {
                Label("\(client.visitDurationMinutes) min", systemImage: "clock")
                Label("\(client.visitsPerPeriod)× \(client.period.label)", systemImage: "repeat")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func priorityDot(_ priority: Priority) -> some View {
        Circle()
            .fill(priorityColor(priority))
            .frame(width: 8, height: 8)
    }

    private func priorityColor(_ p: Priority) -> Color {
        switch p {
        case .high:   return .red
        case .medium: return .orange
        case .low:    return .green
        }
    }
}
