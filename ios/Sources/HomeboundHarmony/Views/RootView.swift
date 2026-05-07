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

            case .appUpdateRequired(let serverMin, let message):
                UpdateRequiredView(serverMin: serverMin, message: message)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: appState.authState)
        .onReceive(NotificationCenter.default.publisher(for: .appUpdateRequired)) { note in
            appState.handleAppUpdateRequiredNotification(note)
        }
        .onOpenURL { url in
            handleDeepLink(url)
        }
    }

    private func handleDeepLink(_ url: URL) {
        guard url.scheme == "routecare", appState.authState == .authenticated else { return }
        switch url.host {
        case "checkin":
            Task { await appState.checkInWidgetPrimaryAction() }
        case "navigate-next":
            guard let next = appState.nextUnstartedVisitForToday() else { return }
            let raw = UserDefaults.standard.string(forKey: MapsAppPreference.userDefaultsKey) ?? MapsAppPreference.appleMaps.rawValue
            let pref = MapsAppPreference(rawValue: raw) ?? .appleMaps
            MapsNavigation.openDrivingDirections(to: next.client.address, preferredApp: pref)
        default:
            return
        }
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
