// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest

/// Stages the website docs' iPhone and iPad screenshots on the demo's
/// sample Workspaces and saves each to SVAL_DOCS_SHOTS as
/// `docs-<device>-<shot>.png`, the name the docs' Screenshot component
/// takes. Each test skips unless SVAL_DOCS_SHOTS is set, so the other UI
/// test runs pass over them. A shot the iPad lays out as the iPhone does is
/// made on the iPhone alone, and the iPad's own shots are made on the iPad
/// alone.
final class DocsShots: XCTestCase {
    private var app: XCUIApplication!
    private var dir: URL!

    private static let showroom = ["-svalDemo", "-svalDemoFresh", "-svalDemoShowroom"]

    override func setUpWithError() throws {
        let shots = ProcessInfo.processInfo.environment["SVAL_DOCS_SHOTS"]
        try XCTSkipIf(shots == nil, "docs screenshots are made only when SVAL_DOCS_SHOTS is set")
        dir = URL(fileURLWithPath: shots!)
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    private func phoneOnly() throws {
        try XCTSkipIf(isPad, "the iPad shows this as the iPhone does")
    }

    private func padOnly() throws {
        try XCTSkipUnless(isPad, "an iPad shot")
    }

    /// Opens the app on the showroom's Workspaces, or on what `arguments`
    /// asks for.
    private func launch(_ arguments: [String] = DocsShots.showroom) {
        app.launchArguments = arguments
        app.launch()
        if arguments.contains("-svalDemoShowroom") {
            XCTAssertTrue(app.buttons["New Tab"].firstMatch.waitForExistence(timeout: 30), "the bar shows")
            sleep(2)
        }
    }

    private func url(_ name: String) -> URL {
        dir.appendingPathComponent("docs-\(isPad ? "ipad" : "iphone")-\(name).png")
    }

    private func save(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url(name))
    }

