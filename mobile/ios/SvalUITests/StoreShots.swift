// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest

/// Stages the App Store's screenshots on the showroom tree and saves each
/// to SVAL_SHOTS. Each test skips unless SVAL_SHOTS is set, so the suite's
/// runs pass over them.
final class StoreShots: XCTestCase {
    private var app: XCUIApplication!
    private var dir: URL!

    override func setUpWithError() throws {
        let shots = ProcessInfo.processInfo.environment["SVAL_SHOTS"]
        try XCTSkipIf(shots == nil, "store screenshots are made only when SVAL_SHOTS is set")
        dir = URL(fileURLWithPath: shots!)
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-svalDemo", "-svalDemoFresh", "-svalDemoShowroom"]
        app.launch()
        XCTAssertTrue(app.buttons["New Tab"].firstMatch.waitForExistence(timeout: 30), "the bar shows")
        sleep(2)
    }

    private func save(_ name: String) {
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
        let shot = XCUIScreen.main.screenshot()
        let pixels = Int(shot.image.size.height * shot.image.scale)
        let url = dir.appendingPathComponent("\(device)-\(pixels)-\(name).png")
        try? shot.pngRepresentation.write(to: url)
    }

    private var workspaceButton: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch
    }

    private func card(_ name: String) -> XCUIElement {
        app.collectionViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    /// Opens each tab once, so its card has a picture of its page.
    private func visit(_ names: [String]) {
        for name in names {
            if !card(name).isHittable {
                // By coordinates: XCTest gives a list in an iPad's
                // popover no visible frame, and refuses to swipe it.
                if let grid = app.collectionViews.allElementsBoundByIndex.first(where: { $0.frame.height > 300 }) {
                    grid.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
                        .press(forDuration: 0.05, thenDragTo: grid.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)))
                }
                sleep(1)
            }
            card(name).tap()
            sleep(6)
            workspaceButton.tap()
            sleep(2)
        }
    }

    func test1Grid() {
        workspaceButton.tap()
        sleep(2)
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        app.buttons["Grid"].firstMatch.tap()
        sleep(1)
        app.buttons["Road Trip"].firstMatch.tap()
        sleep(2)
        visit(["Arches", "Bryce Canyon", "Grand Canyon", "Yosemite", "Death Valley", "Zion"])
        sleep(2)
        save("1-grid")
    }

    func test2Page() {
        workspaceButton.tap()
        sleep(2)
        app.buttons["Listening"].firstMatch.tap()
        sleep(2)
        card("Roon").tap()
        sleep(10)
        // Roon's page opens an offer over its bottom. Its close button is
        // no button to XCTest, so it is tapped where each screen shows it.
        let height = app.frame.height
        let close = height > 1000 ? CGVector(dx: 0.021, dy: 0.861)
            : height > 900 ? CGVector(dx: 0.048, dy: 0.791) : CGVector(dx: 0.055, dy: 0.755)
        app.coordinate(withNormalizedOffset: close).tap()
        sleep(2)
        save("2-page")
    }

    func test3Split() {
        workspaceButton.tap()
        sleep(2)
        app.buttons["Work"].firstMatch.tap()
        sleep(2)
        card("Swift").tap()
        sleep(10)
        save("3-split")
    }

    func test4Suggestions() {
        workspaceButton.tap()
        sleep(2)
        app.buttons["Road Trip"].firstMatch.tap()
        sleep(2)
        visit(["Grand Canyon", "Yosemite", "Zion"])
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'iPhone' OR label BEGINSWITH 'iPad'")).firstMatch.tap()
        sleep(2)
        app.collectionViews.buttons.matching(NSPredicate(format: "label CONTAINS 'WebKit'")).firstMatch.tap()
        sleep(6)
        app.buttons["New Tab"].firstMatch.tap()
        sleep(2)
        app.typeText("park")
        sleep(3)
        save("4-suggestions")
    }

    func test5SiteMenu() {
        workspaceButton.tap()
        sleep(2)
        app.buttons["Road Trip"].firstMatch.tap()
        sleep(2)
        card("Yosemite").tap()
        sleep(8)
        app.buttons["Site settings"].firstMatch.tap()
        sleep(2)
        // The menu opens at half height; drawn up by its grabber it
        // shows Remove from This Site too.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.485))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)))
        sleep(2)
        save("5-site-menu")
    }

    func test6Pairing() {
        app.terminate()
        app.launchArguments = ["-svalDemo", "-svalDemoFresh", "-svalDemoJoin"]
        app.launch()
        XCTAssertTrue(app.textFields["Pairing code"].waitForExistence(timeout: 30), "the pairing code step shows")
        sleep(1)
        app.typeText("k7mq4xr2p9tw")
        sleep(2)
        save("6-pairing")
    }
}
