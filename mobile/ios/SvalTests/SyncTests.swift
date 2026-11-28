// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

private let current = "history-2026-W46"

private func week(_ number: Int) -> String {
    String(format: "history-2026-W%02d", number)
}

private func shard(_ number: Int, at changedAt: Double) -> HistoryShard {
    HistoryShard(name: week(number), changedAt: changedAt)
}

/// A week this phone changes is written to the shared folder by a later
/// pass, however long that takes (history-sync spec §4.1).
final class UnpublishedWeekTests: XCTestCase {
    func testAWeekChangedHereIsPassedUntilAPassWritesIt() {
        var ledger = HistoryLedger()
        XCTAssertTrue(ledger.changed(week(40)))
        XCTAssertFalse(ledger.changed(week(40)), "a second change finds it unwritten already")
        XCTAssertEqual(ledger.weeks(current: current, kept: [], listed: []), [week(40)])

        ledger.merging(week(40))
        XCTAssertTrue(ledger.passed(week(40), held: false, current: current) { [] }.contains(.unpublished))
        XCTAssertEqual(ledger.weeks(current: current, kept: [], listed: []), [])
    }

    func testAWeekWaitingItsIntervalStaysUnwritten() {
        var ledger = HistoryLedger()
        _ = ledger.changed(week(40))
        ledger.merging(week(40))
        XCTAssertFalse(ledger.passed(week(40), held: true, current: current) { [] }.contains(.unpublished))
        XCTAssertEqual(ledger.weeks(current: current, kept: [], listed: []), [week(40)])
    }

    /// A change made while the pass waits on the folder is in no file the
    /// pass wrote.
    func testAChangeDuringThePassKeepsTheWeekUnwritten() {
        var ledger = HistoryLedger()
        _ = ledger.changed(week(40))
        ledger.merging(week(40))
        _ = ledger.changed(week(40))
        _ = ledger.passed(week(40), held: false, current: current) { [] }
        XCTAssertEqual(ledger.weeks(current: current, kept: [], listed: []), [week(40)])
    }

    func testTheCurrentWeekIsNeverListedTwice() {
        var ledger = HistoryLedger()
        _ = ledger.changed(current)
        XCTAssertEqual(ledger.weeks(current: current, kept: [current], listed: [HistoryShard(name: current, changedAt: 1)]),
                       [])
    }
}

/// A kept week is merged again when its index entry changes, compared
/// with the entry this phone merged, never with this phone's clock.
final class MergedWeekTests: XCTestCase {
    private let kept: Set<String> = Set((39...46).map(week))

    func testAKeptWeekWhoseEntryChangedIsMerged() {
        var ledger = HistoryLedger()
        XCTAssertEqual(ledger.weeks(current: current, kept: kept, listed: [shard(45, at: 100)]), [week(45)])
    }

    func testAMergedWeekIsLeftUntilItsEntryChanges() {
        var ledger = HistoryLedger()
        _ = ledger.weeks(current: current, kept: kept, listed: [shard(45, at: 100)])
        XCTAssertTrue(ledger.passed(week(45), held: false, current: current) { [] }.contains(.mergedAt))
        XCTAssertEqual(ledger.weeks(current: current, kept: kept, listed: [shard(45, at: 100)]), [])
        XCTAssertEqual(ledger.weeks(current: current, kept: kept, listed: [shard(45, at: 200)]), [week(45)])
    }

    /// Another device's clock can be behind this one's: an earlier stamp
    /// is still a change.
    func testAnEarlierStampIsAChangeToo() {
        var ledger = HistoryLedger()
        _ = ledger.weeks(current: current, kept: kept, listed: [shard(45, at: 100)])
        _ = ledger.passed(week(45), held: false, current: current) { [] }
        XCTAssertEqual(ledger.weeks(current: current, kept: kept, listed: [shard(45, at: 50)]), [week(45)])
    }

    /// The bookmark is the entry as the pass read it: one touched during
    /// the pass differs at the next.
    func testTheBookmarkIsTheEntryThePassRead() {
        var ledger = HistoryLedger()
        _ = ledger.weeks(current: current, kept: kept, listed: [shard(45, at: 100)])
        _ = ledger.passed(week(45), held: false, current: current) { [] }
        XCTAssertEqual(ledger.mergedAt[week(45)], 100)
    }

