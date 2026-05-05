import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState

    @State private var email    = ""
    @State private var password = ""
    @State private var totp     = ""
    @State private var isLoading = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    // Logo / header
                    VStack(spacing: 8) {
                        Image(systemName: "house.and.flag.fill")
                            .font(.system(size: 56))
                            .foregroundStyle(.blue)
                        Text("Homebound Harmony")
                            .font(.title2.bold())
                        Text("Worker App")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 32)

                    // Form
                    VStack(spacing: 16) {
                        LabeledField("Email") {
                            TextField("you@example.com", text: $email)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.emailAddress)
                        }

                        LabeledField("Password") {
                            SecureField("Password", text: $password)
                        }

                        LabeledField("Authenticator Code") {
                            TextField("6-digit code", text: $totp)
                                .keyboardType(.numberPad)
                        }
                    }

                    if let msg = errorMsg {
                        Text(msg)
                            .foregroundStyle(.red)
                            .font(.footnote)
                            .multilineTextAlignment(.center)
                    }

                    Button(action: login) {
                        Group {
                            if isLoading {
                                ProgressView()
                                    .progressViewStyle(.circular)
                                    .tint(.white)
                            } else {
                                Text("Sign In")
                                    .fontWeight(.semibold)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isLoading || email.isEmpty || password.isEmpty || totp.isEmpty)

                    Text("Your data is end-to-end encrypted.\nThe server never sees your schedule.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    Spacer()
                }
                .padding(.horizontal, 24)
            }
            .navigationBarHidden(true)
        }
    }

    private func login() {
        errorMsg = nil
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                try await appState.login(email: email, password: password, totpCode: totp)
            } catch APIError.httpError(401, _) {
                errorMsg = "Invalid credentials or TOTP code."
            } catch APIError.httpError(403, _) {
                errorMsg = "TOTP enrollment incomplete. Use the web app to finish registration."
            } catch APIError.httpError(429, _) {
                errorMsg = "Account locked due to too many failed attempts. Try again in 15 minutes."
            } catch {
                errorMsg = error.localizedDescription
            }
        }
    }
}

// MARK: - Reusable labeled field

struct LabeledField<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content

    init(_ label: String, @ViewBuilder content: @escaping () -> Content) {
        self.label   = label
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fontWeight(.medium)
            content()
                .padding(12)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}
