// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Network
import Observation
import WebKit
import XCTest
@testable import Sval

/// Serves pages over HTTP on the loopback interface: `/slow` sends its
/// 200 KB in 40 parts 40 ms apart, so its load reports progress many
/// times, and any other path answers at once.
private final class PageServer: @unchecked Sendable {
    private let listener: NWListener
    /// Known once the listener is ready. Before then the listener reports
    /// port 0, where a load is refused.
    let port: UInt16

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        self.port = port
    }

    static func start() async throws -> PageServer {
        let listener = try NWListener(using: .tcp, on: .any)
        let queue = DispatchQueue(label: "app.sval.ios.tests.pages")
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            // Called on `queue` alone, and cleared once it has answered.
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    listener.stateUpdateHandler = nil
                    continuation.resume(returning: listener.port?.rawValue ?? 0)
                case .failed(let error):
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default: break
                }
            }
            listener.newConnectionHandler = { PageServer.serve($0, on: queue) }
            listener.start(queue: queue)
        }
        return PageServer(listener: listener, port: port)
    }

    func stop() { listener.cancel() }

    private static func serve(_ connection: NWConnection, on queue: DispatchQueue) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
            let request = String(decoding: data ?? Data(), as: UTF8.self)
            let slow = request.hasPrefix("GET /slow ")
            let part = 5000, parts = slow ? 40 : 1
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: \(part * parts)\r\n"
                + "Connection: close\r\n\r\n"
            connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
            func send(_ n: Int) {
                let first = n == 0 ? "<!doctype html><title>Page</title><p>" : ""
                let body = first + String(repeating: "x", count: part - first.utf8.count)
                queue.asyncAfter(deadline: .now() + (slow ? 0.04 : 0)) {
                    connection.send(content: Data(body.utf8), completion: .contentProcessed { _ in
                        if n == parts - 1 { connection.cancel() } else { send(n + 1) }
                    })
                }
            }
            send(0)
        }
    }
}

/// Counts each write of a browser's bar facts once tracking starts.
@MainActor
private final class BarWrites: @unchecked Sendable {
    private let browser: Browser
    private(set) var count = 0

    init(_ browser: Browser) {
        self.browser = browser
    }

    func track() {
        withObservationTracking { _ = browser.bar } onChange: { [self] in
            MainActor.assumeIsolated { count += 1 }
            Task { @MainActor in track() }
        }
    }
}

/// The bar's facts (`BarFacts`) change with what the bar shows, and with
/// nothing else: a page's progress and changes elsewhere leave them, and
/// so the bar, as they are.
final class BarFactsTests: AppModelTestCase {
    private var server: PageServer!
    /// The window the page in front shows in. The browser makes no page
    /// while the app has no window in front (`makeShownPages`).
    private var window: UIWindow!

    override func setUp() async throws {
        try await super.setUp()
        let server = try await PageServer.start()
        self.server = server
        addTeardownBlock { server.stop() }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        window = UIWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        addTeardownBlock { @MainActor [window] in window?.isHidden = true }
    }

    private func page(_ host: String, _ path: String = "/page") throws -> URL {
        try XCTUnwrap(URL(string: "http://\(host):\(server.port)\(path)"))
    }

    /// Launches the phone and loads `url` in a new tab in front.
    private func launchedShowing(_ url: URL) async throws -> AppModel {
        let model = try await harness.launch()
        await model.browser.open(url)
        let view = try XCTUnwrap(model.browser.currentPage())
        view.frame = window.bounds
        window.rootViewController?.view.addSubview(view)
        try await loaded(url, in: model)
        return model
    }

    private func loaded(_ url: URL, in model: AppModel) async throws {
        try await harness.until("\(url.path()) loaded: at \(model.browser.currentURL?.absoluteString ?? "none"), loading \(model.browser.loading), page \(model.browser.currentPage()?.url?.absoluteString ?? "none")", limit: .seconds(20)) {
            model.browser.currentURL == url && !model.browser.loading
        }
    }

    /// Counts the writes of the bar's facts while `body` runs.
    private func barWrites(_ model: AppModel, during body: () async throws -> Void) async rethrows -> Int {
        let writes = BarWrites(model.browser)
        writes.track()
        try await body()
        return writes.count
    }

