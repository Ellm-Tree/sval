// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

private func tab(_ id: String, in workspace: String, _ name: String, _ url: String) -> OutlineRow {
    OutlineRow(id: id, parentId: workspace, depth: 1, kind: "tab", name: name, url: url, icon: nil, local: false,
               emoji: nil, label: nil, color: nil, transparency: nil, pinned: false, agent: nil,
               agentDevice: nil, device: nil, isolated: false, shares: nil)
}

private func favorite(_ guid: String, _ name: String, _ url: String, contentAt: Double = 0) -> Favorite {
    Favorite(id: "f-\(guid)", kind: "favorite", guid: guid, parent: nil, name: name, url: url, marked: false,
             pinScope: nil, local: false, added: nil, contentAt: contentAt)
}

private func page(_ title: String, _ url: String, frecency: Double) -> HistoryPage {
    HistoryPage(url: url, title: title, lastVisit: 0, frecency: frecency)
}

/// What the Launcher offers for what was typed, section by section, as
/// the desktop's Launcher lists it (launcher spec §5).
@MainActor
final class LauncherResultsTests: XCTestCase {
    /// The user's Workspace in front, w1, another, w2, and the private
    /// session's, p.
    private let rows = [
        tab("front", in: "w1", "Reading Now", "https://now.example/reading"),
        // Matches in its address alone: a weak match.
        tab("queue", in: "w1", "Queue", "https://example.com/reading-list"),
        tab("club", in: "w2", "Reading Club", "https://club.example/"),
        tab("old", in: "w1", "Old Reading", "https://old.example/"),
        tab("secret", in: "p", "Reading Secret", "https://secret.example/"),
        tab("picker", in: "w1", "Reading", splitPickAddress),
        tab("notes", in: "w1", "Notes", "https://notes.example/"),
    ]
    private let used: [String: Double] = ["queue": 10, "old": 5, "club": 20, "notes": 1]
    private let pins = [PinRow(id: "w1/g1", guid: "g1", kind: "favorite", name: "Reading Pin",
                               url: "https://pin.example/reading", local: false, folder: nil, scope: nil)]
    private let favorites = [
        favorite("g1", "Reading Pin", "https://pin.example/reading"),
        favorite("g2", "Reading Fav", "https://fav.example/"),
        favorite("g4", "Reading Two", "https://two.example/"),
        favorite("g5", "Reading Script", "javascript:void(0)"),
        favorite("g6", "Shopping list", "https://shop.example/"),
    ]
    private let history = [
        page("Spreading", "https://x.example/spreading", frecency: 500),
        page("Reading Blog", "https://blog.example/", frecency: 100),
        page("Reading Club", "https://club.example/", frecency: 90),
        page("Reading Fav", "https://fav.example/", frecency: 80),
        page("Other", "https://two.example/", frecency: 1000),
        page("Wish list", "https://wish.example/", frecency: 10),
    ]

    private func input(inPrivate: Bool = false, currentPin: String? = nil,
                       settings: [String: Any] = [:]) -> LauncherResults.Input {
        let workspace: [String: String] = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.parentId!) })
        let used = used
        return LauncherResults.Input(
            rows: rows, isPrivate: { workspace[$0] == "p" }, workspaceOf: { workspace[$0] },
            inPrivate: inPrivate, currentTabId: inPrivate ? nil : "front", workspaceId: inPrivate ? "p" : "w1",
            currentPin: currentPin, lastUsed: { used[$0] }, pins: inPrivate ? [] : pins, favorites: favorites,
            historyPages: history, settings: settings)
    }

    private func results(_ query: String, _ input: LauncherResults.Input? = nil) -> LauncherResults {
        LauncherResults(query: query, input: input ?? self.input())
    }

    func testNothingTypedOffersNothing() {
        let found = results("  ")
        XCTAssertEqual(found.order, [])
        XCTAssertTrue(found.tabs.isEmpty && found.kept.isEmpty && found.history.isEmpty)
    }

    /// Strong matches first, then this Workspace's tabs, then the most
    /// recently used; never the tab in front, a split's picker or a
    /// private tab.
    func testOpenTabsAreRankedAsTheDesktopRanksThem() {
        XCTAssertEqual(results("reading").tabs.map(\.id), ["old", "club", "queue"])
    }

    func testThePrivateSessionSeesOnlyItsOwnTabs() {
        let found = results("reading", input(inPrivate: true))
        XCTAssertEqual(found.tabs.map(\.id), ["secret"])
        XCTAssertTrue(found.kept.isEmpty, "no pins or Favorites")
        XCTAssertTrue(found.history.isEmpty, "no history")
        XCTAssertEqual(found.order, [.tabs])
    }

    /// Pins first, then Favorites by score; the Workspace's own pins are
    /// never offered again as Favorites, and an address the phone can't
    /// open is left out.
    func testPinsComeFirstThenFavoritesByScore() {
        XCTAssertEqual(results("reading").kept.map(\.url),
                       ["https://pin.example/reading", "https://two.example/", "https://fav.example/"])
    }

    func testThePinInFrontIsNotOffered() {
        XCTAssertEqual(results("reading", input(currentPin: "g1")).kept.map(\.url),
                       ["https://two.example/", "https://fav.example/"])
    }

    /// Boundary matches first, then matches anywhere, each by frecency; a
    /// page open as a tab or offered as a Favorite shows once.
    func testHistoryListsBoundaryMatchesFirstAndEachPageOnce() {
        XCTAssertEqual(results("reading").history.map(\.url), ["https://blog.example/", "https://x.example/spreading"])
    }

    func testEachSuggestionSwitchTurnsItsSectionOff() {
        let off: (String) -> LauncherResults = { kind in
            self.results("reading", self.input(settings: ["browser.urlbar.suggest.\(kind)": false]))
        }
        XCTAssertTrue(off("openpage").tabs.isEmpty)
        XCTAssertFalse(off("openpage").order.contains(.tabs))
        XCTAssertTrue(off("bookmark").kept.isEmpty)
        XCTAssertTrue(off("history").history.isEmpty)
        XCTAssertEqual(off("history").order, [.tabs, .favorites])
    }

    func testEachSectionKeepsToItsSyncedLimit() {
        let found = results("reading", input(settings: ["browser.sval.launcher.limit.tabs": 1,
                                                        "browser.sval.launcher.limit.favorites": 0]))
        XCTAssertEqual(found.tabs.map(\.id), ["old"])
        XCTAssertTrue(found.kept.isEmpty)
    }

    func testTheSectionsGoInTheDefaultOrder() {
        XCTAssertEqual(results("list").order, [.tabs, .favorites, .history])
    }

    /// The synced order, the desktop's sections the phone lacks skipped,
    /// and a section named twice listed once.
    func testTheSectionsFollowTheSyncedOrder() {
        let order = ["browser.sval.launcher.order": "history,commands,favorites,history,tabs"]
        let found = results("list", input(settings: order))
        XCTAssertEqual(found.tabs.map(\.id), ["queue"], "a match in the address alone is weak")
        XCTAssertEqual(found.order, [.history, .favorites, .tabs])
    }

    func testAStrongTabMatchMovesOpenTabsFirst() {
        let order = ["browser.sval.launcher.order": "history,favorites,tabs"]
        XCTAssertEqual(results("reading", input(settings: order)).order, [.tabs, .history, .favorites])
    }
}

