//
//  RouteCareTests.swift
//  RouteCareTests
//
//  Created by Justin Noel Loveless on 5/5/26.
//

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