    /// The address the bar shows follows the page in front's address,
    /// which the page reports with no other change to the bar.
    func testTheAddressFollowsThePage() async throws {
        let first = try page("127.0.0.1")
        let model = try await launchedShowing(first)
        XCTAssertEqual(model.browser.bar.address, .text("127.0.0.1", placeholder: false))
        XCTAssertTrue(model.browser.bar.reloads)
        let second = try page("localhost")
        await model.browser.open(second)
        // Checked as the address changes, ahead of the visit's write to
        // the tree, which would set the facts again.
        try await harness.until("the page is at its new address") { model.browser.currentURL == second }
        XCTAssertEqual(model.browser.bar.address, .text("localhost", placeholder: false))
    }

    /// A load reports its progress many times, and the bar's facts stay as
    /// they were through all of it.
    func testALoadsProgressLeavesTheFactsAlone() async throws {
        let model = try await launchedShowing(try page("127.0.0.1", "/slow"))
        let before = model.browser.bar
        var progress: Set<Double> = []
        let writes = try await barWrites(model) {
            model.browser.reload()
            try await harness.until("the reload starts") { model.browser.loading }
            try await harness.until("the reload ends", limit: .seconds(20)) {
                progress.insert(model.browser.progress)
                return !model.browser.loading
            }
        }
        XCTAssertGreaterThan(progress.count, 3, "the load reported its progress")
        XCTAssertEqual(writes, 0, "the bar's facts were set during the load")
        XCTAssertEqual(model.browser.bar, before)
    }

    /// A setting the bar shows, a rename of the Workspace shown and a tab
    /// added to it each change the facts as they arrive. A setting the bar
    /// doesn't show and an edit of another Workspace leave them alone.
    func testEachInputChangesTheFactsAndNothingElseDoes() async throws {
        let model = try await launchedShowing(try page("127.0.0.1"))
        let browser = model.browser!
        let shown = try XCTUnwrap(browser.workspaceId)
        let other = AppHarness.id()
        _ = await model.editTree([["kind": "addWorkspace", "name": "Other", "id": other]])
        _ = await model.editTree([["kind": "addTab", "parent": other, "name": "Away", "url": "about:blank",
                                   "id": AppHarness.id()]])
        await harness.pass()

        let unrelated = try await barWrites(model) {
            await model.setSetting("sval.test.choice", to: "there")
            let away = try XCTUnwrap(model.tabs(in: other).first)
            await model.rename(away, to: "Renamed")
            await harness.pass()
        }
        XCTAssertEqual(unrelated, 0, "a change the bar doesn't show set its facts")

        let line = try XCTUnwrap(MyFilters.adding("127.0.0.1##.ad", settings: model.settings))
        await model.setSetting(line.key, to: line.value)
        try await harness.until("the line is set") { model.settings[line.key] != nil }
        XCTAssertEqual(browser.bar.removals, 1, "My filters' line counts at once")

        let rule = SiteRules(settings: model.settings).javaScriptChange(for: "127.0.0.1", enabled: false)
        await model.setSetting(rule.key, to: rule.value)
        try await harness.until("the rule is set") { model.settings[rule.key] != nil }
        XCTAssertTrue(browser.bar.javaScriptOff, "the site's JavaScript rule shows at once")

        let workspace = try XCTUnwrap(model.row(shown))
        await model.rename(workspace, to: "Renamed Workspace")
        try await harness.until("the rename shows") { model.row(shown)?.name == "Renamed Workspace" }
        XCTAssertEqual(browser.bar.workspace?.name, "Renamed Workspace")

        let tabs = model.tabs(in: shown).count
        XCTAssertEqual(browser.bar.tabCount, tabs)
        _ = await model.editTree([["kind": "addTab", "parent": shown, "name": "More", "url": "about:blank",
                                   "id": AppHarness.id()]])
        try await harness.until("the tab shows") { model.tabs(in: shown).count == tabs + 1 }
        XCTAssertEqual(browser.bar.tabCount, tabs + 1)
    }

    // MARK: Media, pins and the private session

    /// The page's word that its media plays, or that Picture in Picture
    /// holds it, as its frame's script reports it (`PlaybackReport`).
    private func reportPlaying(_ view: WKWebView, pip: Bool = false) async throws {
        _ = try await view.evaluateJavaScript(
            "webkit.messageHandlers.svalPlayback.postMessage({frame: 'f', playing: true, pip: \(pip)}); 1",
            contentWorld: .defaultClient)
    }

