import Foundation

/// Must stay in lockstep with web `src/lib/version.ts` `APP_CLIENT_VERSION` and server `MIN_CLIENT_VERSION`.
enum ClientVersion {
    static let current = "2026.5.6"

    /// Replace with the App Store product URL when the app is listed; search works before then.
    static let appStoreListingURL = URL(string: "https://apps.apple.com/search?term=RouteCare")!

    /// True when the server requires a *newer* client than this build (dotted numeric compare).
    static func isServerMinimumNewer(serverMin: String) -> Bool {
        let trimmed = serverMin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed.compare(current, options: .numeric) == .orderedDescending
    }
}
