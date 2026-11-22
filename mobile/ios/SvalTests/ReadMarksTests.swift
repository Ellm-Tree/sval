// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// Settings, favorites and pins read only when their document's revision
/// moved, or the Workspaces the pins show in changed, against reading them
/// whole every time.
final class ReadMarksTests: XCTestCase {
    private let device = Data(repeating: 1, count: 16)
    private var now = 1_000.0

    private func apply(_ document: SvalDocument, _ ops: String) {
        now += 1_000
        _ = try? document.applyBatch(opsJson: ops, deviceId: device, now: now)
    }

    /// What a refresh holds.
    private struct Held {
        var settings: [String: Any] = [:]
        var favorites: [Favorite] = []
        var pins: [String: [PinRow]] = [:]
    }

    /// The reads a refresh takes, gated on `marks` as `AppModel.refreshRows`
    /// gates them.
    private func refresh(_ held: inout Held, _ marks: inout ReadMarks, settings: SvalDocument,
                         favorites: SvalDocument, workspaces: [String: Bool]) {
        let revisions = Revisions(workspaces: 0, settings: settings.revision(), favorites: favorites.revision())
        if marks.settingsDue(revisions), marks.keepSettings(at: settings.revision()) {
            held.settings = settings.syncedSettings()
        }
        if marks.favoritesDue(revisions), marks.keepFavorites(at: favorites.revision()) {
            held.favorites = favorites.favoriteRows()
        }
        if marks.pinsDue(revisions, for: workspaces), marks.keepPins(at: favorites.revision(), for: workspaces) {
            held.pins = favorites.pinsAll(workspaces: Array(workspaces.keys))
        }
    }

    private func assertWhole(_ held: Held, settings: SvalDocument, favorites: SvalDocument,
                             workspaces: [String: Bool], _ step: String) {
        XCTAssertTrue(NSDictionary(dictionary: held.settings).isEqual(to: settings.syncedSettings()), step)
        XCTAssertEqual(held.favorites, favorites.favoriteRows(), step)
        XCTAssertEqual(held.pins, favorites.pinsAll(workspaces: Array(workspaces.keys)), step)
    }

    /// After each step of a scripted run, what the gated reads hold equals
    /// a whole read.
    func testTheGatedReadsEqualWholeReads() {
        let settings = SvalDocument(), favorites = SvalDocument()
        let root = favoriteId(guid: "pins________"), mail = favoriteId(guid: "mail00000000")
        var workspaces = ["w1": false]
        var held = Held(), marks = ReadMarks()
        let steps: [(String, () -> Void)] = [
            ("nothing yet", {}),
            ("a setting", { self.apply(settings, #"[{"kind":"setSetting","key":"k","valueJson":"1"}]"#) }),
            ("a refused batch", { self.apply(settings, #"[{"kind":"remove","id":"nope"}]"#) }),
            ("the pins root and a pin", {
                self.apply(favorites, #"""
                    [{"kind":"addFavorite","favoriteKind":"folder","guid":"pins________","name":""},
                     {"kind":"addFavorite","favoriteKind":"favorite","guid":"mail00000000","parent":"\#(root)",
                      "name":"Mail","url":"https://mail.example/"}]
                    """#)
            }),
            ("a second Workspace", { workspaces["w2"] = false }),
            ("the pin kept to one Workspace", {
                self.apply(favorites, #"[{"kind":"setPinScope","id":"\#(mail)","scope":["w2"]}]"#)
            }),
            ("a Workspace becomes an agent's", { workspaces["w2"] = true }),
            ("a setting reset", { self.apply(settings, #"[{"kind":"setSetting","key":"k","valueJson":null}]"#) }),
            ("the pin renamed", { self.apply(favorites, #"[{"kind":"rename","id":"\#(mail)","name":"Post"}]"#) }),
            ("nothing changed", {}),
        ]
        for (name, step) in steps {
            step()
            refresh(&held, &marks, settings: settings, favorites: favorites, workspaces: workspaces)
            assertWhole(held, settings: settings, favorites: favorites, workspaces: workspaces, name)
        }
        XCTAssertEqual(held.pins["w2"]?.map(\.name), ["Post"], "the run reached the pin")
    }

    /// A read older than the one kept is never kept over it.
    func testAnOlderReadIsNotKept() {
        var marks = ReadMarks()
        XCTAssertTrue(marks.keepSettings(at: 3))
        XCTAssertFalse(marks.keepSettings(at: 2))
        XCTAssertTrue(marks.keepSettings(at: 3))
        XCTAssertTrue(marks.keepPins(at: 5, for: ["w1": false]))
        XCTAssertFalse(marks.keepPins(at: 4, for: ["w2": false]))
        XCTAssertTrue(marks.pinsDue(Revisions(workspaces: 0, settings: 3, favorites: 5), for: ["w2": false]))
        XCTAssertFalse(marks.pinsDue(Revisions(workspaces: 0, settings: 3, favorites: 5), for: ["w1": false]))
    }
}
