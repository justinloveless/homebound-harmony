//
//  RouteCareTests.swift
//  RouteCareTests
//
//  Created by Justin Noel Loveless on 5/5/26.
//

import Foundation
import Testing
@testable import RouteCare

struct RouteCareTests {

    @Test func copyDayScheduleCopiesVisitsToTargetDay() async throws {
        let worker = WorkerProfile(
            name: "Care Worker",
            homeAddress: "100 Home St",
            homeCoords: nil,
            workingHours: WorkerProfile.WorkingHours(startTime: "08:00", endTime: "17:00"),
            daysOff: [.saturday, .sunday],
            breaks: [],
            schedulingStrategy: .spread
        )
        let client = Client(
            id: "client-1",
            name: "Apple Client",
            address: "1 Apple Way",
            coords: nil,
            visitDurationMinutes: 60,
            visitsPerPeriod: 1,
            period: .week,
            priority: .medium,
            timeWindows: [
                TimeWindow(day: .monday, startTime: "09:00", endTime: "12:00"),
                TimeWindow(day: .tuesday, startTime: "09:00", endTime: "12:00"),
            ],
            notes: "",
            excludedFromSchedule: nil
        )
        let sourceDay = DaySchedule(
            day: .monday,
            date: "2026-05-04",
            visits: [
                ScheduledVisit(
                    clientId: "client-1",
                    startTime: "09:00",
                    endTime: "10:00",
                    travelTimeFromPrev: 15,
                    travelDistanceMiFromPrev: nil,
                    manuallyPlaced: nil
                ),
            ],
            totalTravelMinutes: 30,
            leaveHomeTime: "08:45",
            arriveHomeTime: "10:15"
        )
        let targetDay = DaySchedule(
            day: .tuesday,
            date: "2026-05-05",
            visits: [],
            totalTravelMinutes: 0,
            leaveHomeTime: "08:00",
            arriveHomeTime: "08:00"
        )

        let copiedDay = try #require(copyDaySchedule(
            from: sourceDay,
            to: targetDay,
            worker: worker,
            clients: [client],
            travelTimes: ["client-1|home": 15]
        ))

        #expect(copiedDay.day == .tuesday)
        #expect(copiedDay.date == "2026-05-05")
        #expect(copiedDay.visits.count == 1)
        #expect(copiedDay.visits[0].clientId == "client-1")
        #expect(copiedDay.totalTravelMinutes == 30)
    }

    @Test func generateWeekSchedulePlacesEligibleClient() async throws {
        let worker = makeWorker()
        let client = makeClient(
            id: "client-a",
            timeWindows: [
                TimeWindow(day: .monday, startTime: "09:00", endTime: "12:00")
            ]
        )

        let schedule = generateWeekSchedule(
            worker: worker,
            allClients: [client],
            travelTimes: [:],
            weekStartDate: "2026-05-04"
        )

        #expect(schedule.weekStartDate == "2026-05-04")
        #expect(schedule.days.count == 1)
        #expect(schedule.days.first?.day == .monday)
        #expect(schedule.days.first?.visits.first?.clientId == "client-a")
        #expect(schedule.unmetVisits == nil)
    }

    @Test func generateWeekScheduleSkipsMakeUpDays() async throws {
        let worker = WorkerProfile(
            name: "Care Worker",
            homeAddress: "100 Main St",
            homeCoords: nil,
            workingHours: WorkerProfile.WorkingHours(startTime: "08:00", endTime: "17:00"),
            daysOff: [.saturday, .sunday],
            makeUpDays: [.monday],
            breaks: [],
            schedulingStrategy: .spread
        )
        let client = makeClient(
            id: "c1",
            timeWindows: [
                TimeWindow(day: .monday, startTime: "09:00", endTime: "12:00")
            ]
        )
        let schedule = generateWeekSchedule(
            worker: worker,
            allClients: [client],
            travelTimes: [:],
            weekStartDate: "2026-05-04"
        )
        #expect(!schedule.days.contains { $0.day == .monday })
        #expect(schedule.unmetVisits?.contains { $0.clientId == "c1" } == true)
    }

    @Test func generateWeekScheduleIgnoresExcludedClients() async throws {
        let worker = makeWorker()
        let included = makeClient(
            id: "included",
            timeWindows: [
                TimeWindow(day: .monday, startTime: "09:00", endTime: "12:00")
            ]
        )
        let excluded = makeClient(
            id: "excluded",
            timeWindows: [
                TimeWindow(day: .monday, startTime: "09:00", endTime: "12:00")
            ],
            excludedFromSchedule: true
        )

        let schedule = generateWeekSchedule(
            worker: worker,
            allClients: [included, excluded],
            travelTimes: [:],
            weekStartDate: "2026-05-04"
        )

        let scheduledClientIds = schedule.days.flatMap { $0.visits.map(\.clientId) }
        #expect(scheduledClientIds == ["included"])
        #expect(schedule.recommendedDrops == nil)
    }

    private func makeWorker() -> WorkerProfile {
        WorkerProfile(
            name: "Care Worker",
            homeAddress: "100 Main St",
            homeCoords: nil,
            workingHours: WorkerProfile.WorkingHours(startTime: "08:00", endTime: "17:00"),
            daysOff: [.saturday, .sunday],
            breaks: [],
            schedulingStrategy: .spread
        )
    }

    @Test func eventReducerAppliesClientAddedThenRemoved() throws {
        let base = defaultWorkspace
        let enc = JSONEncoder()
        let client = makeClient(
            id: "c-audit",
            timeWindows: [
                TimeWindow(day: .monday, startTime: "09:00", endTime: "12:00")
            ]
        )
        let clientData = try enc.encode(client)
        let clientObj = try #require(JSONSerialization.jsonObject(with: clientData) as? [String: Any])

        let addEv: [String: Any] = [
            "kind": "client_added",
            "payload": clientObj,
            "clientEventId": "evt-add-1",
            "claimedAt": "2026-01-01T12:00:00.000Z",
        ]
        let mid = try EventReducer.apply(base, event: addEv)
        #expect(mid.clients.contains { $0.id == "c-audit" })

        let removeEv: [String: Any] = [
            "kind": "client_removed",
            "payload": ["id": "c-audit"],
            "clientEventId": "evt-rm-1",
            "claimedAt": "2026-01-01T12:01:00.000Z",
        ]
        let end = try EventReducer.apply(mid, event: removeEv)
        #expect(end.clients.contains { $0.id == "c-audit" } == false)
    }

    @Test func eventReducerScheduleSetNullClearsLastSchedule() throws {
        var ws = defaultWorkspace
        let sched = WeekSchedule(
            weekStartDate: "2026-05-04",
            days: [],
            totalTravelMinutes: 0,
            totalTimeAwayMinutes: 0,
            clientGroups: nil,
            unmetVisits: nil,
            recommendedDrops: nil
        )
        ws.lastSchedule = sched

        let ev: [String: Any] = [
            "kind": "schedule_set",
            "payload": NSNull(),
            "clientEventId": "evt-sch-null",
            "claimedAt": "2026-01-01T00:00:00.000Z",
        ]
        let out = try EventReducer.apply(ws, event: ev)
        #expect(out.lastSchedule == nil)
    }

    @Test func visitRuntimeReplayerRebuildsFromVisitEvents() throws {
        let events: [[String: Any]] = [
            [
                "kind": "visit_started",
                "clientEventId": "a",
                "claimedAt": "2026-05-01T10:00:00Z",
                "payload": [
                    "dayDate": "2026-05-01",
                    "visitIndex": 0,
                    "clientId": "c1",
                    "verifiedArrival": true,
                    "checkedInAt": "2026-05-01T10:00:00Z",
                ],
            ],
            [
                "kind": "visit_note_added",
                "clientEventId": "b",
                "claimedAt": "2026-05-01T10:05:00Z",
                "payload": [
                    "dayDate": "2026-05-01",
                    "visitIndex": 0,
                    "clientId": "c1",
                    "note": "First note",
                ],
            ],
            [
                "kind": "visit_completed",
                "clientEventId": "c",
                "claimedAt": "2026-05-01T11:00:00Z",
                "payload": [
                    "dayDate": "2026-05-01",
                    "visitIndex": 0,
                    "clientId": "c1",
                    "completedAt": "2026-05-01T11:00:00Z",
                ],
            ],
        ]
        let states = VisitRuntimeReplayer.buildStates(from: events)
        #expect(states.count == 1)
        let s = try #require(states.first)
        #expect(s.dayDate == "2026-05-01")
        #expect(s.visitIndex == 0)
        #expect(s.clientId == "c1")
        #expect(s.verifiedArrival == true)
        #expect(s.completedAt != nil)
        #expect(s.visitNote == "First note")
    }

    @Test func eventReducerReplayMatchesSequentialApply() throws {
        let base = defaultWorkspace
        let enc = JSONEncoder()
        let client = makeClient(
            id: "c-replay",
            timeWindows: [TimeWindow(day: .tuesday, startTime: "10:00", endTime: "11:00")]
        )
        let clientObj = try #require(
            JSONSerialization.jsonObject(with: try enc.encode(client)) as? [String: Any]
        )
        let events: [[String: Any]] = [
            [
                "kind": "client_added",
                "payload": clientObj,
                "clientEventId": "r1",
                "claimedAt": "2026-01-01T00:00:00.000Z",
            ],
            [
                "kind": "client_removed",
                "payload": ["id": "c-replay"],
                "clientEventId": "r2",
                "claimedAt": "2026-01-01T00:00:01.000Z",
            ],
        ]
        let sequential = try events.reduce(base) { try EventReducer.apply($0, event: $1) }
        let replayed = try EventReducer.replay(base, events: events)
        #expect(sequential.clients.count == replayed.clients.count)
    }

    private func makeClient(
        id: String,
        timeWindows: [TimeWindow],
        excludedFromSchedule: Bool? = nil
    ) -> Client {
        Client(
            id: id,
            name: id,
            address: "200 Main St",
            coords: nil,
            visitDurationMinutes: 30,
            visitsPerPeriod: 1,
            period: .week,
            priority: .medium,
            timeWindows: timeWindows,
            notes: "",
            excludedFromSchedule: excludedFromSchedule
        )
    }

}
