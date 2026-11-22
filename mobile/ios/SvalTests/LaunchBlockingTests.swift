// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// A page made as the app launches loads under the blocking rules an
/// earlier launch compiled, looked up before its first load, or at once
/// when there are none.
@MainActor
final class LaunchBlockingTests: XCTestCase {
    private var directory: URL!
    private var store: WKContentRuleListStore!
    private var defaults: UserDefaults!
    private let inputs = BlockerInputs(settings: [:])

    override func setUp() async throws {
        directory = try temporaryDirectory(self)
        store = try XCTUnwrap(WKContentRuleListStore(url: try temporaryDirectory(self)))
        let suite = "launch-blocking-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: suite) }
        // Each list freshly downloaded, so no check fetches one.
        for id in inputs.lists.keys {
            try "||ads.example^\n##.sval-test-ad\n".write(
                to: directory.appending(path: "\(id).txt"), atomically: true, encoding: .utf8)
        }
    }

    private func blocker() -> ContentBlocker {
        ContentBlocker(directory: directory, store: store, defaults: defaults)
    }

    private func makePage() -> Page {
        Page(tabId: "tab", media: .allow, scriptAllowed: { _, _ in true },
             onNavigate: { _, _, _, _, _ in }, onState: {}, onScroll: { _, _ in })
    }

    /// Starts a page under `blocker` as `Browser.makePage` does, asks it to
    /// load, and returns the rule lists it had when its first document
    /// committed.
    private func firstLoad(under blocker: ContentBlocker) async -> [String] {
        let page = makePage()
        var installed: [String] = []
        let committed = expectation(description: "the first document commits")
        page.onLoad = {
            installed = page.rules.installed(protected: page.protected).map(\.identifier)
            committed.fulfill()
        }
        page.loadsUnder(blocker)
        page.load(URL(string: "about:blank")!)
        XCTAssertTrue(page.waitsForRules)
        XCTAssertNil(page.view.url, "the load started before the blocker was ready")
        await fulfillment(of: [committed], timeout: 20)
        return installed
    }

    func testAPageMadeAtLaunchLoadsUnderTheListsTheLastLaunchApplied() async {
        let earlier = blocker()
        earlier.update(inputs)
        await earlier.settled()
        let applied = earlier.rules.installed(protected: true).map(\.identifier)
        XCTAssertFalse(applied.isEmpty)
        // A second launch over the same store, with no check run.
        let installed = await firstLoad(under: blocker())
        XCTAssertEqual(installed, applied)
    }

    /// No lists applied at an earlier launch: the first page loads once
    /// the lookup finds none, with no check run, and with no list.
    func testAFirstLaunchLoadsAtOnce() async {
        let installed = await firstLoad(under: blocker())
        XCTAssertEqual(installed, [])
    }

    /// Blocking turned off at the last launch: a page made at launch loads
    /// at once, with no list.
    func testALaunchAfterBlockingWasOffLoadsWithNoLists() async {
        let earlier = blocker()
        earlier.update(BlockerInputs(settings: [ContentBlocker.levelKey: "off"]))
        await earlier.settled()
        let launched = blocker()
        await launched.whenReady()
        let page = makePage()
        page.loadsUnder(launched)
        XCTAssertFalse(page.waitsForRules)
        XCTAssertTrue(page.rules.installed(protected: true).isEmpty)
    }
}