    /// Saves the screen `after` seconds from now, from another queue: a
    /// shot of what shows only while a finger is held, taken during the
    /// gesture that holds it.
    private func save(_ name: String, after seconds: Double) {
        let target = url(name)
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: target)
        }
    }

    private var workspaceButton: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch
    }

    private var address: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Address' OR label == 'Search or enter address'")).firstMatch
    }

    /// A tab's card in the grid, or its row in the list.
    private func card(_ name: String) -> XCUIElement {
        app.collectionViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    /// Any element of the Workspace's tree whose label starts with `name`,
    /// which Edit Tabs' rows are.
    private func labelled(_ name: String) -> XCUIElement {
        app.collectionViews.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    private func openWorkspace(_ name: String) {
        workspaceButton.tap()
        sleep(2)
        app.buttons[name].firstMatch.tap()
        sleep(2)
    }

    private func showGrid() {
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        app.buttons["Grid"].firstMatch.tap()
        sleep(1)
    }

    /// Opens each tab once from the open sheet, so its card has a picture
    /// of its page, and leaves the sheet open.
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

    /// Opens a Road Trip tab's page, with the sheet closed.
    private func openPark(_ name: String) {
        openWorkspace("Road Trip")
        card(name).tap()
        sleep(8)
    }

    /// The site menu for the page in front, drawn up by its grabber from
    /// half height so it shows every row down to Zoom.
    private func openSiteMenu() {
        app.buttons["Site settings"].firstMatch.tap()
        sleep(2)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.485))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)))
        sleep(2)
    }

    /// A press that lifts a card and carries it to `target`, both ends
    /// fixed on the app before the press. XCTest looks an element's
    /// coordinate up again while it synthesizes the gesture, and a lookup
    /// that runs into the press holds the lift back until the finger has
    /// moved, so the touch scrolls instead.
    private func drag(_ item: XCUIElement, to target: XCUICoordinate, hold: Double) {
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let at = { (point: CGPoint) in
            origin.withOffset(CGVector(dx: point.x - origin.screenPoint.x, dy: point.y - origin.screenPoint.y))
        }
        let from = at(item.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5)).screenPoint)
        from.press(forDuration: 0.6, thenDragTo: at(target.screenPoint), withVelocity: .slow, thenHoldForDuration: hold)
    }

    // MARK: Setting up

    func testWelcome() throws {
        try phoneOnly()
        // The demo's fresh start empties the app, so a plain launch after
        // it opens on setup's first screen.
        launch(["-svalDemo", "-svalDemoFresh"])
        XCTAssertTrue(app.buttons["New Tab"].firstMatch.waitForExistence(timeout: 30), "the demo opens")
        app.terminate()
        launch([])
        XCTAssertTrue(app.buttons["Choose Your Folder"].waitForExistence(timeout: 30), "setup's welcome shows")
        sleep(2)
        save("welcome")
    }

    func testJoinCode() throws {
        try phoneOnly()
        launch(["-svalDemo", "-svalDemoFresh", "-svalDemoJoin"])
        XCTAssertTrue(app.textFields["Pairing code"].waitForExistence(timeout: 30), "the pairing code step shows")
        sleep(1)
        app.typeText("k7mq4xr2p9tw")
        sleep(2)
        save("join-code")
    }

    func testStartSync() throws {
        try phoneOnly()
        launch(["-svalDemo", "-svalDemoFresh", "-svalDemoStart"])
        XCTAssertTrue(app.buttons["Start Syncing"].waitForExistence(timeout: 30), "an empty folder offers to start syncing")
        sleep(2)
        save("start-sync")
    }

    // MARK: The bar and the Workspace

    func testBar() throws {
        try phoneOnly()
        launch()
        openPark("Yosemite")
        save("bar")
    }

    func testTabScrub() throws {
        try phoneOnly()
        launch()
        openWorkspace("Road Trip")
        showGrid()
        visit(["Zion", "Arches", "Bryce Canyon"])
        card("Arches").tap()
        sleep(6)
        // The strip rises once the hold on the address lifts it, and
        // stays while the finger is down: the shot is taken in the hold
        // after a short slide toward Zion, inside the Utah group.
        let start = address.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        save("tab-scrub", after: 2.5)
        start.press(forDuration: 0.8, thenDragTo: start.withOffset(CGVector(dx: -40, dy: 0)),
                    withVelocity: .slow, thenHoldForDuration: 3)
        sleep(2)
    }

    func testWorkspace() throws {
        try phoneOnly()
        launch()
        openWorkspace("Road Trip")
        card("Death Valley").press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Pin Tab"].firstMatch.waitForExistence(timeout: 5), "the tab's menu offers Pin Tab")
        app.buttons["Pin Tab"].firstMatch.tap()
        sleep(3)
        if !app.buttons["Workspace options"].firstMatch.exists {
            workspaceButton.tap()
            sleep(2)
        }
        save("workspace")
    }

    func testPadWorkspace() throws {
        try padOnly()
        launch()
        openPark("Yosemite")
        workspaceButton.tap()
        sleep(2)
        XCTAssertTrue(app.popovers.firstMatch.exists, "the Workspace opens over the page")
        save("workspace")
    }

    func testGridDrop() throws {
        try phoneOnly()
        launch()
        openWorkspace("Road Trip")
        showGrid()
        visit(["Grand Canyon", "Yosemite", "Death Valley"])
        // Held over Yosemite's middle, the card shows its Group and Split
        // halves, which show only while the finger is down.
        save("grid-drop", after: 3)
        drag(card("Death Valley"), to: card("Yosemite").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)), hold: 2.5)
        sleep(2)
    }

    func testEditTabs() throws {
        try phoneOnly()
        launch()
        openWorkspace("Road Trip")
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Edit Tabs'")).firstMatch.tap()
        sleep(1)
        for name in ["Grand Canyon", "Yosemite", "Death Valley"] {
            labelled(name).tap()
            sleep(1)
        }
        XCTAssertTrue(app.navigationBars["3 Selected"].waitForExistence(timeout: 5), "three tabs are ticked")
        save("edit-tabs")
    }

    func testLauncher() throws {
        try phoneOnly()
        launch()
        openWorkspace("Road Trip")
        showGrid()
        visit(["Grand Canyon", "Yosemite", "Zion"])
        card("Yosemite").tap()
        sleep(6)
        app.buttons["New Tab"].firstMatch.tap()
        sleep(2)
        app.typeText("park")
        sleep(3)
        save("launcher")
    }

    // MARK: Splits

    func testSplit() throws {
        try phoneOnly()
        launch()
        openWorkspace("Work")
        card("Swift").tap()
        sleep(10)
        app.buttons["Split"].firstMatch.tap()
        sleep(2)
        save("split")
    }

    func testSplitSideways() throws {
        try phoneOnly()
        launch()
        openWorkspace("Work")
        card("Swift").tap()
        sleep(10)
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(3)
        save("split-sideways")
    }

    func testPadSplit() throws {
        try padOnly()
        launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        openWorkspace("Work")
        card("Swift").tap()
        sleep(10)
        save("split")
    }

    // MARK: Private

    func testPrivate() throws {
        try phoneOnly()
        launch()
        workspaceButton.tap()
        sleep(2)
        app.buttons["Private"].firstMatch.tap()
        sleep(2)
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Private'")).firstMatch.tap()
        sleep(2)
        let notice = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS 'Nothing in this private Workspace'")).firstMatch
        XCTAssertTrue(notice.exists, "the private Workspace shows its notice")
        save("private")
    }

    // MARK: The site menu

    func testSiteMenu() throws {
        try phoneOnly()
        launch()
        openPark("Yosemite")
        openSiteMenu()
        save("site-menu")
    }

    /// The picker with a part of the page picked. The showroom's pages
    /// have no cookie banner, so the pick is the part of the page at the
    /// tap.
    func testRemove() throws {
        try phoneOnly()
        launch()
        openPark("Yosemite")
        openSiteMenu()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove from This Site'")).firstMatch.tap()
        let page = app.otherElements["Page"].firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the picker covers the page")
        sleep(1)
        page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        let picked = app.buttons["Remove"].firstMatch.waitForExistence(timeout: 10)
        sleep(1)
        save("remove")
        XCTAssertTrue(picked, "the picker's card offers Remove")
    }

    /// Ask first, the default, refuses a video marked to play by itself,
    /// and the bar offers to allow it.
    func testMediaAsk() throws {
        try phoneOnly()
        launch()
        address.tap()
        sleep(1)
        app.typeText("https://www.w3schools.com/html/tryit.asp?filename=tryhtml5_video_autoplay\n")
        let shown = app.buttons["Allow Video and Audio"].waitForExistence(timeout: 20)
        sleep(2)
        save("media-ask")
        XCTAssertTrue(shown, "the bar offers Allow Video and Audio")
    }

    // MARK: Settings

    func testSettings() throws {
        try phoneOnly()
        launch()
        workspaceButton.tap()
        sleep(2)
        app.buttons["Settings"].firstMatch.tap()
        sleep(2)
        save("settings")
        // Sync is at the end of Settings. A tap on a row still below the
        // sheet's edge would land on the page behind, so the list is
        // swiped until the row is on screen.
        let sync = app.buttons["Sync with Another Device"].firstMatch
        for _ in 0..<4 where !sync.isHittable {
            let list = app.collectionViews.firstMatch
            list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
                .press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)))
            sleep(1)
        }
        save("settings-sync")
    }
}