    func testAPassTakesAtMostFourMergedWeeksNewestFirst() {
        var ledger = HistoryLedger()
        let listed = (39...45).reversed().map { shard($0, at: 1) }
        XCTAssertEqual(ledger.weeks(current: current, kept: kept, listed: listed), (42...45).reversed().map(week))
    }

    func testAWeekOutsideTheKeptOnesIsNotMerged() {
        var ledger = HistoryLedger()
        XCTAssertEqual(ledger.weeks(current: current, kept: kept, listed: [shard(30, at: 1)]), [])
    }
}

/// Delete Page reaches every week, from every device, as passes merge
/// them, and is forgotten only once it has.
final class DeletePageTests: XCTestCase {
    private func deleting(done: [String]) -> HistoryLedger {
        var ledger = HistoryLedger()
        ledger.deletions = [HistoryLedger.Deletion(url: "https://example.com/", done: done)]
        return ledger
    }

    func testAPassLoadsTheWeeksADeletePageHasNotReached() {
        var ledger = deleting(done: [week(30)])
        let listed = [shard(31, at: 1), shard(30, at: 1)]
        XCTAssertEqual(ledger.weeks(current: current, kept: [], listed: listed), [week(31)])
    }

    func testAPassLoadsAtMostFourOfThem() {
        var ledger = deleting(done: [])
        let listed = (20...29).reversed().map { shard($0, at: 1) }
        XCTAssertEqual(ledger.weeks(current: current, kept: [], listed: listed), (26...29).reversed().map(week))
    }

    func testEachDeletePageNotInAWeekIsCarriedIntoIt() {
        var ledger = deleting(done: [week(30)])
        ledger.deletions.append(HistoryLedger.Deletion(url: "https://example.org/", done: []))
        XCTAssertEqual(ledger.deletionsNotIn(week(30)), [1])
        XCTAssertEqual(ledger.deletionsNotIn(week(31)), [0, 1])
    }

    func testADeletePageThatReachedEveryWeekGoesWithTheIndexPass() {
        var ledger = deleting(done: [week(30), current])
        _ = ledger.passed(week(30), held: false, current: current) { [week(30)] }
        XCTAssertEqual(ledger.deletions.count, 1, "a week's pass keeps it")
        XCTAssertTrue(ledger.passed(HistoryWeeks.index, held: false, current: current) { [week(30)] }
            .contains(.deletions))
        XCTAssertEqual(ledger.deletions, [])
    }

    /// A week another device published is known from the index alone.
    func testAWeekTheIndexListsKeepsTheDeletePage() {
        var ledger = deleting(done: [week(30), current])
        _ = ledger.passed(HistoryWeeks.index, held: false, current: current) { [week(30), week(31)] }
        XCTAssertEqual(ledger.deletions.count, 1)
    }

    func testAnUnwrittenWeekKeepsTheDeletePage() {
        var ledger = deleting(done: [current])
        _ = ledger.changed(week(30))
        _ = ledger.passed(HistoryWeeks.index, held: false, current: current) { [] }
        XCTAssertEqual(ledger.deletions.count, 1)
    }

    /// The index is another device's writing: an entry that is no week
    /// never holds a Delete Page back.
    func testAnIndexEntryThatIsNoWeekBlocksNothing() {
        var ledger = deleting(done: [week(30), current])
        _ = ledger.passed(HistoryWeeks.index, held: false, current: current) {
            [week(30), HistoryWeeks.index, "notes", ""]
        }
        XCTAssertEqual(ledger.deletions, [])
    }

    func testAWeekLoadedOnlyToDeleteInGoesOnceReached() {
        let window = (39...46).map(week)
        var ledger = deleting(done: [])
        XCTAssertFalse(ledger.unloads(week(30), window: window, current: current))
        ledger.deletions[0].done.append(week(30))
        XCTAssertTrue(ledger.unloads(week(30), window: window, current: current))
        XCTAssertFalse(ledger.unloads(week(40), window: window, current: current), "a kept week stays")
        _ = ledger.changed(week(30))
        XCTAssertFalse(ledger.unloads(week(30), window: window, current: current), "an unwritten week stays")
    }
}

