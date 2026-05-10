import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState

    @AppStorage("apiBaseURL") private var apiBaseURL = ""
    @State private var email    = ""
    @State private var password = ""
    @State private var totp     = ""
    @State private var isLoading = false
    @State private var errorMsg: String?
    @State private var showServerConfig = false

    private var serverConfigured: Bool {
        let b = apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: b),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil
        else { return false }
        return true
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    serverURLBanner
                        .padding(.top, 8)

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
                            TextField("6-digit code if required", text: $totp)
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
                    .disabled(
                        isLoading || !serverConfigured || email.isEmpty || password.isEmpty
                    )

                    Text("Your schedule and clients sync with your RouteCare workspace.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    Spacer()
                }
                .padding(.horizontal, 24)
            }
            .navigationBarHidden(true)
            .sheet(isPresented: $showServerConfig) {
                ServerConfigView()
            }
        }
    }

    @ViewBuilder
    private var serverURLBanner: some View {
        if !serverConfigured {
            VStack(alignment: .leading, spacing: 10) {
                Label("Server URL required", systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.bold())
                    .foregroundStyle(.orange)
                Text("Set your API base URL before signing in (for example https://192.168.1.10:3000).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Configure Server URL…") { showServerConfig = true }
                    .buttonStyle(.bordered)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        } else {
            Button {
                showServerConfig = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "link")
                        .foregroundStyle(.secondary)
                    Text(apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text("Change")
                        .font(.caption.weight(.semibold))
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
        }
    }

    private func login() {
        errorMsg = nil
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                let trimmedTotp = totp.trimmingCharacters(in: .whitespacesAndNewlines)
                try await appState.login(
                    email: email,
                    password: password,
                    totpCode: trimmedTotp.isEmpty ? nil : trimmedTotp
                )
            } catch APIError.httpError(400, let message) where message == "Missing TOTP code" {
                errorMsg = "Authenticator code is required for this account."
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
