import SwiftUI

/// Shown when `X-Min-Client-Version` is newer than `ClientVersion.current` or server returns 410 with `minClientVersion`.
struct UpdateRequiredView: View {
    let serverMin: String
    let message: String?

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "arrow.down.app.fill")
                .font(.system(size: 48))
                .foregroundStyle(.blue)
            Text("Update required")
                .font(.title2.bold())
            Text(
                message
                    ?? "This server needs a newer RouteCare build. Install the latest version from the App Store (or TestFlight)."
            )
            .multilineTextAlignment(.center)
            .foregroundStyle(.secondary)
            .padding(.horizontal)
            if !serverMin.isEmpty {
                Text("Required: \(serverMin) · Yours: \(ClientVersion.current)")
                    .font(.footnote.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Link("Open App Store", destination: ClientVersion.appStoreListingURL)
                .font(.headline)
                .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }
}