/// The site the Launcher completes what was typed to: history first, as
/// Firefox's origin autofill does, then pins and Favorites.
@MainActor
final class LauncherAutofillTests: XCTestCase {
    private func autofill(_ typed: String, settings: [String: Any] = [:], history: [String] = [],
                          favorites: [Favorite] = []) -> String? {
        LauncherResults.autofill(typed, settings: settings,
                                 historyPages: history.map { page("", $0, frecency: 1) }, favorites: favorites)
            .map { "\($0.text) \($0.url.absoluteString)" }
    }

    func testHistoryCompletesToTheSiteWithoutWww() {
        XCTAssertEqual(autofill("git", history: ["https://www.github.com/sval"]), "github.com/ https://www.github.com/")
        XCTAssertEqual(autofill("www.git", history: ["https://www.github.com/sval"]),
                       "www.github.com/ https://www.github.com/")
    }

    func testHistoryComesBeforeFavorites() {
        XCTAssertEqual(autofill("ex", history: ["https://example.org/"],
                                favorites: [favorite("g", "Example", "https://example.com/")]),
                       "example.org/ https://example.org/")
    }

    func testFavoritesFillWhereHistoryHasNothing() {
        XCTAssertEqual(autofill("ex", history: ["https://other.org/"],
                                favorites: [favorite("g", "Example", "https://example.com/a")]),
                       "example.com/ https://example.com/")
    }

    func testTheBestScoredFavoriteFillsAndHttpsWinsATie() {
        let favorites = [
            favorite("a", "Plain", "http://example.com/"),
            favorite("b", "Secure", "https://example.net/"),
        ]
        XCTAssertEqual(autofill("ex", favorites: favorites), "example.net/ https://example.net/")
        let newer = [favorite("a", "Plain", "http://example.com/", contentAt: 30 * 86_400_000)] + favorites
        XCTAssertEqual(autofill("ex", favorites: newer), "example.com/ http://example.com/")
    }

    func testEachSuggestionSwitchStopsItsSource() {
        let favorites = [favorite("g", "Example", "https://example.com/")]
        XCTAssertEqual(autofill("ex", settings: ["browser.urlbar.suggest.history": false],
                                history: ["https://example.org/"], favorites: favorites),
                       "example.com/ https://example.com/")
        XCTAssertNil(autofill("ex", settings: ["browser.urlbar.suggest.history": false,
                                               "browser.urlbar.suggest.bookmark": false],
                              history: ["https://example.org/"], favorites: favorites))
    }

    func testAPathOrSpaceTypedIsNeverFilled() {
        XCTAssertNil(autofill("example.com/a", history: ["https://example.com/a"]))
        XCTAssertNil(autofill("ex ample", history: ["https://example.com/"]))
        XCTAssertNil(autofill("https:", history: ["https://example.com/"]))
    }

    func testAFavoriteThePhoneCantOpenNeverFills() {
        XCTAssertNil(autofill("ex", favorites: [favorite("g", "Example", "ftp://example.com/")]))
    }
}
