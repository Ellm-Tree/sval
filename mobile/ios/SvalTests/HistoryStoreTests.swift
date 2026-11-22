// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// History kept by address and by week, against the pages made from every
/// visit at once.
final class HistoryStoreTests: XCTestCase {
    private let day = 86_400_000.0

    private func visit(_ id: String, _ url: String, title: String, day at: Double, _ transition: UInt32) -> Visit {
        let json = #"{"id":"\#(id)","url":"\#(url)","title":"\#(title)","visitedAt":\#(at * day),"transition":\#(transition),"device":"00"}"#
        return try! JSONDecoder().decode(Visit.self, from: Data(json.utf8))
    }

    /// A fixed sequence of numbers, so every run takes the same steps.
    private struct Steps {
        var state: UInt64
        mutating func next(_ below: Int) -> Int {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((state >> 33) % UInt64(below))
        }
    }

    /// After every step of visits added, retitled and removed, weeks
    /// loaded and let go, and weeks read again unchanged, the pages kept
    /// equal the pages of every visit.
    func testThePagesKeptEqualThePagesOfEveryVisit() {
        var steps = Steps(state: 7)
        var weeks: [String: [Visit]] = ["w1": []]
        var reads: [String: Int] = ["w1": 1]
        var read = 1
        var store = HistoryStore()
        var made = 0
        var most = 0
        let transitions: [UInt32] = [1, 1, 2, 3, 4, 0, 7, 9]
        for step in 0..<600 {
            let names = weeks.keys.sorted()
            let name = names[steps.next(names.count)]
            var changed = true
            switch steps.next(10) {
            case 0...3:
                made += 1
                weeks[name]!.append(visit("v\(made)", "https://site\(steps.next(15)).example/", title: "T\(steps.next(4))",
                                          day: Double(100 + steps.next(40)) + Double(steps.next(2)) / 2,
                                          transitions[steps.next(transitions.count)]))
            case 4 where !weeks[name]!.isEmpty:
                let at = steps.next(weeks[name]!.count)
                let old = weeks[name]![at]
                weeks[name]![at] = visit(old.id, old.url, title: "Retitled \(step)", day: old.visitedAt / day,
                                         old.transition)
            case 5 where !weeks[name]!.isEmpty:
                weeks[name]!.remove(at: steps.next(weeks[name]!.count))
            case 6 where weeks.count < 6:
                weeks["w\(step)"] = []
                read += 1
                reads["w\(step)"] = read
                changed = false
            case 7 where weeks.count > 1:
                weeks[name] = nil
                reads[name] = nil
            case 8:
                // The same visits under a new read, as when the listing
                // differs in what no visit carries.
                changed = false
            default:
                continue
            }
            if weeks[name] != nil {
                read += 1
                reads[name] = read
            }
            let loaded = weeks.reduce(into: [String: HistoryWeek]()) {
                $0[$1.key] = HistoryWeek(read: reads[$1.key]!, visits: $1.value)
            }
            let before = store.pages
            let reported = store.update(loaded)
            let all = weeks.values.flatMap { $0 }
            XCTAssertEqual(store.pages, HistoryPage.pages(all), "step \(step)")
            XCTAssertEqual(store.visitCount, all.count)
            XCTAssertEqual(reported, store.pages != before, "step \(step)")
            if !changed { XCTAssertFalse(reported, "step \(step)") }
            XCTAssertFalse(store.update(loaded), "step \(step) read again")
            most = max(most, store.pages.count)
        }
        XCTAssertGreaterThan(most, 10)
    }

    /// A week is decoded again exactly when the engine lists it otherwise,
    /// and its visits are always the listing's.
    func testAWeekIsReadAgainWhenItsListingMoves() throws {
        let document = SvalDocument()
        let device = Data(repeating: 1, count: 16)
        var reads = WeekReads()
        func decoded() throws -> [Visit] {
            try JSONDecoder().decode([Visit].self, from: Data(try document.visitsJson().utf8))
        }
        func apply(_ ops: [[String: Any]], at now: Double) throws {
            let json = try JSONSerialization.data(withJSONObject: ops)
            try document.applyBatch(opsJson: String(decoding: json, as: UTF8.self), deviceId: device, now: now)
        }
        var last = reads.visits(of: "w", in: document)
        XCTAssertEqual(last.visits, try decoded())
        let edits: [[[String: Any]]] = [
            [["kind": "addVisit", "url": "https://a.example/", "title": "A", "transition": 1, "visitedAt": 1_000.0]],
            [["kind": "addVisit", "url": "https://b.example/", "title": "", "transition": 2, "visitedAt": 2_000.0]],
            [["kind": "setVisitTitle", "id": try visitId(deviceId: device, url: "https://b.example/", visitedAt: 2_000),
              "title": "B"]],
            [["kind": "remove", "id": try visitId(deviceId: device, url: "https://a.example/", visitedAt: 1_000)]],
        ]
        for (n, ops) in edits.enumerated() {
            try apply(ops, at: Double(10_000 + n))
            let week = reads.visits(of: "w", in: document)
            XCTAssertNotEqual(week.read, last.read, "edit \(n)")
            XCTAssertEqual(week.visits, try decoded(), "edit \(n)")
            let again = reads.visits(of: "w", in: document)
            XCTAssertEqual(again.read, week.read, "edit \(n) read again")
            last = week
        }
        reads.keep(only: [])
        XCTAssertNotEqual(reads.visits(of: "w", in: document).read, last.read)
    }
}
