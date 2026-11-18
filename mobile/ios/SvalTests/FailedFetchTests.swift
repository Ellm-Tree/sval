// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// A fetch the content rules block fails as a page expects, once WebKit
/// applies the rules and `Page.slowFailedFetch` is in the page.
@MainActor
final class FailedFetchTests: XCTestCase {
    private final class Loaded: NSObject, WKNavigationDelegate {
        var finished: CheckedContinuation<Void, Never>?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            finished?.resume()
            finished = nil
        }
    }

    func testBlockedFetchRejectsAfterTheLeastDelay() async throws {
        let storeURL = FileManager.default.temporaryDirectory.appending(path: "rules-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: storeURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: storeURL) }
        let store = try XCTUnwrap(WKContentRuleListStore(url: storeURL))
        let rules = #"[{"action":{"type":"block"},"trigger":{"url-filter":"blocked/"}}]"#
        let compiled = try await store.compileContentRuleList(forIdentifier: "test", encodedContentRuleList: rules)
        let list = try XCTUnwrap(compiled)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(list)
        configuration.userContentController.addUserScript(WKUserScript(
            source: Page.slowFailedFetch, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 640), configuration: configuration)
        let loaded = Loaded()
        view.navigationDelegate = loaded
        await withCheckedContinuation { finished in
            loaded.finished = finished
            view.loadHTMLString("<!doctype html><body></body>", baseURL: URL(string: "https://www.example.com/"))
        }
        let script = """
            const start = performance.now();
            const outcome = await fetch("/blocked/report", { method: "POST", body: "{}", keepalive: true })
              .then(() => "answered", error => error.name);
            return [outcome, performance.now() - start, String(fetch)];
            """
        let value = try await view.callAsyncJavaScript(script, contentWorld: .page)
        let result = try XCTUnwrap(value as? [Any])
        XCTAssertEqual(result[0] as? String, "TypeError")
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(result[1] as? Double), 49)
        XCTAssertTrue(try XCTUnwrap(result[2] as? String).contains("[native code]"))
    }
}