/// This device's own file in the folder is set aside once it has stayed
/// unreadable for ten minutes.
final class OwnFileSetAsideTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testItIsSetAsideAfterTenMinutesUnreadable() {
        var watch = OwnFileWatch()
        XCTAssertFalse(watch.unreadable("workspaces", at: start))
        XCTAssertFalse(watch.unreadable("workspaces", at: start + 599))
        XCTAssertTrue(watch.unreadable("workspaces", at: start + 600))
    }

    func testAReadStartsTheTimeAgain() {
        var watch = OwnFileWatch()
        _ = watch.unreadable("workspaces", at: start)
        watch.clear("workspaces")
        XCTAssertFalse(watch.unreadable("workspaces", at: start + 600))
    }

    /// A pass that stopped at another document saw nothing of this one's
    /// file, and a folder out of reach (`clear(except: nil)`) says nothing
    /// of any.
    func testAPassThatDidNotSeeTheFileStartsTheTimeAgain() {
        var watch = OwnFileWatch()
        _ = watch.unreadable("workspaces", at: start)
        _ = watch.unreadable("settings", at: start)
        watch.clear(except: "settings")
        XCTAssertFalse(watch.unreadable("workspaces", at: start + 600))
        XCTAssertTrue(watch.unreadable("settings", at: start + 600))
        watch.clear(except: nil)
        XCTAssertFalse(watch.unreadable("settings", at: start + 1200))
    }
}

/// A sync key kept from another folder is marked as opening nothing in
/// the one chosen, and the phone joins it (`keyOpens`, `stage`).
final class KeptKeyTests: XCTestCase {
    private let key = Data(repeating: 7, count: 32)
    private let other = Data(repeating: 9, count: 32)

    /// A folder synced with `key`, on disk as the Files connector reads it.
    private func folder(syncedWith key: Data) throws -> Folder {
        let folder = Folder(root: try temporaryDirectory(self))
        let path = try syncPrefix(key: key, workspace: workspacesDocument)
        try folder.write("\(path)/device", Data("x".utf8))
        return folder
    }

    func testTheKeyThatSyncedTheFolderOpensIt() throws {
        XCTAssertTrue(AppModel.keyOpens(try folder(syncedWith: key), key: key))
    }

    func testAKeyFromAnotherFolderOpensNothing() throws {
        XCTAssertFalse(AppModel.keyOpens(try folder(syncedWith: other), key: key))
    }

    func testNoKeyHasNothingToConfirm() throws {
        XCTAssertTrue(AppModel.keyOpens(try folder(syncedWith: other), key: nil))
    }

    func testAFolderOutOfReachNeverCostsTheKey() {
        let folder = MemoryFolder()
        folder.failure = ConnectorError.Unreachable(message: "")
        XCTAssertTrue(AppModel.keyOpens(folder, key: key))
    }

    func testAnUnconfirmedKeyJoinsTheFolder() {
        XCTAssertEqual(AppModel.stage(hasKey: true, keyUnconfirmed: true, holdsSval: true), .join)
        XCTAssertEqual(AppModel.stage(hasKey: true, keyUnconfirmed: false, holdsSval: true), .ready)
    }

    func testWithoutAKeyAFolderWithSvalIsJoinedAndAnEmptyOneStarted() {
        XCTAssertEqual(AppModel.stage(hasKey: false, keyUnconfirmed: false, holdsSval: true), .join)
        XCTAssertEqual(AppModel.stage(hasKey: false, keyUnconfirmed: false, holdsSval: false), .start)
    }

    func testAKeptKeyStartsAnEmptyFolder() {
        XCTAssertEqual(AppModel.stage(hasKey: true, keyUnconfirmed: false, holdsSval: false), .start)
        XCTAssertEqual(AppModel.stage(hasKey: true, keyUnconfirmed: true, holdsSval: false), .start)
    }
}
