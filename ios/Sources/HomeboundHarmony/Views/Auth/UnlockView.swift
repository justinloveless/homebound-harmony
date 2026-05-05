import SwiftUI

// Shown when the session cookie is still valid but the workspace key is not
// in memory (e.g., after the app is terminated and reopened). The user only
// needs their password — no TOTP required since the session is active.

struct UnlockView: View {
    @Environment(AppState.self) private var appState
    let email: String

    @State private var password  = ""
    @State private var isLoading = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer()

                VStack(spacing: 8) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(.blue)
                    Text("Unlock")
                        .font(.title2.bold())
                    Text(email)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 16) {
                    LabeledField("Password") {
                        SecureField("Enter your password", text: $password)
                    }

                    if let msg = errorMsg {
                        Text(msg)
                            .foregroundStyle(.red)
                            .font(.footnote)
                            .multilineTextAlignment(.center)
                    }

                    Button(action: unlock) {
                        Group {
                            if isLoading {
                                ProgressView()
                                    .progressViewStyle(.circular)
                                    .tint(.white)
                            } else {
                                Text("Unlock")
                                    .fontWeight(.semibold)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isLoading || password.isEmpty)
                }

                Button("Sign in with a different account") {
                    Task { await appState.logout() }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)

                Spacer()
            }
            .padding(.horizontal, 28)
            .navigationBarHidden(true)
        }
    }

    private func unlock() {
        errorMsg  = nil
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                try await appState.unlock(password: password)
            } catch AppError.wrongPassword {
                errorMsg = "Incorrect password. Try again."
                password = ""
            } catch {
                errorMsg = error.localizedDescription
            }
        }
    }
}
