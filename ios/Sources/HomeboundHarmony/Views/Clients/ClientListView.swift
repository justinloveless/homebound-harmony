import SwiftUI

struct ClientListView: View {
    @Environment(AppState.self) private var appState
    @FocusState private var isSearchFieldFocused: Bool
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
            .safeAreaInset(edge: .bottom, spacing: 0) {
                clientsSearchBar
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showingAddClient = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        isSearchFieldFocused = false
                    }
                    .fontWeight(.semibold)
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

    private var clientsSearchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.secondary)
            TextField("Search by name or address", text: $searchText)
                .focused($isSearchFieldFocused)
                .textFieldStyle(.plain)
                .submitLabel(.search)
                .onSubmit { isSearchFieldFocused = false }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.ultraThinMaterial)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [
                            Color.primary.opacity(0.12),
                            Color.primary.opacity(0.04),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 0.5
                )
        }
        .compositingGroup()
        .shadow(color: .black.opacity(0.06), radius: 10, x: 0, y: 4)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .background {
            ZStack(alignment: .top) {
                Rectangle()
                    .fill(.regularMaterial)
                Divider()
            }
            .ignoresSafeArea(edges: .bottom)
        }
    }

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
        .scrollDismissesKeyboard(.interactively)
    }

    private var emptyState: some View {
        ZStack {
            Color.clear
                .contentShape(Rectangle())
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .onTapGesture {
                    isSearchFieldFocused = false
                }
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
