// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// The Privacy Pass stock against a Kagi and an engine of the test's own,
/// and a private page of `kagi.com` spending it.
@MainActor
final class KagiPrivacyPassTests: XCTestCase {
    /// What the fake Kagi answers the issuance POST with, and what it saw.
    private final class Kagi {
        var status = 200
        var body = "answer"
        var tokens: [String] = (0..<300).map { "t\($0)" }
        var issued = 0
        var store: Data?
        var now = Date(timeIntervalSince1970: 1_790_000_000) // 2026-09-21
        var session: String? = "session"
        var authorization: String?
        var cookies: Bool?

        var host: KagiPrivacyPass.Host {
            KagiPrivacyPass.Host(
                read: { [unowned self] in store },
                write: { [unowned self] in store = $0 },
                now: { [unowned self] in now },
                session: { [unowned self] in session },
                send: { [unowned self] request in
                    let url = request.url!
                    if url == KagiPrivacyPass.challengeURL {
                        return (Data(), HTTPURLResponse(url: url, statusCode: 401, httpVersion: nil,
                                                        headerFields: ["WWW-Authenticate": "challenge"])!)
                    }
                    authorization = request.value(forHTTPHeaderField: "Authorization")
                    return (Data(body.utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                                                             headerFields: [:])!)
                },
                tokenRequest: { challenge, count in
                    XCTAssertEqual(challenge, "challenge")
                    XCTAssertEqual(count, KagiPrivacyPass.batch)
                    return KagiTokenRequest(body: "request", state: "state")
                },
                finalize: { [unowned self] _, _ in
                    issued += 1
                    return tokens
                }
            )
        }
    }

    func testARefillFillsTheStockAndTokensGoNewestFirst() async {
        let kagi = Kagi()
        kagi.tokens = ["a", "b"]
        let pass = KagiPrivacyPass(host: kagi.host)
        await pass.refill().value
        XCTAssertEqual(kagi.authorization, "session")
        XCTAssertEqual(pass.state, .ready)
        // The stock is low, so the first take refills, behind the first
        // batch.
        XCTAssertEqual(pass.take(), "b")
        kagi.tokens = ["c"]
        await pass.refill().value
        XCTAssertEqual(pass.take(), "a")
        XCTAssertEqual(pass.take(), "c")
    }

    func testTheStockOutlivesTheProcessAndDropsRetiredTokens() async throws {
        let kagi = Kagi()
        kagi.tokens = ["kept"]
        let first = KagiPrivacyPass(host: kagi.host)
        await first.refill().value
        XCTAssertEqual(KagiPrivacyPass(host: kagi.host).count, 1)
        // Tokens issued before the start of the previous month are gone.
        kagi.now = KagiPrivacyPass.month(from: kagi.now, by: 2)
        XCTAssertEqual(KagiPrivacyPass(host: kagi.host).count, 0)
        XCTAssertNil(kagi.store)
    }

    func testNoSessionAsksKagiNothing() async {
        let kagi = Kagi()
        kagi.session = nil
        let pass = KagiPrivacyPass(host: kagi.host)
        await pass.refill().value
        XCTAssertNil(kagi.authorization)
        XCTAssertEqual(pass.state, .signedOut)
    }

    func testAUsedAllowanceWaitsForNextMonth() async {
        let kagi = Kagi()
        kagi.status = 429
        let pass = KagiPrivacyPass(host: kagi.host)
        await pass.refill().value
        XCTAssertEqual(pass.state, .out)
        XCTAssertEqual(pass.outUntil, KagiPrivacyPass.month(from: kagi.now, by: 1))
        kagi.authorization = nil
        await pass.refill().value
        XCTAssertNil(kagi.authorization, "a used allowance asked Kagi again")

        kagi.status = 200
        kagi.now = KagiPrivacyPass.month(from: kagi.now, by: 1)
        XCTAssertEqual(pass.state, .signedOut)
        await pass.refill().value
        XCTAssertEqual(pass.state, .ready)
    }

    func testAPlanWithoutPrivacyPassIsAskedAgainOnlyOnSignIn() async {
        let kagi = Kagi()
        kagi.status = 403
        kagi.body = #"{"error_code":"no_subscription"}"#
        let pass = KagiPrivacyPass(host: kagi.host)
        await pass.refill().value
        XCTAssertEqual(pass.state, .unsupported)
        kagi.authorization = nil
        await pass.refill().value
        XCTAssertNil(kagi.authorization)

        kagi.status = 200
        kagi.body = "answer"
        await pass.refill(askAgain: true).value
        XCTAssertEqual(pass.state, .ready)
    }

