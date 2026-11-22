// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Network
import UIKit
import XCTest
@testable import Sval

/// A tab's Back and Forward history after the app ends, through the whole
/// app: the model's launch, its tree and a real `Browser` loading pages a
/// server on this machine serves.
@MainActor
final class PageHistoryTests: AppModelTestCase {
    private var server: LocalServer!

    override func setUp() async throws {
        try await super.setUp()
        server = try await LocalServer.start()
        let server = server!
        addTeardownBlock { server.stop() }
    }

    /// The other device's Workspace of `count` tabs, each at a page of its
    /// own, and the phone launched on it.
    private func launched(tabs count: Int) async throws -> (model: AppModel, tabs: [String]) {
        let workspace = AppHarness.id()
        let tabs = (0..<count).map { _ in AppHarness.id() }
        var ops: [[String: Any]] = [["kind": "addWorkspace", "name": "Desk", "id": workspace]]
        for (n, tab) in tabs.enumerated() {
            ops.append(["kind": "addTab", "parent": workspace, "name": "Tab \(n)",
                        "url": server.url("tab-\(n)").absoluteString, "id": tab])
        }
        try await harness.peerEdits(ops)
        return (try await harness.launch(), tabs)
    }

    /// The addresses of `id`'s page's back list, the page it is at and its
    /// forward list.
    private func entries(_ model: AppModel, _ id: String) -> [String] {
        guard let view = model.browser.paneView(id) else { return [] }
        let list = view.backForwardList
        return (list.backList + [list.currentItem].compactMap { $0 } + list.forwardList).map(\.url.lastPathComponent)
    }

    /// Brings `id` to the front and waits for its page to be at `page`.
    private func show(_ model: AppModel, _ id: String, at page: String) async throws {
        model.browser.select(id)
        try await harness.until("tab \(id) at \(page): \(entries(model, id)), at \(model.browser.paneView(id)?.url?.lastPathComponent ?? "none"), loading \(model.browser.paneView(id)?.isLoading ?? false)",
                                limit: .seconds(20)) {
            model.browser.paneView(id)?.url?.lastPathComponent == page && model.browser.paneView(id)?.isLoading == false
        }
    }

    /// Opens `page` in the tab in front and waits for the tree to follow,
    /// as it does once the page has held its address for `Page.settle`.
    private func browse(_ model: AppModel, _ id: String, to page: String) async throws {
        await model.browser.open(server.url(page))
        try await harness.until("the tree follows to \(page)", limit: .seconds(20)) {
            model.row(id)?.url == self.server.url(page).absoluteString
        }
    }

    /// A tab in front with three pages behind it, at the second: one, two,
    /// three, then Back.
    private func browseThree(_ model: AppModel, _ id: String) async throws {
        try await show(model, id, at: "tab-0")
        try await browse(model, id, to: "one")
        try await browse(model, id, to: "two")
        model.browser.goBack()
        try await harness.until("back at one", limit: .seconds(20)) {
            model.row(id)?.url == self.server.url("one").absoluteString
        }
    }

