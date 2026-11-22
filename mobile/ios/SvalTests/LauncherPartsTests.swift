// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The Launcher's index built part by part, against the index built whole
/// from the same inputs.
@MainActor
final class LauncherPartsTests: XCTestCase {
    private func tab(_ id: String, in workspace: String, _ name: String, _ url: String) -> OutlineRow {
        OutlineRow(id: id, parentId: workspace, depth: 1, kind: .tab, name: name, url: url, icon: nil, local: false,
                   emoji: nil, label: nil, color: nil, transparency: nil, pinned: false, agent: nil,
                   agentDevice: nil, device: nil, isolated: false, shares: nil)
    }

    private func favorite(_ guid: String, _ name: String, _ url: String) -> Favorite {
        Favorite(id: "f-\(guid)", kind: "favorite", guid: guid, parent: nil, name: name, url: url, marked: false,
                 pinScope: nil, local: false, added: nil, contentAt: 0)
    }

    private func pin(_ guid: String, _ name: String, _ url: String) -> PinRow {
        PinRow(id: "w1/\(guid)", guid: guid, kind: "favorite", name: name, url: url, local: false, folder: nil,
               scope: nil)
    }

    private func assertSame(_ split: LauncherIndex, _ whole: LauncherIndex, _ step: String) {
        XCTAssertEqual(split.generation, whole.generation, step)
        XCTAssertEqual(split.settings, whole.settings, step)
        XCTAssertEqual(split.tabs, whole.tabs, step)
        XCTAssertEqual(split.tabURLs, whole.tabURLs, step)
        XCTAssertEqual(split.pins, whole.pins, step)
        XCTAssertEqual(split.pinGuids, whole.pinGuids, step)
        XCTAssertEqual(split.favorites, whole.favorites, step)
        XCTAssertEqual(split.favoriteSites, whole.favoriteSites, step)
        XCTAssertEqual(split.history.pages, whole.history.pages, step)
        XCTAssertEqual(split.history.frecency, whole.history.frecency, step)
        XCTAssertEqual(split.history.sites, whole.history.sites, step)
    }

    /// After every change to the tabs, pins, Favorites, history and
    /// settings, one at a time and several at once, the index built part by
    /// part equals the index built whole.
    func testThePartsEqualTheWholeAfterEachChange() {
        var rows = [
            tab("a", in: "w1", "Alpha", "https://alpha.example/"),
            tab("b", in: "w1", "Beta", "https://beta.example/"),
            tab("c", in: "w2", "Gamma", "https://gamma.example/"),
            tab("pick", in: "w1", "Pick", splitPickAddress),
            tab("note", in: "w2", "Notes", "about:blank"),
        ]
        var titles: [String: String] = [:]
        var privateIds: Set<String> = []
        var pins: [String: [PinRow]] = ["w1": [pin("g1", "Pinned", "https://pin.example/")]]
        var favorites = [favorite("g1", "Pinned", "https://pin.example/"), favorite("g2", "Fav", "https://fav.example/")]
        var pages: [HistoryPage] = []
        var settings: [String: Any] = [:]
        var changes: [(String, () -> Void)] = [
            ("nothing", {}),
            ("a title", { titles["a"] = "Alpha Two" }),
            ("a tab added", { rows.append(self.tab("d", in: "w2", "Delta", "https://delta.example/")) }),
            ("a tab moved", {
                if let at = rows.firstIndex(where: { $0.id == "b" }) {
                    rows[at] = self.tab("b", in: rows[at].parentId == "w1" ? "w2" : "w1", "Beta", "https://beta.example/")
                }
            }),
            ("a tab removed", { if !rows.isEmpty { rows.remove(at: 0) } }),
            ("a tab's address", {
                if let first = rows.first {
                    rows[0] = self.tab(first.id, in: first.parentId ?? "w1", first.name, "https://moved.example/")
                }
            }),
            ("a tab made private", { privateIds.insert("c") }),
            ("the tabs reordered", { rows.reverse() }),
            ("a favorite added", { favorites.append(self.favorite("g3", "Third", "http://third.example/")) }),
            ("a favorite renamed", { favorites = favorites.map { $0.guid == "g2" ? self.favorite("g2", "Fav Two", "https://fav.example/") : $0 } }),
            ("a pin added", { pins["w2"] = [self.pin("g3", "Third", "http://third.example/")] }),
            ("history visited", {
                pages = [HistoryPage(url: "https://fav.example/", title: "Fav", lastVisit: 1, frecency: 900),
                         HistoryPage(url: "https://third.example/", title: "T", lastVisit: 1, frecency: 50)]
            }),
            ("history's scores", {
                pages = [HistoryPage(url: "http://third.example/", title: "T", lastVisit: 2, frecency: 2000)] + pages
            }),
            ("a setting", { settings["browser.urlbar.suggest.history"] = false }),
            ("the order setting", { settings["browser.sval.launcher.order"] = "history,tabs" }),
            ("everything at once", {
                titles["b"] = "Beta Two"
                rows.append(self.tab("e", in: "w1", "Epsilon", "https://epsilon.example/"))
                if !favorites.isEmpty { favorites.removeFirst() }
                pins["w1"] = []
                if !pages.isEmpty { pages.removeLast() }
                settings["browser.sval.launcher.limit.tabs"] = 2
            }),
            ("a tab's title put back", { titles["a"] = nil }),
            ("every tab closed", { rows = [] }),
        ]
        // The same changes again, in the other order, from where the first
        // round left the inputs.
        changes += changes.reversed().map { ($0.0 + " again", $0.1) }
        var parts = LauncherParts()
        for (generation, change) in changes.enumerated() {
            change.1()
            let tabs = rows.map { row in
                (row: row, title: titles[row.id] ?? row.name, workspace: row.parentId,
                 isPrivate: privateIds.contains(row.id))
            }
            let history = LauncherIndex.History(pages)
            let split = parts.index(
                generation: generation,
                tabs: tabs.map { LauncherIndex.TabInput(row: $0.row, title: $0.title, workspace: $0.workspace,
                                                        isPrivate: $0.isPrivate) },
                pins: pins, favorites: favorites, history: history, settings: .init(settings))
            let whole = LauncherIndex(generation: generation, tabs: tabs, pins: pins, favorites: favorites,
                                      history: history, settings: .init(settings))
            assertSame(split, whole, change.0)
        }
    }
}
