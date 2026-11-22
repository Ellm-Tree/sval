// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Observation
import UIKit
import XCTest
@testable import Sval

/// The whole app model, wired as the app runs it, against another device
/// on the same shared folder: what the tree shows after an edit or a pass,
/// which tab is in front, which pages live and what the blocker builds.
@MainActor
final class AppModelTests: AppModelTestCase {
    /// The other device's Workspace and its three tabs, at addresses no
    /// page loads.
    private struct Desk {
        let workspace = AppHarness.id()
        let tabs = [AppHarness.id(), AppHarness.id(), AppHarness.id()]
    }

    private let blank = "about:blank"

    private func peerMakes(_ desk: Desk) async throws {
        var ops: [[String: Any]] = [["kind": "addWorkspace", "name": "Desk", "id": desk.workspace]]
        for (n, tab) in desk.tabs.enumerated() {
            ops.append(["kind": "addTab", "parent": desk.workspace, "name": "Tab \(n)", "url": blank, "id": tab])
        }
        try await harness.peerEdits(ops)
    }

    /// The phone, launched on a folder that holds `desk`.
    private func launched(with desk: Desk) async throws -> AppModel {
        try await peerMakes(desk)
        return try await harness.launch()
    }

    private func assertShowsWhole(_ model: AppModel, _ step: String, file: StaticString = #filePath,
                                  line: UInt = #line) throws {
        XCTAssertEqual(model.rows, try harness.savedRows(), step, file: file, line: line)
    }

    /// A rename shows in the tree as soon as it is made: the user never
    /// sees the old name come back while the pass that carries it runs.
    func testAnEditShowsAtOnce() async throws {
        let desk = Desk()
        let model = try await launched(with: desk)
        let tab = try XCTUnwrap(model.row(desk.tabs[0]))
        await model.rename(tab, to: "Renamed here")
        XCTAssertEqual(model.row(tab.id)?.title, "Renamed here")
        try assertShowsWhole(model, "after the rename")
    }

    /// What another device does to the tree shows on the phone after one
    /// pass: its renames, new tabs, closes and moves.
    func testAnotherDevicesChangesArriveWithAPass() async throws {
        let desk = Desk()
        let model = try await launched(with: desk)
        let added = AppHarness.id()
        let steps: [(String, [[String: Any]], (AppModel) -> Bool)] = [
            ("a rename", [["kind": "rename", "id": desk.workspace, "name": "Office"]],
             { $0.row(desk.workspace)?.name == "Office" }),
            ("a new tab", [["kind": "addTab", "parent": desk.workspace, "name": "New", "url": blank, "id": added]],
             { $0.row(added)?.parentId == desk.workspace }),
            ("a close", [["kind": "remove", "id": desk.tabs[1]]], { $0.row(desk.tabs[1]) == nil }),
            ("a move", [["kind": "moveNode", "id": desk.tabs[2], "newParent": desk.workspace, "before": added]],
             { $0.children(of: desk.workspace).map(\.id).suffix(2) == [added, desk.tabs[2]] }),
        ]
        for (step, ops, shows) in steps {
            try await harness.peerEdits(ops)
            await harness.pass()
            XCTAssertTrue(shows(model), step)
            try assertShowsWhole(model, step)
        }
    }

    /// A tab the user has in front stays open when another device closes
    /// it, and comes back on that device too.
    func testTheTabInFrontIsKept() async throws {
        let desk = Desk()
        let model = try await launched(with: desk)
        let front = desk.tabs[1]
        model.browser.select(front)
        try await harness.peerEdits([["kind": "remove", "id": front]])
        await harness.pass()
        XCTAssertEqual(model.row(front)?.parentId, desk.workspace)
        XCTAssertEqual(model.browser.currentTabId, front)
        try assertShowsWhole(model, "after the pass")
        await harness.pass()
        try await harness.peerSyncs()
        let peerRows = await harness.peer.outline()
        XCTAssertTrue(peerRows.contains { $0.id == front }, "the other device has the tab again")
    }

    /// A tab another device closes takes its page here with it, and the
    /// page in front stays as it is.
    func testAClosedTabsPageGoes() async throws {
        let desk = Desk()
        let model = try await launched(with: desk)
        let behind = desk.tabs[0], front = desk.tabs[1]
        model.browser.select(behind)
        model.browser.select(front)
        let page = try XCTUnwrap(model.browser.currentPage())
        XCTAssertTrue(model.browser.hasPage(behind))

        try await harness.peerEdits([["kind": "remove", "id": behind]])
        await harness.pass()
        XCTAssertNil(model.row(behind))
        XCTAssertFalse(model.browser.hasPage(behind), "the closed tab's page is gone")
        XCTAssertTrue(model.browser.currentPage() === page)
    }

