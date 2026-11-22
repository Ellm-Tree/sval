// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// The states of pages let go, which a tab's page takes back after the
/// app ends.
@MainActor
final class PageStatesTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = try temporaryDirectory(self).appending(path: "PageStates", directoryHint: .isDirectory)
    }

    /// A page that loads `sval-test:` addresses from `LocalPages`, with no
    /// network.
    private func makePage(privately: Bool = false) -> Page {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(LocalPages(), forURLScheme: LocalPages.scheme)
        return Page(tabId: "tab", media: .allow, privateStore: privately ? .nonPersistent() : nil,
                    configuration: configuration, scriptAllowed: { _, _ in true },
                    onNavigate: { _, _, _, _, _ in }, onState: {}, onScroll: { _, _ in })
    }

    /// Runs `start` and waits for `page`'s document to commit.
    private func committing(_ page: Page, _ start: () -> Void) async {
        let committed = expectation(description: "the document commits")
        page.onLoad = { committed.fulfill() }
        start()
        await fulfillment(of: [committed], timeout: 20)
        page.onLoad = nil
    }

    /// A page with three entries, standing at the second.
    private func pageWithHistory(privately: Bool = false) async -> Page {
        let page = makePage(privately: privately)
        for name in ["one", "two", "three"] {
            await committing(page) {
                page.load(URL(string: "\(LocalPages.scheme)://pages/\(name)")!)
            }
        }
        await committing(page) { page.view.goBack() }
        return page
    }

    private func entries(_ page: Page) -> [String] {
        let list = page.view.backForwardList
        return (list.backList + [list.currentItem].compactMap { $0 } + list.forwardList).map(\.url.absoluteString)
    }

    /// Waits for every write `states` was asked for to land.
    private func written(_ states: PageStates) async {
        await withCheckedContinuation { done in states.whenWritten { done.resume() } }
    }

    private func files() -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))) ?? []
    }

    func testATabsStateComesBackAfterTheAppEnds() async throws {
        let page = await pageWithHistory()
        let before = entries(page)
        XCTAssertEqual(before.count, 3)
        let state = try XCTUnwrap(page.view.interactionState)
        XCTAssertTrue(state is Data, "WebKit's interaction state is \(type(of: state))")
        let ending = PageStates(directory: directory)
        ending.keep("tab", state: state, address: page.view.url?.absoluteString, isTab: true, isPrivate: false)
        await written(ending)
        page.close()
        // The app ended: another store, over the same folder.
        let restored = try XCTUnwrap(PageStates(directory: directory).take("tab"))
        XCTAssertEqual(restored.address, "sval-test://pages/two")
        let again = makePage()
        await committing(again) { again.restore(restored.state, at: restored.address) }
        XCTAssertEqual(entries(again), before)
        XCTAssertEqual(again.view.url?.absoluteString, "sval-test://pages/two")
        XCTAssertEqual(again.view.backForwardList.forwardList.count, 1)
        // The file stays until the page writes its own state over it.
        XCTAssertEqual(files().count, 1, "a state taken back is gone from disk")
    }

    func testAPrivateTabWritesNothing() async throws {
        let page = await pageWithHistory(privately: true)
        XCTAssertTrue(page.isPrivate)
        let state = try XCTUnwrap(page.view.interactionState)
        let states = PageStates(directory: directory)
        states.keep("tab", state: state, address: page.view.url?.absoluteString, isTab: true, isPrivate: page.isPrivate)
        XCTAssertFalse(states.save("tab", state: state, address: nil, isTab: true, isPrivate: page.isPrivate))
        await written(states)
        XCTAssertNotNil(states.saved("tab"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path(percentEncoded: false)))
        XCTAssertNil(PageStates(directory: directory).saved("tab"))
    }

    func testAPinsStateStaysInMemory() async {
        let states = PageStates(directory: directory)
        states.keep(Browser.pinKey("guid", in: "workspace"), state: Data([1]), address: nil, isTab: false, isPrivate: false)
        await written(states)
        XCTAssertTrue(files().isEmpty)
    }

    /// Clear Browsing Data takes every let-go page's state, tabs' and
    /// pins', from disk and memory, and leaves the private session's.
    func testClearingBrowsingDataForgetsTheStates() async {
        let states = PageStates(directory: directory)
        let pin = Browser.pinKey("guid", in: "workspace")
        states.keep("tab", state: Data([1]), address: nil, isTab: true, isPrivate: false)
        states.keep(pin, state: Data([1]), address: nil, isTab: false, isPrivate: false)
        states.keep("private", state: Data([1]), address: nil, isTab: true, isPrivate: true)
        await written(states)
        XCTAssertEqual(files().count, 1)
        states.forgetAll(keeping: { $0 == "private" })
        await written(states)
        XCTAssertTrue(files().isEmpty, "the folder holds \(files())")
        XCTAssertNil(states.take("tab"))
        XCTAssertNil(states.take(pin))
        XCTAssertNil(PageStates(directory: directory).take("tab"))
        XCTAssertNotNil(states.take("private"))
    }

    /// A live page's state is written to disk alone, and only when it
    /// changed since its last write.
    func testALivePagesStateIsWrittenWhenItChanges() async {
        let states = PageStates(directory: directory)
        XCTAssertTrue(states.save("tab", state: Data([1]), address: "a", isTab: true, isPrivate: false))
        XCTAssertFalse(states.save("tab", state: Data([1]), address: "a", isTab: true, isPrivate: false))
        XCTAssertTrue(states.save("tab", state: Data([2]), address: "b", isTab: true, isPrivate: false))
        XCTAssertFalse(states.save("pin", state: Data([1]), address: "a", isTab: false, isPrivate: false))
        await written(states)
        XCTAssertEqual(files(), [Self.fileName("tab")])
        XCTAssertEqual(PageStates(directory: directory).saved("tab")?.address, "b")
        // Taken for a page, the state stays on disk for the next launch.
        XCTAssertEqual(states.take("tab")?.address, "b")
        await written(states)
        XCTAssertEqual(PageStates(directory: directory).saved("tab")?.address, "b")
    }

    /// A page that has shown nothing yet, as one waiting for the blocker
    /// at launch, keeps no state: the view's own is an empty history,
    /// which would replace the tab's saved one.
    func testAPageThatShowedNothingKeepsNoState() throws {
        let page = makePage()
        let empty = try XCTUnwrap(page.view.interactionState as? Data, "WebKit gives no state for an empty view")
        XCTAssertFalse(empty.isEmpty)
        XCTAssertNil(page.keptState)
        page.close()
    }

    func testAStateGoesWithItsTab() async {
        let states = PageStates(directory: directory)
        for id in ["kept", "closed", "gone"] {
            states.keep(id, state: Data([1]), address: nil, isTab: true, isPrivate: false)
        }
        states.forget("closed")
        states.keep(live: { $0 == "kept" }, onDisk: { $0 == "kept" }, tabs: 1)
        await written(states)
        let later = PageStates(directory: directory)
        XCTAssertNotNil(later.saved("kept"))
        XCTAssertNil(later.saved("closed"))
        XCTAssertNil(later.saved("gone"))
        XCTAssertEqual(files().count, 1)
    }

    func testTheOldestStatesGoPastTheBound() async throws {
        let states = PageStates(directory: directory)
        let past = Date.now.addingTimeInterval(-3600)
        for index in 0..<PageStates.kept {
            states.keep("tab-\(index)", state: Data([1]), address: nil, isTab: true, isPrivate: false)
        }
        await written(states)
        let urls = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(urls.count, PageStates.kept)
        // Written in the ids' order, an hour ago, a second apart.
        for url in urls {
            let id = try XCTUnwrap(idOf(url, among: PageStates.kept))
            try FileManager.default.setAttributes(
                [.modificationDate: past.addingTimeInterval(Double(id))], ofItemAtPath: url.path(percentEncoded: false))
        }
        states.keep("newest", state: Data([1]), address: nil, isTab: true, isPrivate: false)
        await written(states)
        let later = PageStates(directory: directory)
        XCTAssertEqual(files().count, PageStates.kept)
        XCTAssertNil(later.saved("tab-0"))
        XCTAssertNotNil(later.saved("tab-1"))
        XCTAssertNotNil(later.saved("newest"))
    }

    /// The index of the `tab-<n>` id `url` is named for.
    private func idOf(_ url: URL, among count: Int) -> Int? {
        (0..<count).first { url.lastPathComponent == Self.fileName("tab-\($0)") }
    }

    /// The name of the file `id`'s state is kept in.
    static func fileName(_ id: String) -> String {
        Data(id.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Serves a small page at every `sval-test:` address.
final class LocalPages: NSObject, WKURLSchemeHandler {
    static let scheme = "sval-test"

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let url = task.request.url!
        let body = Data("<!doctype html><title>\(url.lastPathComponent)</title><p>\(url.lastPathComponent)</p>".utf8)
        task.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: body.count,
                                    textEncodingName: "utf-8"))
        task.didReceive(body)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}
