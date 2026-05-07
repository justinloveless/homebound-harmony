import Foundation

/// Subscribes to `GET /api/events/stream` (SSE `event: update`) and reports new head sequence numbers.
/// Runs on a detached task so `URLSession.bytes` does not block the main actor.
enum EventStreamRunner {

    /// Parse `data: {"seq":N,"hash":"..."}` lines from Hono `streamSSE` output.
    static func parseSeq(from line: String) -> Int? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("data:") else { return nil }
        let jsonPart = trimmed.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = jsonPart.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let seq = obj["seq"] as? Int else { return nil }
        return seq
    }

    /// Long-lived loop: connect, read until disconnect, backoff, repeat. Cancel the returned task to stop.
    static func start(
        isActive: @escaping @Sendable () async -> Bool,
        onRemoteSeq: @escaping @Sendable (Int) async -> Void
    ) -> Task<Void, Never> {
        Task.detached(priority: .utility) {
            while !Task.isCancelled {
                let active = await isActive()
                guard active else {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                do {
                    let req = try APIService.eventsStreamRequest()
                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                        try await Task.sleep(nanoseconds: 2_000_000_000)
                        continue
                    }
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        guard await isActive() else { break }
                        if let seq = parseSeq(from: line) {
                            await onRemoteSeq(seq)
                        }
                    }
                } catch {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                }
            }
        }
    }
}