    /// A setting, a favorite and a pin made on another device reach the
    /// phone, and a pin shown in one Workspace alone shows only there.
    func testSettingsFavoritesAndPinsArrive() async throws {
        let desk = Desk()
        let model = try await launched(with: desk)
        let own = try XCTUnwrap(model.ownWorkspace?.id)
        // The phone made the roots at launch; the other device takes them.
        try await harness.peerSyncs()
        let favorite = AppModel.mintGuid(), pin = AppModel.mintGuid()
        try await harness.peerEdits([["kind": "setSetting", "key": "sval.test.choice", "valueJson": #""there""#]],
                                    in: settingsDocument)
        try await harness.peerEdits([
            ["kind": "addFavorite", "favoriteKind": "favorite", "guid": favorite,
             "parent": favoriteId(guid: "toolbar_____"), "name": "Docs", "url": "https://docs.invalid/"],
            ["kind": "addFavorite", "favoriteKind": "favorite", "guid": pin,
             "parent": favoriteId(guid: AppModel.pinsRoot), "name": "Mail", "url": "https://mail.invalid/"],
            ["kind": "setPinScope", "id": favoriteId(guid: pin), "scope": [desk.workspace]],
        ], in: favoritesDocument)
        await harness.pass()
        XCTAssertEqual(model.settings["sval.test.choice"] as? String, "there")
        XCTAssertEqual(model.favorites.first { $0.guid == favorite }?.name, "Docs")
        XCTAssertEqual(model.pinsByWorkspace[desk.workspace]?.map(\.guid), [pin])
        XCTAssertEqual(model.pinsByWorkspace[own]?.map(\.guid), [], "the pin is kept to the other Workspace")
    }

    /// The blocker builds its rules again when a blocking setting changes,
    /// and does no work for a rename or a setting it doesn't take.
    func testTheBlockerFollowsItsSettings() async throws {
        let desk = Desk()
        let model = try await launched(with: desk)
        let blocker = model.browser.blocker
        let key = { BlockerLists(BlockerInputs(settings: model.settings), in: self.harness.lists,
                                 failedAt: [:], now: .now).key }
        let launchKey = key()
        XCTAssertEqual(blocker.inputsKey, launchKey, "the launch built the rules")

        // A list on disk that the launch's rules weren't made from: a check
        // would build from it.
        try Data("||ads.invalid^".utf8).write(to: harness.lists.appending(path: "sval-easylist.txt"))
        let tab = try XCTUnwrap(model.row(desk.tabs[0]))
        await model.rename(tab, to: "Renamed")
        try await harness.peerEdits([["kind": "setSetting", "key": "browser.sval.launcher.order", "valueJson": #""tabs""#]],
                                    in: settingsDocument)
        await harness.pass()
        await blocker.settled()
        XCTAssertEqual(model.settings["browser.sval.launcher.order"] as? String, "tabs")
        XCTAssertEqual(blocker.inputsKey, launchKey, "no check ran")

        try await harness.peerEdits([["kind": "setSetting", "key": ContentBlocker.levelKey, "valueJson": #""off""#]],
                                    in: settingsDocument)
        await harness.pass()
        await blocker.settled()
        XCTAssertEqual(blocker.inputsKey, key(), "the rules were built from the new level")
        XCTAssertNotEqual(blocker.inputsKey, launchKey)
        XCTAssertTrue(blocker.rules.lists.isEmpty, "Off blocks nothing")
    }

    /// A rename made while a pass's refresh is under way shows as soon as
    /// it returns. The refresh read the tree before the rename landed, so
    /// the rename's own refresh, merged behind it, must run once more.
    func testAnEditDuringARefreshShowsWhenItReturns() async throws {
        let desk = Desk()
        let model = try await launched(with: desk)
        let tab = try XCTUnwrap(model.row(desk.tabs[1]))
        // The phone made the roots at launch; the other device takes them.
        try await harness.peerSyncs()
        // A pass that brings a tree change, a setting and a favorite: its
        // refresh shows the tree, then waits on the settings and the
        // favorites.
        let added = AppHarness.id()
        try await harness.peerEdits([["kind": "addTab", "parent": desk.workspace, "name": "New", "url": blank, "id": added]])
        try await harness.peerEdits([["kind": "setSetting", "key": "sval.test.choice", "valueJson": #""there""#]],
                                    in: settingsDocument)
        try await harness.peerEdits([
            ["kind": "addFavorite", "favoriteKind": "favorite", "guid": AppModel.mintGuid(),
             "parent": favoriteId(guid: "toolbar_____"), "name": "Docs", "url": "https://docs.invalid/"],
        ], in: favoritesDocument)
        var rename: Task<Void, Never>?
        withObservationTracking { _ = model.rows } onChange: {
            // Told as the pass's refresh shows the tree, before it reads
            // the rest: the rename lands while that refresh is under way.
            // Detached, as a tap is, so it carries nothing of the refresh's
            // task.
            rename = Task.detached { await model.rename(tab, to: "Renamed here") }
        }
        await harness.pass()
        let renaming = try XCTUnwrap(rename, "the pass's refresh showed the tree")
        await renaming.value
        XCTAssertEqual(model.row(added)?.parentId, desk.workspace)
        XCTAssertEqual(model.row(tab.id)?.title, "Renamed here", "the rename shows once it returns")
        try assertShowsWhole(model, "after the rename")
    }

    /// Ending the private session leaves nothing of it in the tree.
    func testLeavingThePrivateSessionLeavesNoPrivateRow() async throws {
        let model = try await launched(with: Desk())
        let opened = await model.openPrivateSession()
        let session = try XCTUnwrap(opened)
        let tab = AppHarness.id()
        let added = await model.editTree([["kind": "addTab", "parent": session, "name": "Secret", "url": blank, "id": tab]])
        XCTAssertTrue(added)
        XCTAssertEqual(model.row(tab)?.parentId, session)
        let held = model.privateIds
        await model.endPrivateSession()
        XCTAssertFalse(model.rows.contains { held.contains($0.id) })
        try assertShowsWhole(model, "after the session ended")
    }

    /// A private tab's close keeps nothing to reopen, and a tab that was
    /// private never reopens in the Workspace shown once its session is
    /// gone, where a tab that wasn't private does.
    func testAClosedPrivateTabNeverReopensOutsideItsSession() async throws {
        let model = try await launched(with: Desk())
        let opened = await model.openPrivateSession()
        let session = try XCTUnwrap(opened)
        let tab = AppHarness.id()
        let added = await model.editTree([["kind": "addTab", "parent": session, "name": "Secret", "url": blank, "id": tab]])
        XCTAssertTrue(added)
        let row = try XCTUnwrap(model.row(tab))
        let place = try XCTUnwrap(model.closedPlace(of: row))

        let entry = await model.browser.close(row)
        XCTAssertNil(entry, "a private tab's close keeps no entry")
        XCTAssertTrue(model.browser.recentlyClosed.isEmpty)
        XCTAssertNil(model.privateWorkspace, "closing its last tab ended the session")
        let shown = try XCTUnwrap(model.browser.workspaceId.flatMap(model.row), "a Workspace of the user's is shown")

        let reopened = await model.reopen(row, at: place, workspace: session, wasPrivate: true)
        XCTAssertNil(reopened)
        XCTAssertNil(model.row(tab), "the private tab is in no Workspace")
        try assertShowsWhole(model, "after the reopen was refused")

        let control = await model.reopen(row, at: place, workspace: session, wasPrivate: false)
        XCTAssertEqual(control, tab)
        XCTAssertEqual(model.row(tab)?.parentId, shown.id, "the Workspace shown takes a tab that wasn't private")
    }

    /// A launch over a tree the phone already holds opens on its own
    /// Workspace, with that Workspace's tab in front, even where another
    /// Workspace comes first.
    func testALaunchOpensOnTheOwnWorkspace() async throws {
        let desk = Desk()
        let model = try await launched(with: desk)
        let own = try XCTUnwrap(model.ownWorkspace?.id)
        // Both devices made their Workspace in a tree that held none, so the
        // two take the same order key and their ids decide. The engine puts
        // a moved node after `before`.
        await model.moveWorkspace(own, before: desk.workspace, after: nil)
        XCTAssertEqual(model.workspaces.map(\.id), [desk.workspace, own], "another Workspace comes first")
        let tab = AppHarness.id()
        _ = await model.editTree([["kind": "addTab", "parent": own, "name": "Kept", "url": blank, "id": tab]])
        try await harness.quit()
        // Nothing of what was in front is saved: the launch picks it.
        UserDefaults.standard.removeObject(forKey: "currentWorkspace")
        UserDefaults.standard.removeObject(forKey: "currentTab")

        let relaunched = try await harness.launch(ready: { $0.ownWorkspace != nil })
        try await harness.until("the phone's own tab is in front, in front: \(relaunched.browser.currentTabId ?? "none")") {
            relaunched.browser.currentTabId == tab
        }
        XCTAssertEqual(relaunched.browser.workspaceId, own)
        XCTAssertTrue(relaunched.browser.hasPage(tab))
    }

    /// The folder is watched once however many times the app comes to the
    /// front, so one change starts one pass.
    func testStartingToWatchTwiceLeavesOneWatcher() async throws {
        _ = try await launched(with: Desk())
        let picked = harness.picked.resolvingSymlinksInPath()
        let watchers = {
            NSFileCoordinator.filePresenters.filter { $0.presentedItemURL?.resolvingSymlinksInPath() == picked }.count
        }
        XCTAssertEqual(watchers(), 1, "the launch watches the folder")
        // UIKit posts it as a cold launch's scene comes to the front.
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertEqual(watchers(), 1)
    }
}
