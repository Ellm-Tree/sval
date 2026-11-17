// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// Every running hold's end, which the test lets come.
@MainActor
private final class HoldEnd {
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var over = false

    func wait() async {
        guard !over else { return }
        await withCheckedContinuation { waiting.append($0) }
    }

    /// Ends every hold from here on, as the test ends.
    func finish() {
        over = true
        let ended = waiting
        waiting = []
        ended.forEach { $0.resume() }
    }

    /// Ends the holds running, once their timers wait, and lets what
    /// follows run. Every step runs on the main actor, so each yield lets
    /// the timers' next step run first.
    func come() async {
        for _ in 0..<1000 where waiting.isEmpty { await Task.yield() }
        let ended = waiting
        waiting = []
        ended.forEach { $0.resume() }
        for _ in 0..<20 { await Task.yield() }
    }
}

/// A page's title set soon after the last one written waits for its hold
/// and then writes its latest, as the desktop's `SvalTitleHold` does.
@MainActor
final class TitleHoldTests: XCTestCase {
    private let end = HoldEnd()
    private lazy var hold = TitleHold { @MainActor [end] in await end.wait() }

    override func tearDown() async throws {
        end.finish()
    }

    func testTheFirstTitleIsWrittenAtOnce() {
        XCTAssertTrue(hold.admit("t", name: "One"))
        XCTAssertNil(hold.pending["t"])
    }

    func testATitleDuringTheHoldWaitsAndShows() {
        _ = hold.admit("t", name: "One")
        XCTAssertFalse(hold.admit("t", name: "Two"))
        XCTAssertEqual(hold.pending["t"], "Two")
    }

    func testTheLatestTitleIsWrittenWhenTheHoldEnds() async {
        var due: [String] = []
        hold.onDue = { due.append($0) }
        _ = hold.admit("t", name: "One")
        _ = hold.admit("t", name: "Two")
        _ = hold.admit("t", name: "Three")
        await end.come()
        XCTAssertEqual(due, ["t"])
        XCTAssertEqual(hold.take(["t"]), ["t": "Three"])
    }

    /// A title that keeps changing is written once per hold.
    func testAHoldEndingWithATitleStartsAnother() async {
        _ = hold.admit("t", name: "One")
        _ = hold.admit("t", name: "Two")
        await end.come()
        XCTAssertFalse(hold.admit("t", name: "Three"))
    }

    func testAHoldEndingWithNoTitleLetsTheNextGoAtOnce() async {
        var due: [String] = []
        hold.onDue = { due.append($0) }
        _ = hold.admit("t", name: "One")
        await end.come()
        XCTAssertEqual(due, [])
        XCTAssertTrue(hold.admit("t", name: "Two"))
    }

    func testAPageBackOnTheTitleWrittenHoldsNothing() {
        _ = hold.admit("t", name: "One")
        _ = hold.admit("t", name: "Two")
        _ = hold.admit("t", name: nil)
        XCTAssertNil(hold.pending["t"])
    }

    func testEachTabHasItsOwnHold() {
        _ = hold.admit("t", name: "One")
        XCTAssertTrue(hold.admit("u", name: "Other"))
    }

    /// A closed tab, or a tab on a new page, drops what was held and ends
    /// its hold.
    func testForgettingATabDropsItsTitleAndHold() async {
        var due: [String] = []
        hold.onDue = { due.append($0) }
        _ = hold.admit("t", name: "One")
        _ = hold.admit("t", name: "Two")
        hold.forget("t")
        XCTAssertNil(hold.pending["t"])
        await end.come()
        XCTAssertEqual(due, [], "a hold ended early writes nothing")
        XCTAssertTrue(hold.admit("t", name: "Three"))
    }

    /// Sval going to the background, or any edit of the tree, takes every
    /// title held to write it.
    func testTakingWithoutIdsTakesEveryTitle() {
        _ = hold.admit("t", name: "One")
        _ = hold.admit("t", name: "Two")
        _ = hold.admit("u", name: "One")
        _ = hold.admit("u", name: "Other")
        XCTAssertEqual(hold.take(), ["t": "Two", "u": "Other"])
        XCTAssertEqual(hold.pending, [:])
    }

    func testAFailedWriteGivesTitlesBackUnlessANewerCame() {
        _ = hold.admit("t", name: "One")
        _ = hold.admit("t", name: "Two")
        _ = hold.admit("u", name: "One")
        _ = hold.admit("u", name: "Other")
        let taken = hold.take()
        _ = hold.admit("u", name: "Newer")
        hold.putBack(taken)
        XCTAssertEqual(hold.pending, ["t": "Two", "u": "Newer"])
    }
}

/// The title a tab's page writes as it navigates (`navigationName`).
@MainActor
final class NavigationTitleTests: XCTestCase {
    private let end = HoldEnd()
    private lazy var hold = TitleHold { @MainActor [end] in await end.wait() }

    override func tearDown() async throws {
        end.finish()
    }
    private let url = URL(string: "https://example.com/a")!

    private func tab(name: String, url: String?) -> OutlineRow {
        OutlineRow(id: "t", parentId: "ws", depth: 1, kind: "tab", name: name, url: url, icon: nil, local: false,
                   emoji: nil, label: nil, color: nil, transparency: nil, pinned: false, agent: nil,
                   agentDevice: nil, device: nil, isolated: false, shares: nil)
    }

    private func name(_ row: OutlineRow, _ title: String, at url: URL? = nil, holdsBack: Bool = true) -> String? {
        AppModel.navigationName(row, url: url ?? self.url, title: title, holds: hold, holdsBack: holdsBack)
    }

    func testANewPagesTitleGoesWithItsAddressAtOnce() {
        let row = tab(name: "Old", url: "https://example.com/old")
        _ = hold.admit("t", name: "Old")
        _ = hold.admit("t", name: "Held")
        XCTAssertEqual(name(row, "New"), "New")
        XCTAssertNil(hold.pending["t"], "the old page's held title goes")
    }

    func testANewPageWithNoTitleIsNamedByItsAddress() {
        XCTAssertEqual(name(tab(name: "Old", url: "https://example.com/old"), ""), url.absoluteString)
    }

    /// A page put back from its saved state reports its address before its
    /// title.
    func testAnEmptyTitleOnTheSameAddressKeepsTheName() {
        XCTAssertNil(name(tab(name: "Saved", url: url.absoluteString), ""))
    }

    func testThePagesFirstNewTitleIsWrittenAndTheNextHeld() {
        let row = tab(name: "One", url: url.absoluteString)
        XCTAssertEqual(name(row, "Two"), "Two")
        XCTAssertNil(name(row, "Three"))
        XCTAssertEqual(hold.pending["t"], "Three")
    }

    func testTheSameTitleAgainWritesNothing() {
        XCTAssertNil(name(tab(name: "One", url: url.absoluteString), "One"))
    }

    func testAPrivateTabsTitlesAreNeverHeld() {
        let row = tab(name: "One", url: url.absoluteString)
        XCTAssertEqual(name(row, "Two", holdsBack: false), "Two")
        XCTAssertEqual(name(tab(name: "Two", url: url.absoluteString), "Three", holdsBack: false), "Three")
        XCTAssertEqual(hold.pending, [:])
    }
}
