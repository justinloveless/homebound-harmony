import Foundation

/// Rebuilds `VisitRuntimeState` rows from decrypted audit events (`visit_started`, `visit_completed`, `visit_note_added`).
/// Events must be in server `seq` order.
enum VisitRuntimeReplayer {

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601Basic: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func parseInstant(_ s: String) -> Date? {
        iso8601.date(from: s) ?? iso8601Basic.date(from: s)
    }

    private static func intValue(_ any: Any?) -> Int? {
        if let i = any as? Int { return i }
        if let d = any as? Double { return Int(d) }
        if let n = any as? NSNumber { return n.intValue }
        return nil
    }

    static func buildStates(from events: [[String: Any]]) -> [VisitRuntimeState] {
        var byKey: [String: VisitRuntimeState] = [:]

        for ev in events {
            guard let kind = ev["kind"] as? String,
                  let payload = ev["payload"] as? [String: Any] else { continue }

            switch kind {
            case "visit_started":
                guard let dayDate = payload["dayDate"] as? String,
                      let visitIndex = intValue(payload["visitIndex"]),
                      let clientId = payload["clientId"] as? String,
                      let checkedStr = payload["checkedInAt"] as? String,
                      let checkedInAt = parseInstant(checkedStr) else { continue }
                let verified = payload["verifiedArrival"] as? Bool ?? false
                let key = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)
                let prior = byKey[key]
                byKey[key] = VisitRuntimeState(
                    visitKey: key,
                    dayDate: dayDate,
                    visitIndex: visitIndex,
                    clientId: clientId,
                    checkedInAt: checkedInAt,
                    verifiedArrival: verified,
                    completedAt: prior?.completedAt,
                    visitNote: prior?.visitNote
                )

            case "visit_completed":
                guard let dayDate = payload["dayDate"] as? String,
                      let visitIndex = intValue(payload["visitIndex"]),
                      let clientId = payload["clientId"] as? String,
                      let completedStr = payload["completedAt"] as? String,
                      let completedAt = parseInstant(completedStr) else { continue }
                let key = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)
                if var existing = byKey[key] {
                    existing.completedAt = completedAt
                    byKey[key] = existing
                } else {
                    byKey[key] = VisitRuntimeState(
                        visitKey: key,
                        dayDate: dayDate,
                        visitIndex: visitIndex,
                        clientId: clientId,
                        checkedInAt: completedAt,
                        verifiedArrival: false,
                        completedAt: completedAt,
                        visitNote: nil
                    )
                }

            case "visit_note_added":
                guard let dayDate = payload["dayDate"] as? String,
                      let visitIndex = intValue(payload["visitIndex"]),
                      let clientId = payload["clientId"] as? String,
                      let note = payload["note"] as? String else { continue }
                let key = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)
                let claimedAt = (ev["claimedAt"] as? String).flatMap { parseInstant($0) } ?? Date(timeIntervalSince1970: 0)
                if var existing = byKey[key] {
                    let merged = [existing.visitNote, note]
                        .compactMap { $0 }
                        .filter { !$0.isEmpty }
                        .joined(separator: "\n")
                    existing.visitNote = merged.isEmpty ? nil : merged
                    byKey[key] = existing
                } else {
                    byKey[key] = VisitRuntimeState(
                        visitKey: key,
                        dayDate: dayDate,
                        visitIndex: visitIndex,
                        clientId: clientId,
                        checkedInAt: claimedAt,
                        verifiedArrival: false,
                        completedAt: nil,
                        visitNote: note
                    )
                }

            case "evv_check_in":
                guard let dayDate = payload["dayDate"] as? String,
                      let visitIndex = intValue(payload["visitIndex"]),
                      let clientId = payload["clientId"] as? String,
                      let evvVisitId = payload["evvVisitId"] as? String else { continue }
                let claimedAt = (ev["claimedAt"] as? String).flatMap { parseInstant($0) } ?? Date()
                let key = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)
                let prior = byKey[key]
                var state = VisitRuntimeState(
                    visitKey: key,
                    dayDate: dayDate,
                    visitIndex: visitIndex,
                    clientId: clientId,
                    checkedInAt: claimedAt,
                    verifiedArrival: true,
                    completedAt: prior?.completedAt,
                    visitNote: prior?.visitNote
                )
                state.evvVisitId = evvVisitId
                byKey[key] = state

            case "evv_check_out":
                guard let evvVisitId = payload["evvVisitId"] as? String else { continue }
                let dayDate = payload["dayDate"] as? String
                let visitIndex = intValue(payload["visitIndex"])
                let completedAt = (ev["claimedAt"] as? String).flatMap { parseInstant($0) } ?? Date()

                if let dayDate, let visitIndex {
                    let key = VisitKey.make(dayDate: dayDate, visitIndex: visitIndex)
                    if var existing = byKey[key] {
                        existing.completedAt = completedAt
                        byKey[key] = existing
                    }
                } else {
                    if let key = byKey.first(where: { $0.value.evvVisitId == evvVisitId })?.key {
                        byKey[key]?.completedAt = completedAt
                    }
                }

            default:
                break
            }
        }

        return byKey.values.sorted { $0.checkedInAt < $1.checkedInAt }
    }
}
