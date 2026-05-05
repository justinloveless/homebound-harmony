import SwiftUI

// Top-level routing based on AppState.authState.

struct RootView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            switch appState.authState {
            case .checking:
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

            case .unauthenticated:
                LoginView()

            case .needsUnlock(let email):
                UnlockView(email: email)

            case .authenticated:
                MainTabView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: appState.authState)
    }
}

// MARK: - Main tab bar (shown when authenticated)

struct MainTabView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label("Today", systemImage: "calendar.day.timeline.left") }

            ScheduleView()
                .tabItem { Label("Schedule", systemImage: "calendar") }

            ClientListView()
                .tabItem { Label("Clients", systemImage: "person.2") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gear") }
        }
        .tint(.blue)
        // Refresh when app comes to foreground so we pick up web-app changes.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            Task { await appState.refreshWorkspace() }
        }
    }
}
