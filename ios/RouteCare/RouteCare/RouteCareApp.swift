//
//  RouteCareApp.swift
//  RouteCare
//
//  Created by Justin Noel Loveless on 5/5/26.
//

import SwiftUI

@main
struct RouteCareApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .task { await appState.checkAuthState() }
        }
    }
}
