//
//  EventFixtureTests.swift
//  RouteCareTests
//
//  Loads `specs/event-fixtures/*.json` (shared with web) and asserts Swift `EventReducer.replay`
//  matches `snapshotAfter` — same contract as `src/test/eventFixtures.test.ts`.
//

import Foundation
import Testing
@testable import RouteCare

struct EventFixtureTests {

    private static func fixturesDirectory() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // RouteCareTests
            .deletingLastPathComponent() // RouteCare
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("specs/event-fixtures", isDirectory: true)
    }

    @Test @MainActor func allSharedEventFixturesReplayToSnapshotAfter() throws {
        let dir = Self.fixturesDirectory()
        let urls = try FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        .filter { $0.pathExtension.lowercased() == "json" }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }

        #expect(!urls.isEmpty, "Expected JSON fixtures under \(dir.path)")

        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        for url in urls {
            let data = try Data(contentsOf: url)
            let root = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
            let beforeObj = try #require(root["snapshotBefore"])
            let afterObj = try #require(root["snapshotAfter"])
            let eventsObj = root["events"] as? [Any] ?? []

            let beforeData = try JSONSerialization.data(withJSONObject: beforeObj)
            let afterData = try JSONSerialization.data(withJSONObject: afterObj)
            let snapBefore = try decoder.decode(Workspace.self, from: beforeData)
            let snapAfterExpected = try decoder.decode(Workspace.self, from: afterData)

            let events: [[String: Any]] = try eventsObj.map { item in
                try #require(item as? [String: Any])
            }

            let replayed = try EventReducer.replay(snapBefore, events: events)
            let got = try encoder.encode(replayed)
            let exp = try encoder.encode(snapAfterExpected)
            #expect(
                got == exp,
                "\(url.lastPathComponent): replayed workspace JSON must match snapshotAfter (got \(got.count) bytes vs expected \(exp.count))"
            )
        }
    }
}