    private func savedFiles() -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: harness.pageStates.path(percentEncoded: false))) ?? []
    }

    /// The tab browsed, let go past the cap on live pages, comes back after
    /// the app ends with its history.
    func testALetGoTabsHistoryComesBackAfterTheAppEnds() async throws {
        let (model, tabs) = try await launched(tabs: 13)
        try await browseThree(model, tabs[0])
        let before = entries(model, tabs[0])
        XCTAssertEqual(before, ["tab-0", "one", "two"])
        for tab in tabs.dropFirst() { try await show(model, tab, at: "tab-\(tabs.firstIndex(of: tab)!)") }
        try await harness.until("the first tab's page is let go") { !model.browser.hasPage(tabs[0]) }
        try await harness.quit()

        let relaunched = try await relaunch(tabs)
        try await show(relaunched, tabs[0], at: "one")
        XCTAssertEqual(entries(relaunched, tabs[0]), before)
    }

    /// The phone launched again over what the last launch left, once its
    /// tree holds `tabs`.
    private func relaunch(_ tabs: [String]) async throws -> AppModel {
        try await harness.launch(ready: { model in tabs.allSatisfy { model.row($0) != nil } })
    }

    /// A tab whose page was live when the app ended, with no warning, as a
    /// crash or a force quit ends it, comes back with its history.
    func testALiveTabsHistoryComesBackAfterTheAppEnds() async throws {
        let (model, tabs) = try await launched(tabs: 3)
        try await browseThree(model, tabs[0])
        try await show(model, tabs[1], at: "tab-1")
        XCTAssertTrue(model.browser.hasPage(tabs[0]), "the first tab's page is live")
        let before = entries(model, tabs[0])
        XCTAssertEqual(before, ["tab-0", "one", "two"])
        try await harness.quit()

        let relaunched = try await relaunch(tabs)
        try await show(relaunched, tabs[0], at: "one")
        XCTAssertEqual(entries(relaunched, tabs[0]), before)
        relaunched.browser.goBack()
        try await harness.until("Back reaches the tab's first page", limit: .seconds(20)) {
            relaunched.browser.paneView(tabs[0])?.url?.lastPathComponent == "tab-0"
        }
    }

    /// The first tab in front, at "one" then "busy-two", and Back asked for
    /// once the tree has followed it. "busy-two" holds its web process as
    /// it is left, past `Page.settle`, so the Back is still under way as
    /// its address settles.
    private func busyBack(_ model: AppModel, _ id: String) async throws {
        try await show(model, id, at: "tab-0")
        try await browse(model, id, to: "one")
        try await browse(model, id, to: "busy-two")
        model.browser.goBack()
        try await harness.until("the tree follows back to one", limit: .seconds(20)) {
            model.row(id)?.url == self.server.url("one").absoluteString
        }
    }

    /// A state written while a Back still loads comes back at the entry
    /// the Back went to, with the forward history behind it. WebKit loads
    /// afresh the address of a load under way when it restores a state
    /// taken during it (`WebPageProxy::restoreFromSessionState`).
    func testAnAppEndingDuringABackKeepsTheForwardHistory() async throws {
        let (model, tabs) = try await launched(tabs: 2)
        try await busyBack(model, tabs[0])
        XCTAssertEqual(model.browser.paneView(tabs[0])?.isLoading, true, "the Back ended within Page.settle")
        try await harness.quit()

        let relaunched = try await relaunch(tabs)
        try await show(relaunched, tabs[0], at: "one")
        XCTAssertEqual(entries(relaunched, tabs[0]), ["tab-0", "one", "busy-two"])
        XCTAssertEqual(relaunched.browser.paneView(tabs[0])?.backForwardList.forwardList.map(\.url.lastPathComponent),
                       ["busy-two"])
    }

    /// The tab in front as the app ended, whose page the launch makes,
    /// comes back with its history.
    func testTheTabInFrontComesBackAtLaunch() async throws {
        let (model, tabs) = try await launched(tabs: 2)
        try await browseThree(model, tabs[0])
        let before = entries(model, tabs[0])
        try await harness.quit()

        // The launch makes the page of the tab saved in front before it
        // opens on this phone's own Workspace.
        let relaunched = try await relaunch(tabs)
        XCTAssertTrue(relaunched.browser.hasPage(tabs[0]), "the launch made no page for the tab in front")
        try await harness.until("the launch puts the tab in front back: \(entries(relaunched, tabs[0]))",
                                limit: .seconds(20)) {
            self.entries(relaunched, tabs[0]) == before
        }
        XCTAssertEqual(relaunched.browser.paneView(tabs[0])?.url?.lastPathComponent, "one")
    }

    /// A tab whose saved state is at another address than its tab, as one
    /// written just before the app ended, before the tree took the
    /// address, comes back at the tab's address with the history behind.
    func testATabAtAnotherAddressKeepsItsHistory() async throws {
        let (model, tabs) = try await launched(tabs: 2)
        try await show(model, tabs[0], at: "tab-0")
        try await browse(model, tabs[0], to: "one")
        try await browse(model, tabs[0], to: "two")
        let atTwo = try XCTUnwrap(model.browser.paneView(tabs[0])?.interactionState)
        model.browser.goBack()
        try await harness.until("back at one", limit: .seconds(20)) {
            model.row(tabs[0])?.url == self.server.url("one").absoluteString
        }
        try await harness.quit()
        let states = PageStates(directory: harness.pageStates)
        states.keep(tabs[0], state: atTwo, address: server.url("two").absoluteString, isTab: true, isPrivate: false)
        await withCheckedContinuation { done in states.whenWritten { done.resume() } }

        let relaunched = try await relaunch(tabs)
        try await show(relaunched, tabs[0], at: "one")
        XCTAssertEqual(entries(relaunched, tabs[0]), ["tab-0", "one", "two", "one"])
    }

    /// The launch reads the tree before it forgets the states of tabs that
    /// left it, so a launch keeps every tab's state.
    func testALaunchKeepsTheSavedStates() async throws {
        let (model, tabs) = try await launched(tabs: 13)
        for (n, tab) in tabs.enumerated() { try await show(model, tab, at: "tab-\(n)") }
        try await harness.until("pages past the cap are let go") { !model.browser.hasPage(tabs[0]) }
        // The last tab's page writes as it settles, after it has loaded.
        let last = PageStatesTests.fileName(tabs[tabs.count - 1])
        try await harness.until("the last tab's state is written") { self.savedFiles().contains(last) }
        let saved = savedFiles().count
        XCTAssertGreaterThanOrEqual(saved, 3, "the pages let go wrote their states")
        try await harness.quit()

        let relaunched = try await relaunch(tabs)
        await relaunched.browser.statesWritten()
        XCTAssertEqual(savedFiles().count, saved, "the launch removed saved states")
    }

    /// Leaving the front writes every live tab's state, never a private
    /// tab's.
    private func leaveTheFront(_ model: AppModel) async {
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        await model.browser.statesWritten()
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// A private tab's page writes nothing to disk, as it settles or as
    /// the app leaves the front, while a tab of the user's beside it does.
    func testAPrivateTabWritesNothing() async throws {
        let (model, tabs) = try await launched(tabs: 1)
        try await show(model, tabs[0], at: "tab-0")
        let opened = await model.openPrivateSession()
        let session = try XCTUnwrap(opened)
        let secret = AppHarness.id()
        let added = await model.editTree([["kind": "addTab", "parent": session, "name": "Secret",
                                           "url": server.url("secret-0").absoluteString, "id": secret]])
        XCTAssertTrue(added)
        try await show(model, secret, at: "secret-0")
        await model.browser.open(server.url("secret-1"))
        try await harness.until("the private page moves on", limit: .seconds(20)) {
            model.browser.paneView(secret)?.url?.lastPathComponent == "secret-1"
        }
        // Past `Page.settle`, when a page's state is written.
        try await Task.sleep(for: Page.settle * 2)
        await leaveTheFront(model)
        let secretFile = PageStatesTests.fileName(secret)
        XCTAssertFalse(savedFiles().contains(secretFile), "a private tab's state is on disk")
        XCTAssertTrue(savedFiles().contains(PageStatesTests.fileName(tabs[0])), "the user's tab's state was not written")
    }

    /// Clear Browsing Data removes the states written as the app left the
    /// front.
    func testClearingBrowsingDataRemovesTheStatesWrittenOnLeaving() async throws {
        let (model, tabs) = try await launched(tabs: 2)
        try await browseThree(model, tabs[0])
        try await show(model, tabs[1], at: "tab-1")
        await leaveTheFront(model)
        XCTAssertEqual(Set(savedFiles()), Set(tabs.map(PageStatesTests.fileName)))
        await model.browser.clearBrowsingData()
        await model.browser.statesWritten()
        XCTAssertEqual(savedFiles(), [], "Clear Browsing Data left states on disk")
    }
}