    func testOnlyKagisOwnPagesOverHttpsAreSignedIn() {
        for address in ["https://kagi.com/", "https://kagi.com/search?q=a", "https://KAGI.com/images?q=a",
                        "https://kagi.com/?q=a", "https://kagi.com/html/search?q=a", "https://kagi.com/mother/context"] {
            XCTAssertTrue(KagiSpend.isKagiPage(URL(string: address)!), address)
        }
        for address in ["http://kagi.com/search?q=a", "https://www.kagi.com/search?q=a", "https://kagi.com/signin",
                        "https://kagi.com.evil.example/search", "https://kagi.com:8443/search", "https://kagi.com/api/x"] {
            XCTAssertFalse(KagiSpend.isKagiPage(URL(string: address)!), address)
        }
    }

    // MARK: A private page of kagi.com

    private final class Loaded: NSObject, WKNavigationDelegate {
        var finished: CheckedContinuation<Void, Never>?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            finished?.resume()
            finished = nil
        }
    }

    /// A page at `base` with the private tab's scripts, whose fetch and XHR
    /// record the headers they would send instead of sending.
    private func page(at base: String, tokens: KagiPrivacyPass) async -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let controller = configuration.userContentController
        controller.addUserScript(WKUserScript(source: """
            window.sent = [];
            window.fetch = (input, init) => {
              const request = new Request(input, init);
              sent.push({ url: request.url, authorization: request.headers.get("Authorization"),
                          client: request.headers.get("X-Kagi-PrivacyPass-Client") });
              return Promise.resolve(new Response("ok"));
            };
            const headers = new WeakMap();
            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
              headers.set(this, Object.assign(headers.get(this) || {}, { [name]: value }));
            };
            XMLHttpRequest.prototype.send = function () {
              const set = headers.get(this) || {};
              sent.push({ url: "xhr", authorization: set.Authorization || null, client: set["X-Kagi-PrivacyPass-Client"] || null });
            };
            """, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        controller.addUserScript(WKUserScript(
            source: KagiSpend.pageScript, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        controller.addUserScript(WKUserScript(
            source: KagiSpend.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: false,
            in: .defaultClient))
        controller.addScriptMessageHandler(KagiSpend.TokenReply(tokens), contentWorld: .defaultClient,
                                           name: KagiSpend.message)
        let view = WKWebView(frame: .zero, configuration: configuration)
        let loaded = Loaded()
        view.navigationDelegate = loaded
        await withCheckedContinuation { continuation in
            loaded.finished = continuation
            view.loadHTMLString("<p>page</p>", baseURL: URL(string: base)!)
        }
        return view
    }

    private func sent(by view: WKWebView, running script: String) async throws -> [[String: String]] {
        let result = try await view.callAsyncJavaScript(
            script + "; await new Promise(r => setTimeout(r, 50)); return JSON.stringify(sent);",
            contentWorld: .page)
        let data = Data((result as? String ?? "[]").utf8)
        let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
        return rows.map { $0.compactMapValues { $0 as? String } }
    }

    func testKagisOwnFetchAndXhrSpendATokenEach() async throws {
        let kagi = Kagi()
        kagi.tokens = ["one", "two"]
        let pass = KagiPrivacyPass(host: kagi.host)
        await pass.refill().value
        let view = await page(at: "https://kagi.com/search?q=a", tokens: pass)
        let sent = try await sent(by: view, running: """
            await fetch("/search?q=b");
            await fetch("/api/other");
            const xhr = new XMLHttpRequest();
            xhr.open("GET", "/mother/context");
            xhr.send();
            """)
        XCTAssertEqual(sent.count, 3)
        XCTAssertEqual(sent[0]["authorization"], #"PrivateToken token="two""#)
        XCTAssertEqual(sent[0]["client"], "true")
        XCTAssertNil(sent[1]["authorization"], "a path outside Kagi's own pages got a token")
        XCTAssertEqual(sent[2]["authorization"], #"PrivateToken token="one""#)
    }

    func testAnotherSitesPageGetsNoToken() async throws {
        let kagi = Kagi()
        let pass = KagiPrivacyPass(host: kagi.host)
        await pass.refill().value
        let view = await page(at: "https://example.com/", tokens: pass)
        let sent = try await sent(by: view, running: #"await fetch("https://kagi.com/search?q=a", { mode: "no-cors" });"#)
        XCTAssertEqual(sent.count, 1)
        XCTAssertNil(sent[0]["authorization"])
        XCTAssertEqual(pass.count, 300)
    }
}
