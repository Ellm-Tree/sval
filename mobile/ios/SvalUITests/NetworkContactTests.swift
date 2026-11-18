// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest

/// The session `scripts/network-contact-ios.sh` captures the network of
/// (spec §10.9): a first launch that starts a sync in the demo's stand-in
/// folder, a local page, a search typed in the Launcher, and an idle long
/// enough for the blocking lists to download and compile. It skips unless
/// the script gives it the page, so the app's other test runs never wait
/// through the idle.
///
/// The search is typed and never sent: a sent search loads the engine's
/// page, which is page traffic, and the check counts only what Sval
/// contacts on its own. Dropbox and a server on the network need accounts,
/// so neither is set up.
final class NetworkContactTests: XCTestCase {
    func testSession() throws {
        let env = ProcessInfo.processInfo.environment
        guard let page = env["SVAL_NETWORK_PAGE"] else {
            throw XCTSkip("scripts/network-contact-ios.sh runs this with a page to load")
        }
        let idle = UInt32(env["SVAL_NETWORK_IDLE"] ?? "") ?? 150
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-svalDemo", "-svalDemoFresh", "-svalDemoStart"]
        app.launch()

        let start = app.buttons["Start Syncing"]
        XCTAssertTrue(start.waitForExistence(timeout: 60), "first launch offers to start syncing")
        start.tap()
        let proceed = app.buttons["Continue"]
        XCTAssertTrue(proceed.waitForExistence(timeout: 30), "the sync key's backup shows")
        proceed.tap()
        let browse = app.buttons["Start Browsing"]
        XCTAssertTrue(browse.waitForExistence(timeout: 30), "setup ends on the new sync")
        browse.tap()
        XCTAssertTrue(app.buttons["New Tab"].firstMatch.waitForExistence(timeout: 30), "the browser opens")
        sleep(2)

        if env["SVAL_NETWORK_STRICT"] == "1" {
            app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch.tap()
            sleep(2)
            app.buttons["Settings"].firstMatch.tap()
            let strict = app.buttons["Strict"].firstMatch
            XCTAssertTrue(strict.waitForExistence(timeout: 10), "Settings offers Strict blocking")
            strict.tap()
            sleep(2)
            XCTAssertTrue(strict.isSelected, "Strict is the blocking level")
            app.swipeDown(velocity: .fast)
            sleep(1)
            app.swipeDown(velocity: .fast)
            sleep(2)
        }

        let newTab = app.buttons["New Tab"].firstMatch
        XCTAssertTrue(newTab.waitForExistence(timeout: 10), "the bar shows New Tab")
        newTab.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "the Launcher takes the keyboard")
        app.typeText(page + "\n")
        XCTAssertTrue(app.webViews.staticTexts["A page with nothing on it."].waitForExistence(timeout: 30),
                      "the local page loads")

        let address = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Address' OR label == 'Search or enter address'")).firstMatch
        XCTAssertTrue(address.waitForExistence(timeout: 10), "the bar shows the address")
        address.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "the Launcher takes the keyboard")
        app.typeText("weather")
        sleep(5)
        app.buttons["Cancel"].firstMatch.tap()

        sleep(idle)
        XCTAssertTrue(app.state == .runningForeground, "Sval ran through the idle")
    }
}