/// An HTTP server on this machine's loopback address that serves a small
/// page at every path, so tests load pages with no network. A page whose
/// name starts with "busy" holds its web process for `busyFor` milliseconds
/// as it is left.
final class LocalServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "app.sval.ios.tests.server")
    let port: UInt16
    /// Milliseconds, past `Page.settle`, so the load that leaves a busy
    /// page is still under way when its address has settled.
    static let busyFor = 3000

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        self.port = port
    }

    static func start() async throws -> LocalServer {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        let queue = DispatchQueue(label: "app.sval.ios.tests.server.start")
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
            listener.newConnectionHandler = { LocalServer.serve($0) }
            listener.start(queue: queue)
        }
        return LocalServer(listener: listener, port: port)
    }

    func url(_ page: String) -> URL {
        URL(string: "http://127.0.0.1:\(port)/\(page)")!
    }

    func stop() { listener.cancel() }

    private static let busyScript =
        "<script>addEventListener('pagehide', () => { const t = Date.now(); while (Date.now() - t < \(busyFor)) {} })</script>"

    private static func serve(_ connection: NWConnection) {
        let queue = DispatchQueue(label: "app.sval.ios.tests.server.connection")
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
            let request = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            let name = path.split(separator: "/").last.map(String.init) ?? "index"
            // Tall, so the page has somewhere to scroll.
            let body = "<!doctype html><meta name=viewport content='width=device-width'><title>\(name)</title>"
                + "<body style='height:4000px'><p>\(name)</p></body>"
                + (name.hasPrefix("busy") ? busyScript : "")
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\n"
                + "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
            connection.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }
}