    /// The guard's word that Ask first refused the page's media
    /// (`BlockedReport`).
    private func reportRefused(_ view: WKWebView) async throws {
        _ = try await view.evaluateJavaScript("webkit.messageHandlers.svalMediaBlocked.postMessage('no tap'); 1",
                                              contentWorld: .page)
    }

    /// Media playing in front shows as the page's own, and once Picture in
    /// Picture holds it, the bar shows it no more.
    func testThePageInFrontsMediaShowsAtOnce() async throws {
        let model = try await launchedShowing(try page("127.0.0.1"))
        let browser = model.browser!
        let front = try XCTUnwrap(browser.currentTabId)
        try await reportPlaying(try XCTUnwrap(browser.currentPage()))
        try await harness.until("the media plays") { browser.playingTabs.contains(front) }
        XCTAssertEqual(browser.bar.frontMedia, front, "the page's media shows at once")
        try await reportPlaying(try XCTUnwrap(browser.currentPage()), pip: true)
        try await harness.until("Picture in Picture holds it") { browser.inPictureInPicture(front) }
        XCTAssertNil(browser.bar.frontMedia, "Picture in Picture's media leaves the bar at once")
    }

    /// Another tab's media shows beside the page in front, and goes once
    /// Keep Playing is off.
    func testAnotherTabsMediaShowsAtOnce() async throws {
        let model = try await launchedShowing(try page("127.0.0.1"))
        let browser = model.browser!
        let behind = try XCTUnwrap(browser.currentTabId)
        let workspace = try XCTUnwrap(browser.workspaceId)
        await browser.openNewTab(try page("localhost"), in: workspace)
        try await harness.until("the new tab is in front") { browser.currentTabId != behind }
        try await reportPlaying(try XCTUnwrap(browser.paneView(behind)))
        try await harness.until("the media plays") { browser.playingTabs.contains(behind) }
        XCTAssertEqual(browser.bar.otherMedia, behind, "the other tab's media shows at once")
        browser.keepPlaying = false
        XCTAssertNil(browser.bar.otherMedia, "the other tab's media goes at once")
    }

    /// Ask first's refusal shows its ask, and closing the ask takes it
    /// away.
    func testTheAskShowsAndClosesAtOnce() async throws {
        let model = try await launchedShowing(try page("127.0.0.1"))
        let browser = model.browser!
        try await reportRefused(try XCTUnwrap(browser.currentPage()))
        try await harness.until("the media is refused") { browser.frontAsks }
        XCTAssertTrue(browser.bar.asks, "the ask shows at once")
        browser.closeAsk()
        XCTAssertFalse(browser.bar.asks, "the closed ask goes at once")
    }

    /// A pin's page reads as the pin, and a rename of the pin shows.
    func testAPinsRenameShowsAtOnce() async throws {
        let url = try page("127.0.0.1")
        let model = try await launchedShowing(url)
        let browser = model.browser!
        let tab = try XCTUnwrap(browser.currentTabId.flatMap(model.row))
        await browser.pin(tab, url: url)
        let pin = try XCTUnwrap(browser.currentPin)
        XCTAssertEqual(browser.bar.address, .text(pin.name.isEmpty ? url.absoluteString : pin.name, placeholder: false))
        await model.renamePin(pin, to: "Renamed Pin")
        try await harness.until("the rename arrives") { browser.currentPin?.name == "Renamed Pin" }
        XCTAssertEqual(browser.bar.address, .text("Renamed Pin", placeholder: false))
    }

    /// Turning protections off for a site in the private session shows on
    /// its shield.
    func testAPrivateProtectionsChangeShowsAtOnce() async throws {
        let model = try await harness.launch()
        let browser = model.browser!
        let shown = await model.showPrivateSession()
        XCTAssertTrue(shown)
        let url = try page("127.0.0.1")
        await browser.open(url)
        let view = try XCTUnwrap(browser.currentPage())
        view.frame = window.bounds
        window.rootViewController?.view.addSubview(view)
        try await loaded(url, in: model)
        XCTAssertTrue(browser.privateInFront)
        XCTAssertEqual(browser.bar.shield, .on)
        model.setPrivateProtections(SiteRules.site(of: "127.0.0.1") ?? "127.0.0.1", on: false)
        XCTAssertEqual(browser.bar.shield, .off, "the shield shows protections off at once")
    }
}
