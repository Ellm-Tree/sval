// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest

/// Walks the screens round 6 changed, on the demo tree, and checks what a
/// user would: that each control is there, that a field takes the
/// keyboard, and that Cancel leaves things as they were. Each step saves a
/// screenshot to SVAL_SHOTS when it is set.
final class WalkthroughTests: XCTestCase {
    private var app: XCUIApplication!
    private var step = 0

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launchArguments = ["-svalDemo", "-svalDemoFresh"]
        app.launch()
    }

    private func shot(_ name: String) {
        step += 1
        guard let dir = ProcessInfo.processInfo.environment["SVAL_SHOTS"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent(String(format: "%02d-%@.png", step, name))
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
    }

    /// Whether the on-screen keyboard comes up. It is waited for: the
    /// first keyboard of a freshly booted simulator takes seconds to load,
    /// longer than the app takes to ask for it.
    private var keyboardShown: Bool { app.keyboards.firstMatch.waitForExistence(timeout: 10) }

    /// Starts selecting tabs from the header's ••• menu.
    private func startEditing() {
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Edit Tabs'")).firstMatch.tap()
    }

    /// Swipes a list up by coordinates. XCTest finds a list inside an
    /// iPad's popover no visible frame, and refuses to swipe the element.
    private func swipeUp(_ list: XCUIElement) {
        list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            .press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)))
    }

    private func waitForBar() {
        XCTAssertTrue(app.buttons["New Tab"].firstMatch.waitForExistence(timeout: 30), "the bar's New Tab button shows")
        sleep(2)
    }

    func testBarAndLauncher() {
        waitForBar()
        shot("bar")
        let address = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Address' OR label == 'Search or enter address'")).firstMatch
        XCTAssertTrue(address.exists, "the address shows")
        address.tap()
        sleep(1)
        shot("launcher")
        XCTAssertTrue(keyboardShown, "the Launcher's field takes the keyboard")
        app.buttons["Cancel"].firstMatch.tap()
        sleep(1)
        shot("launcher-closed")
        app.buttons["New Tab"].firstMatch.tap()
        sleep(1)
        shot("new-tab-launcher")
        XCTAssertTrue(keyboardShown, "New Tab's Launcher takes the keyboard")
        XCTAssertTrue(app.textFields["Search or enter address"].exists, "the field says Search or enter address")
        sleep(2)
        XCTAssertTrue(keyboardShown, "New Tab's Launcher keeps the keyboard")
        app.buttons["Cancel"].firstMatch.tap()
    }

    /// The site menu's video and audio choice: the desktop's three, saved
    /// for the site, and the page made again for it.
    /// On an iPad the Workspace opens as a popover over its button, which
    /// keeps what opens from it: Settings, and the grid filling its width.
    func testLauncherPopoverOnIPad() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPhone opens the Workspace as a sheet")
        waitForBar()
        let button = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch
        button.tap()
        sleep(2)
        shot("popover-list")
        let popover = app.popovers.firstMatch
        XCTAssertTrue(popover.exists, "the Workspace opens as a popover")
        XCTAssertLessThanOrEqual(popover.frame.maxY, button.frame.minY, "above its button, its arrow at the button's edge")
        XCTAssertLessThan(popover.frame.minX, button.frame.midX, "reaching over its button")
        XCTAssertGreaterThan(popover.frame.maxX, button.frame.midX - 60, "near its button")
        XCTAssertTrue(popover.buttons["Workspace options"].exists, "the popover holds the Workspace")
        popover.buttons["Workspace options"].tap()
        sleep(1)
        app.buttons["Grid"].firstMatch.tap()
        sleep(2)
        app.buttons["Work"].firstMatch.tap()
        sleep(2)
        shot("popover-grid")
        let cards = popover.collectionViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Wikipedia' OR label BEGINSWITH 'Swift'"))
        XCTAssertEqual(cards.count, 2, "Work shows its two cards")
        let frames = cards.allElementsBoundByIndex.map(\.frame).sorted { $0.minX < $1.minX }
        let left = frames[0], right = frames[frames.count - 1]
        XCTAssertEqual(left.minX - popover.frame.minX, popover.frame.maxX - right.maxX, accuracy: 24,
                       "the grid's two columns fill the popover")
        app.buttons["Settings"].firstMatch.tap()
        sleep(2)
        shot("popover-settings")
        XCTAssertTrue(app.popovers.firstMatch.navigationBars["Settings"].exists, "Settings opens inside the popover")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.06)).tap()
        sleep(2)
        XCTAssertFalse(app.popovers.firstMatch.exists, "a tap outside closes the popover")
        button.tap()
        sleep(2)
        XCTAssertTrue(app.popovers.firstMatch.exists, "the popover opens again")
    }

    func testMediaChoice() {
        waitForBar()
        app.buttons["Site settings"].firstMatch.tap()
        sleep(2)
        shot("site-menu")
        app.collectionViews.firstMatch.swipeUp()
        sleep(1)
        let media = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Video and Audio'")).firstMatch
        XCTAssertTrue(media.waitForExistence(timeout: 3), "the site menu has Video and Audio")
        XCTAssertTrue(media.label.contains("Ask first"), "a site with no choice gets Ask first")
        media.tap()
        sleep(1)
        shot("media-choices")
        app.buttons["Always deny"].firstMatch.tap()
        sleep(2)
        shot("media-denied")
        XCTAssertTrue(media.label.contains("Always deny"), "the choice is saved for the site")
        media.tap()
        sleep(1)
        app.buttons["Ask first"].firstMatch.tap()
        sleep(1)
    }

    /// Ask first refuses a video marked to play by itself, and the bar
    /// offers to allow it for this visit.
    func testMediaBlocked() {
        waitForBar()
        let address = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Address' OR label == 'Search or enter address'")).firstMatch
        address.tap()
        sleep(1)
        app.typeText("https://www.w3schools.com/html/tryit.asp?filename=tryhtml5_video_autoplay\n")
        let allow = app.buttons["Allow Video and Audio"]
        let shown = allow.waitForExistence(timeout: 20)
        shot("media-blocked")
        XCTAssertTrue(shown, "the bar offers Allow Video and Audio")
        allow.tap()
        sleep(4)
        shot("media-allowed")
        XCTAssertFalse(allow.exists, "allowed for the visit, the offer goes")
    }

    /// Favorites from the sheet's bottom bar: the system's bar, with back
    /// and Done.
    func testFavoritesPage() {
        waitForBar()
        let workspace = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch
        workspace.tap()
        sleep(2)
        app.buttons["Favorites"].firstMatch.tap()
        sleep(1)
        shot("favorites")
        XCTAssertTrue(app.navigationBars["Favorites"].exists, "Favorites has the system's bar")
        app.navigationBars["Favorites"].buttons["Close"].tap()
    }

    /// Settings › Licenses lists Sval's notice and every component; a
    /// search finds a component, whose page shows its license.
    func testLicensesPage() {
        waitForBar()
        let workspace = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch
        workspace.tap()
        sleep(2)
        app.buttons["Settings"].firstMatch.tap()
        sleep(2)
        swipeUp(app.collectionViews.firstMatch)
        sleep(1)
        app.buttons["Licenses"].firstMatch.tap()
        let notice = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Sval is made by Ellm Tree'")).firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 10), "the list opens with Sval's notice")
        sleep(1)
        shot("licenses")
        XCTAssertTrue(app.navigationBars["Licenses"].exists, "Licenses has the system's bar")
        // The page behind an iPad's popover has search fields of its own.
        app.navigationBars["Licenses"].searchFields.firstMatch.tap()
        app.typeText("seahash")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'seahash'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "a search finds the component")
        sleep(1)
        shot("licenses-search")
        row.tap()
        let text = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Permission is hereby granted'")).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 5), "the component's page shows its license")
        sleep(1)
        shot("licenses-detail")
    }

    /// The sheet's New Tab: the sheet goes, then the Launcher comes up and
    /// keeps the keyboard.
    func testSheetNewTab() {
        waitForBar()
        let workspace = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch
        workspace.tap()
        sleep(2)
        // The bar's New Tab lies under the sheet; the sheet's is the one
        // a finger reaches.
        let newTabs = app.buttons.matching(identifier: "New Tab").allElementsBoundByIndex
        XCTAssertNotNil(newTabs.last { $0.isHittable }, "the sheet has New Tab")
        newTabs.last { $0.isHittable }?.tap()
        sleep(1)
        shot("sheet-new-tab")
        XCTAssertTrue(keyboardShown, "the Launcher takes the keyboard")
        sleep(2)
        shot("sheet-new-tab-later")
        XCTAssertTrue(keyboardShown, "the Launcher keeps the keyboard")
        XCTAssertTrue(app.textFields["Search or enter address"].exists, "the Launcher stays open")
    }

    func testSheetEditAndGroup() {
        waitForBar()
        let workspace = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch
        workspace.tap()
        sleep(2)
        shot("sheet")
        // The phone's own Workspace holds groups as any other does
        // (decision 2254).
        startEditing()
        sleep(1)
        XCTAssertTrue(app.buttons["New Group…"].exists, "the phone's own Workspace offers New Group…")
        app.buttons["Done"].firstMatch.tap()
        sleep(1)
        app.buttons["Work"].firstMatch.tap()
        sleep(2)
        startEditing()
        sleep(1)
        shot("edit")
        XCTAssertTrue(app.buttons["Done"].exists, "Edit shows Done")
        XCTAssertFalse(app.buttons["Edit Workspace…"].exists, "Edit adds no Edit Workspace row")
        app.buttons["Select All"].firstMatch.tap()
        sleep(1)
        shot("edit-all")
        app.buttons["New Group…"].firstMatch.tap()
        sleep(1)
        shot("new-group")
        XCTAssertTrue(keyboardShown, "New Group's name field takes the keyboard")
        app.navigationBars["New Group"].buttons["Close"].tap()
        sleep(1)
        shot("new-group-cancelled")
        XCTAssertTrue(app.buttons["Done"].exists, "Closing New Group stays in Edit")
        app.buttons["Done"].firstMatch.tap()
        sleep(1)
        shot("edit-done")
    }

    /// A tab's name in the Workspace tree, a List, where the page behind
    /// the sheet may show the same words.
    private func row(_ name: String) -> XCUIElement {
        app.collectionViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
    }

    /// A row dragged as the system drags anything: a press long enough to
    /// lift it and short of opening its menu, then a slow move, held over
    /// the target before letting go.
    private func drag(_ row: XCUIElement, to target: XCUICoordinate, marked: String? = nil) {
        let from = row.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
        // The drop's mark shows only while the finger is held, so its
        // screenshot is taken during the hold.
        if let marked, let dir = ProcessInfo.processInfo.environment["SVAL_SHOTS"] {
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                let url = URL(fileURLWithPath: dir).appendingPathComponent("mark-\(marked).png")
                try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
            }
        }
        from.press(forDuration: 0.6, thenDragTo: target, withVelocity: .slow, thenHoldForDuration: marked == nil ? 1.0 : 2.5)
        sleep(2)
    }

    func testFold() {
        waitForBar()
        let page = app.webViews.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "a page shows")
        if page.exists {
            sleep(3)
            // A 300pt drag, past the fold's start and short of the page's
            // end, where the bar opens again.
            let from = page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
            from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -300)))
            sleep(2)
            shot("folded")
            app.buttons["Show the toolbar"].firstMatch.tap()
            sleep(1)
            shot("unfolded")
        }
    }

    func testLauncherSuggestions() {
        waitForBar()
        app.buttons["New Tab"].firstMatch.tap()
        sleep(1)
        app.typeText("wiki")
        sleep(2)
        shot("suggestions")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Switch to'")).count > 0, "open tabs match")
    }

    func testMoveTo() {
        waitForBar()
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch.tap()
        sleep(2)
        startEditing()
        XCTAssertFalse(app.buttons["Move Selected…"].firstMatch.isEnabled, "nothing to move before a tab is ticked")
        app.buttons["Select All"].firstMatch.tap()
        sleep(1)
        app.buttons["Move Selected…"].firstMatch.tap()
        sleep(2)
        app.buttons["Groups in Work"].firstMatch.tap()
        sleep(1)
        shot("move-to")
        XCTAssertTrue(app.buttons["New Group…"].exists, "Move to… offers a new group in another Workspace")
        XCTAssertTrue(app.staticTexts["Reading"].exists, "Move to… lists the other Workspaces")
        app.navigationBars["Move to…"].buttons["Close"].tap()
        sleep(1)
        XCTAssertTrue(app.buttons["Done"].exists, "Closing Move to… stays in Edit")
    }

    func testSideways() {
        waitForBar()
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        shot("sideways")
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch.tap()
        sleep(2)
        shot("sideways-panel")
        XCUIDevice.shared.orientation = .portrait
    }

    /// A split made by a drag in Work's tree, opened, then separated: the
    /// tab in front keeps its page on screen.
    func testSplitSeparate() {
        waitForBar()
        let sheet = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch
        sheet.tap()
        sleep(2)
        app.buttons["Work"].firstMatch.tap()
        sleep(2)
        // Let go at the end of Apple's row, its split zone, where the
        // tree ends: the sheet's edge, or the popover's.
        let apple = row("Apple").frame
        let tree = app.collectionViews.containing(NSPredicate(format: "label == %@", "Apple")).firstMatch.frame
        let zone = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: tree.maxX - 44, dy: apple.midY))
        drag(row("Swift"), to: zone, marked: "split")
        shot("split-made")
        row("Apple").tap()
        sleep(3)
        shot("split-open")
        XCTAssertGreaterThanOrEqual(app.webViews.count, 2, "the split shows both pages")
        sheet.tap()
        sleep(2)
        row("Apple").press(forDuration: 1.2)
        sleep(1)
        app.buttons["Separate"].firstMatch.tap()
        sleep(1)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        sleep(3)
        shot("separated")
        let page = app.webViews.firstMatch
        XCTAssertTrue(page.exists && page.frame.height > 300, "the tab in front shows its page after Separate")
    }

    /// The Private tile opens the private session on its home with no tab,
    /// and the sheet's Exit ends it at once.
    func testPrivateHomeAndExit() {
        waitForBar()
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch.tap()
        sleep(2)
        app.buttons["Private"].firstMatch.tap()
        sleep(2)
        shot("private-home")
        XCTAssertTrue(app.staticTexts["Private Workspace"].exists, "the private session opens on its home")
        XCTAssertEqual(app.webViews.count, 0, "the private home is no page")
        XCTAssertTrue(app.buttons["New Tab"].exists, "the private home offers New Tab")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Private'")).firstMatch.tap()
        sleep(2)
        shot("private-sheet")
        app.buttons["Exit"].firstMatch.tap()
        sleep(2)
        shot("private-exited")
        XCTAssertFalse(app.staticTexts["Private Workspace"].exists, "Exit leaves the private session")
    }

    /// An empty Workspace shows its tile, name and New Tab behind the bar.
    func testEmptyWorkspaceHome() {
        waitForBar()
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch.tap()
        sleep(2)
        app.buttons["Travel"].firstMatch.tap()
        sleep(2)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        sleep(2)
        shot("empty-home")
        XCTAssertTrue(app.staticTexts["Travel"].exists, "the empty Workspace shows its name")
        app.buttons["New Tab"].firstMatch.tap()
        sleep(1)
        XCTAssertTrue(keyboardShown, "its New Tab opens the Launcher")
    }

    /// Empties the phone's own Workspace, so it runs last: XCTest runs a
    /// class's tests in name order.
    func testZDeviceIntro() {
        waitForBar()
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch.tap()
        sleep(2)
        // A tab's row is one element, its × an action: the × is tapped at
        // the row's trailing end.
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Rail transport - Wikipedia, '")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the Workspace lists its tab")
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.5)).tap()
        sleep(1)
        app.swipeDown()
        sleep(2)
        shot("intro")
        XCTAssertTrue(app.staticTexts["Where things are"].exists, "the empty phone Workspace shows its intro")
    }

    /// Work's sheet: the options menu, then its tab dragged onto a tab in
    /// its group.
    func testWorkspaceOptionsAndDrag() {
        waitForBar()
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch.tap()
        sleep(2)
        app.buttons["Work"].firstMatch.tap()
        sleep(2)
        shot("work-sheet")
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        shot("options-menu")
        XCTAssertTrue(app.buttons["Edit Workspace…"].exists, "the menu offers Edit Workspace…")
        app.buttons["Edit Workspace…"].firstMatch.tap()
        sleep(1)
        shot("edit-workspace")
        // A preset, light or dark, has no sliders; Custom has Hue, Intensity
        // and Shade, in this sheet (round 8).
        app.buttons["Pink, light"].firstMatch.tap()
        sleep(1)
        XCTAssertEqual(app.sliders.count, 0, "a preset shows no sliders")
        shot("edit-preset-light")
        app.buttons["Custom color"].firstMatch.tap()
        sleep(1)
        app.swipeUp()
        sleep(1)
        XCTAssertEqual(app.sliders.count, 3, "Custom shows Hue, Intensity and Shade")
        shot("edit-custom")
        app.sliders["Shade"].firstMatch.adjust(toNormalizedSliderPosition: 0.15)
        sleep(1)
        shot("edit-custom-deep")
        app.collectionViews.firstMatch.swipeDown()
        sleep(1)
        app.buttons["Red, dark"].firstMatch.tap()
        sleep(1)
        XCTAssertEqual(app.sliders.count, 0, "a preset again shows no sliders")
        shot("edit-preset-dark")
        app.navigationBars["Edit Workspace"].buttons["Close"].tap()
        sleep(1)
        XCTAssertTrue(row("Swift").exists && row("Apple").exists, "Work shows its tab and group")
        // Let go over Apple's middle: a new group of the two, named first.
        drag(row("Swift"), to: row("Apple").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)), marked: "new-group")
        shot("drop-new-group")
        XCTAssertTrue(app.staticTexts["New Group"].exists, "a drop on a tab's middle asks for the new group's name")
        app.navigationBars["New Group"].buttons["Close"].tap()
        sleep(1)
        // Let go over Apple's top edge, 20pt above its name's middle: Swift
        // goes into the group, above it.
        drag(row("Swift"), to: row("Apple").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: 0, dy: -20)), marked: "before")
        shot("drop-before")
        XCTAssertLessThan(row("Swift").frame.minY, row("Apple").frame.minY, "a drop on a row's top edge lands above it")
        // A tap above the sheet closes it, showing Work's bar.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        sleep(2)
        shot("work-bar")
    }

    /// Picking a Workspace in the sheet, then Edit Workspace…, edits that
    /// Workspace: a custom colour saved there is its colour after Save,
    /// and the editor opens on it again.
    func testEditPickedWorkspaceColour() {
        waitForBar()
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch.tap()
        sleep(2)
        app.buttons["Work"].firstMatch.tap()
        sleep(2)
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        app.buttons["Edit Workspace…"].firstMatch.tap()
        sleep(1)
        XCTAssertEqual(app.textFields["Name"].value as? String, "Work", "the editor opens on the Workspace picked")
        if !app.buttons["Custom color"].firstMatch.exists { app.swipeUp(); sleep(1) }
        app.buttons["Custom color"].firstMatch.tap()
        sleep(1)
        app.swipeUp()
        sleep(1)
        app.sliders["Intensity"].firstMatch.adjust(toNormalizedSliderPosition: 0.9)
        sleep(1)
        app.buttons["Save"].firstMatch.tap()
        sleep(3)
        shot("picked-saved")
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        app.buttons["Edit Workspace…"].firstMatch.tap()
        sleep(1)
        XCTAssertEqual(app.textFields["Name"].value as? String, "Work", "the editor opens on the same Workspace again")
        app.swipeUp()
        sleep(1)
        shot("picked-reopened")
        XCTAssertTrue(app.sliders["Hue"].exists, "the Workspace holds the custom colour saved")
    }

    /// Setup's folder choice and server form, on an app with no folder:
    /// the demo's fresh start empties it, then a plain launch shows setup.
    func testFirstRunSteps() {
        app.terminate()
        app.launchArguments = []
        app.launch()
        let choose = app.buttons["Choose Your Folder"]
        XCTAssertTrue(choose.waitForExistence(timeout: 30), "setup's welcome shows")
        choose.tap()
        let server = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'A server on your network'")).firstMatch
        XCTAssertTrue(server.waitForExistence(timeout: 10), "the folder choices show")
        shot("setup-choose")
        server.tap()
        XCTAssertTrue(app.staticTexts["Connect to your server"].waitForExistence(timeout: 10), "the server form shows")
        sleep(1)
        shot("setup-server")
    }

    /// The ••• menu's List and Grid, and the grid in a Workspace with a
    /// group, after a tab has left the front and has a picture.
    func testGridLayout() {
        waitForBar()
        let workspace = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch
        workspace.tap()
        sleep(2)
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        shot("grid-menu")
        XCTAssertTrue(app.buttons["Edit Tabs and Groups…"].exists, "the phone's own Workspace offers Edit Tabs and Groups…")
        app.buttons["Grid"].firstMatch.tap()
        sleep(2)
        shot("grid-own")
        app.buttons["Work"].firstMatch.tap()
        sleep(2)
        shot("grid-work")
        // Opening a card, then coming back, gives the tab left behind a
        // picture, and the tab in front one taken as the sheet opens.
        app.collectionViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Swift'")).firstMatch.tap()
        sleep(4)
        XCTAssertTrue(workspace.waitForExistence(timeout: 10), "the bar's Workspace button shows")
        workspace.tap()
        sleep(3)
        shot("grid-pictures")
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        XCTAssertTrue(app.buttons["Edit Tabs and Groups…"].exists, "Work offers Edit Tabs and Groups…")
        app.buttons["Edit Tabs and Groups…"].firstMatch.tap()
        sleep(1)
        shot("grid-edit")
    }

    /// A card dragged out of its group in the grid: held at the side of a
    /// card outside the group, it lands beside that card; let go in a
    /// group's box off its cards, at the group's end; and let go below
    /// every card, at the Workspace's end.
    func testGridDragOutOfGroup() {
        waitForBar()
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab'")).firstMatch.tap()
        sleep(2)
        app.buttons["Workspace options"].firstMatch.tap()
        sleep(1)
        app.buttons["Grid"].firstMatch.tap()
        sleep(2)
        app.buttons["Work"].firstMatch.tap()
        sleep(2)
        startEditing()
        sleep(1)
        let card = { (name: String) in
            self.app.collectionViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        }
        shot("grid-drag-before")
        let swift = card("Swift")
        drag(card("Wikipedia"), to: swift.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.4)), marked: "grid-out")
        shot("grid-drag-after")
        XCTAssertEqual(card("Wikipedia").frame.midY, card("Swift").frame.midY, accuracy: 4,
                       "the card left its group for Swift's row")
        // Let go in the group's box beside its last card: Swift joins the
        // group, at its end.
        let besideApple = card("Apple").coordinate(withNormalizedOffset: CGVector(dx: 1.5, dy: 0.5))
        drag(card("Swift"), to: besideApple, marked: "grid-group-end")
        shot("grid-drag-group-end")
        XCTAssertEqual(card("Swift").frame.midY, card("Apple").frame.midY, accuracy: 4, "Swift joined the group")
        XCTAssertGreaterThan(card("Swift").frame.midX, card("Apple").frame.midX, "after its last card")
        // Let go below every card: the group's card leaves it for the
        // Workspace's end.
        let below = card("Wikipedia").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1)).withOffset(CGVector(dx: 0, dy: 60))
        drag(card("Apple"), to: below, marked: "grid-tail")
        shot("grid-drag-tail")
        XCTAssertGreaterThan(card("Apple").frame.midX, card("Wikipedia").frame.midX, "the card landed after Wikipedia")
        XCTAssertEqual(card("Apple").frame.midY, card("Wikipedia").frame.midY, accuracy: 4, "in the Workspace's row")
    }

    /// Setup's pairing code: one field that groups the code in fours as
    /// it's typed or pasted.
    func testPairingCode() {
        app.terminate()
        app.launchArguments = ["-svalDemo", "-svalDemoFresh", "-svalDemoJoin"]
        app.launch()
        let field = app.textFields["Pairing code"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "the pairing code step shows")
        sleep(1)
        shot("code-empty")
        app.typeText("abcd")
        sleep(1)
        shot("code-four")
        app.typeText("efghj")
        sleep(1)
        shot("code-nine")
        XCTAssertEqual(field.value as? String, "ABCD-EFGH-J", "the code groups in fours with dashes")
        app.typeText("km l2")
        sleep(1)
        shot("code-full")
        // Codes read L as 1 (`Codes.bare`), and stop at twelve characters.
        XCTAssertEqual(field.value as? String, "ABCD-EFGH-JKM1", "the code stops at twelve characters")
    }

    /// An empty folder: this iPhone starts syncing in it and shows the new
    /// key's backup, then Settings shows a code for another device.
    func testStartSyncAndShowCode() {
        app.terminate()
        app.launchArguments = ["-svalDemo", "-svalDemoFresh", "-svalDemoStart"]
        app.launch()
        let start = app.buttons["Start Syncing"]
        XCTAssertTrue(start.waitForExistence(timeout: 30), "an empty folder offers to start syncing")
        sleep(1)
        shot("start")
        start.tap()
        XCTAssertTrue(app.staticTexts["Back up your sync key"].waitForExistence(timeout: 10), "the backup key shows")
        sleep(1)
        shot("backup")
        app.buttons["Continue"].tap()
        let browse = app.buttons["Start Browsing"]
        XCTAssertTrue(browse.waitForExistence(timeout: 30), "setup ends on the new sync")
        sleep(3)
        shot("arrived")
        browse.tap()
        XCTAssertTrue(app.buttons["New Tab"].firstMatch.waitForExistence(timeout: 30), "the browser opens")
        sleep(2)
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'tabs' OR label CONTAINS '1 tab' OR label CONTAINS '0 tabs'")).firstMatch.tap()
        sleep(2)
        app.buttons["Settings"].firstMatch.tap()
        sleep(2)
        // Sync is at the end of Settings, above Licenses.
        swipeUp(app.collectionViews.firstMatch)
        sleep(1)
        shot("settings-sync")
        app.buttons["Sync with Another Device"].firstMatch.tap()
        sleep(3)
        shot("pairing-code")
        XCTAssertTrue(app.buttons["Copy Code"].exists, "Settings shows a code for another device")
    }
}
