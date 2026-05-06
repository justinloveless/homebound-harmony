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

}
