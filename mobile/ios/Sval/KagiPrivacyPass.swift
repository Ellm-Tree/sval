// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import WebKit

/// Kagi's Privacy Pass tokens, which sign private tabs in to Kagi (decision
/// 0091, Kagi Privacy Pass spec), as `SvalKagiPrivacyPass.sys.mjs` does for
/// the desktop's private windows. Kagi can check that a token comes from a
/// subscriber, and cannot tell which subscriber.
///
/// This keeps the stock and refills it, and `Page` spends it, one token per
/// request, in private tabs (`KagiPrivacyPass.Spend`).
///
/// **Refilling uses the normal tabs' session, and nothing else does.** The
/// `kagi_session` cookie of the default store goes only into the
/// `Authorization` header of the issuance POST to `kagi.com`, sent with no
/// cookies, no referrer and no redirect. Kagi learns that the account
/// fetched a batch; it cannot tell which search spent which token.
///
/// **The stock is a credential.** It lives in the Keychain, on this device
/// alone and never synced, and no log line names a token, a challenge, a
/// client state or a session value. Tokens are spent newest first. Those
/// issued before the start of the previous calendar month are dropped on
/// read, because Kagi has retired the key they were issued under.
@MainActor
final class KagiPrivacyPass: NSObject {
    static let shared = KagiPrivacyPass()

    /// Kagi issues this many per request, and allows ten requests a month.
    nonisolated static let batch: UInt16 = 300
    /// A refill starts when the stock falls to this.
    nonisolated static let low = 50

    nonisolated static let challengeURL = URL(string: "https://kagi.com/pp/wwwa")!
    nonisolated static let issueURL = URL(string: "https://kagi.com/pp/gettokens")!
    /// The header that tells Kagi a request is a Privacy Pass client's.
    nonisolated static let clientHeader = "X-Kagi-PrivacyPass-Client"
    nonisolated static let scheme = "PrivateToken "

    /// What Kagi's 403 says when the plan has no Privacy Pass.
    private static let unsupportedErrors: Set<String> = ["no_subscription", "unsupported_subscription"]

    /// A failed refill is tried again after this, doubling up to the cap.
    private static let retryFirst: Duration = .seconds(60)
    private static let retryMax: Duration = .seconds(60 * 60)

    /// What private tabs get from Kagi.
    enum State: Equatable {
        case ready
        /// This month's allowance is used.
        case out
        /// The plan has no Privacy Pass.
        case unsupported
        case signedOut
    }

    /// The stock as the Keychain keeps it.
    struct Stock: Codable, Equatable {
        struct Entry: Codable, Equatable {
            let token: String
            /// When it was issued, in milliseconds since the epoch.
            let issued: Double
        }

        /// Oldest first.
        var tokens: [Entry] = []
        var unsupported = false
        /// When an `out` stock is allowed more, in milliseconds since the
        /// epoch, or 0.
        var outUntil: Double = 0
    }

    /// Where the stock is kept, and how Kagi and the engine are reached.
    /// Tests replace each.
    struct Host {
        var read: () -> Data?
        var write: (Data?) -> Void
        var now: () -> Date
        var session: @MainActor () async -> String?
        var send: (URLRequest) async throws -> (Data, HTTPURLResponse)
        var tokenRequest: (String, UInt16) throws -> KagiTokenRequest
        var finalize: (String, String) throws -> [String]
    }

    private var host: Host
    private var stock: Stock?
    private var refilling: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    private var retryAfter = KagiPrivacyPass.retryFirst
    /// The session value last seen, so a cookie Kagi sets again on its
    /// own responses asks Kagi nothing.
    private var lastSession: String?
    private var sessionSeen = false

    init(host: Host = .live) {
        self.host = host
    }

    /// Reads the stock, and follows the default store's Kagi sign-in, which
    /// refills an empty stock at once.
    func start() {
        _ = loaded
        WKWebsiteDataStore.default().httpCookieStore.add(self)
        Task { await cookiesChanged() }
    }

    /// What private tabs get from Kagi now.
    var state: State {
        let stock = loaded
        if !stock.tokens.isEmpty { return .ready }
        if stock.unsupported { return .unsupported }
        if stock.outUntil > millis(host.now()) { return .out }
        if stock.outUntil != 0 {
            // The allowance has reset since it ran out. Nothing else would
            // ask Kagi again, so the first look at the state does.
            change { $0.outUntil = 0 }
            refill()
        }
        return .signedOut
    }

    var count: Int { loaded.tokens.count }

    /// When an `out` stock is allowed more.
    var outUntil: Date { Date(timeIntervalSince1970: loaded.outUntil / 1000) }

    /// Removes and returns the newest token, and refills when the stock is
    /// low.
    func take() -> String? {
        guard let entry = loaded.tokens.last else { return nil }
        change { $0.tokens.removeLast() }
        if loaded.tokens.count <= Self.low { refill() }
        return entry.token
    }

    /// Normal tabs signed in to Kagi: the plan may have changed, so Kagi is
    /// asked again, and the stock refilled when it is low.
    func signedIn() {
        if loaded.unsupported || loaded.tokens.count <= Self.low { refill(askAgain: true) }
    }

    /// Refills the stock from Kagi, once at a time. Does nothing without a
    /// normal-tab session, on a plan without Privacy Pass unless asked
    /// again, or while this month's allowance is used.
    @discardableResult
    func refill(askAgain: Bool = false) -> Task<Void, Never> {
        if let refilling { return refilling }
        let task = Task { [weak self] in
            await self?.refillOnce(askAgain: askAgain)
            self?.refilling = nil
        }
        refilling = task
        return task
    }

    /// Kagi answered, and the answer is the state: no retry.
    private struct Settled: Error {}

    private func refillOnce(askAgain: Bool) async {
        if (loaded.unsupported && !askAgain) || loaded.outUntil > millis(host.now()) { return }
        guard let session = await host.session() else { return }
        do {
            let tokens = try await issue(session: session)
            let now = millis(host.now())
            change {
                $0.tokens.insert(contentsOf: tokens.map { Stock.Entry(token: $0, issued: now) }, at: 0)
                $0.unsupported = false
                $0.outUntil = 0
            }
            Diagnostics.log("kagi: \(tokens.count) Privacy Pass tokens fetched, \(count) held")
            retryAfter = Self.retryFirst
        } catch is Settled {
            retryAfter = Self.retryFirst
        } catch {
            Diagnostics.log("kagi: Privacy Pass tokens not fetched: \(Diagnostics.name(error))")
            retryLater()
        }
    }

    private func retryLater() {
        retry?.cancel()
        let wait = retryAfter
        retryAfter = min(retryAfter * 2, Self.retryMax)
        retry = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled else { return }
            self?.refill()
        }
    }

    enum IssueError: Error {
        case noChallenge
        case status(Int)
    }

    /// One issuance: the challenge, the request, Kagi's answer and the
    /// tokens.
    private func issue(session: String) async throws -> [String] {
        var challengeRequest = URLRequest(url: Self.challengeURL)
        challengeRequest.setValue("true", forHTTPHeaderField: Self.clientHeader)
        let (_, challengeResponse) = try await host.send(challengeRequest)
        guard let challenge = challengeResponse.value(forHTTPHeaderField: "WWW-Authenticate") else {
            throw IssueError.noChallenge
        }

        let issuance = try host.tokenRequest(challenge, Self.batch)
        var request = URLRequest(url: Self.issueURL)
        request.httpMethod = "POST"
        request.setValue("application/private-token-request", forHTTPHeaderField: "Content-Type")
        request.setValue("true", forHTTPHeaderField: Self.clientHeader)
        request.setValue(session, forHTTPHeaderField: "Authorization")
        request.httpBody = Data(issuance.body.utf8)
        let (data, response) = try await host.send(request)
        let text = String(decoding: data, as: UTF8.self)
        try answered(status: response.statusCode, text: text)

        let tokens = try host.finalize(issuance.state, text)
        if tokens.isEmpty {
            markOut()
            throw Settled()
        }
        return tokens.filter(Self.isToken)
    }

    /// Settles the state from an issuance answer that carries no tokens,
    /// and throws for any answer that is not a batch.
    private func answered(status: Int, text: String) throws {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if status == 200 && !empty { return }
        if status == 200 || status == 429 {
            markOut()
            throw Settled()
        }
        if status == 401 { throw Settled() }
        if status == 403,
           let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
           let code = json["error_code"] as? String, Self.unsupportedErrors.contains(code) {
            if !loaded.unsupported {
                change { $0.unsupported = true }
                Diagnostics.log("kagi: the plan has no Privacy Pass")
            }
            throw Settled()
        }
        throw IssueError.status(status)
    }

    /// This month's allowance is used, until the 1st of next month, UTC.
    private func markOut() {
        change { $0.outUntil = millis(Self.month(from: host.now(), by: 1)) }
        Diagnostics.log("kagi: this month's Privacy Pass tokens are used")
    }

    /// A token as the redemption header carries it: base64url, padded.
    nonisolated static func isToken(_ token: String) -> Bool {
        token.range(of: #"^[A-Za-z0-9_-]+={0,2}$"#, options: .regularExpression) != nil
    }

    /// 00:00 UTC on the 1st of the month `months` after `date`'s.
    nonisolated static func month(from date: Date, by months: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let start = calendar.date(from: calendar.dateComponents([.year, .month], from: date))!
        return calendar.date(byAdding: .month, value: months, to: start)!
    }

    private func millis(_ date: Date) -> Double { date.timeIntervalSince1970 * 1000 }

    /// The stock, read once and with expired tokens dropped.
    private var loaded: Stock {
        if let stock { return stock }
        var read = host.read().flatMap { try? JSONDecoder().decode(Stock.self, from: $0) } ?? Stock()
        let oldest = millis(Self.month(from: host.now(), by: -1))
        let kept = read.tokens.filter { Self.isToken($0.token) && $0.issued >= oldest }
        let dropped = kept.count != read.tokens.count
        read.tokens = kept
        stock = read
        if dropped { persist() }
        return read
    }

    private func change(_ edit: (inout Stock) -> Void) {
        var next = loaded
        edit(&next)
        stock = next
        persist()
    }

    private func persist() {
        guard let stock else { return }
        let empty = stock.tokens.isEmpty && !stock.unsupported && stock.outUntil == 0
        host.write(empty ? nil : try? JSONEncoder().encode(stock))
    }

    /// Normal tabs' Kagi session changed. The first look, at start, refills
    /// an empty stock; a new value after it is a sign-in. Kagi setting the
    /// same value again on its own responses asks Kagi nothing.
    fileprivate func cookiesChanged() async {
        let session = await host.session()
        let previous = lastSession
        let first = !sessionSeen
        sessionSeen = true
        lastSession = session
        guard session != nil else { return }
        if first {
            if loaded.tokens.isEmpty { refill() }
        } else if session != previous {
            signedIn()
        }
    }
}

extension KagiPrivacyPass: WKHTTPCookieStoreObserver {
    nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        Task { @MainActor in await self.cookiesChanged() }
    }
}

extension KagiPrivacyPass.Host {
    /// The Keychain, the default store's cookie, Kagi itself and the
    /// engine.
    static let live = KagiPrivacyPass.Host(
        read: { Secrets.kagiPrivacyPass() },
        write: { data in
            if let data { try? Secrets.storeKagiPrivacyPass(data) } else { Secrets.forgetKagiPrivacyPass() }
        },
        now: { Date() },
        session: { await KagiPrivacyPass.session(in: WKWebsiteDataStore.default().httpCookieStore) },
        send: { request in try await KagiPrivacyPass.transport.send(request) },
        tokenRequest: { challenge, count in try kagiTokenRequest(wwwAuthenticate: challenge, count: count) },
        finalize: { state, response in try kagiTokenFinalize(state: state, response: response) }
    )
}

extension KagiPrivacyPass {
    /// Kagi's session in `store`: a Secure `kagi_session` for `kagi.com` or
    /// `.kagi.com`. Kagi documents neither, and its sign-in has been seen
    /// to set it so. A cookie for one subdomain alone is another session.
    static func session(in store: WKHTTPCookieStore) async -> String? {
        await store.allCookies().first { cookie in
            cookie.name == "kagi_session" && cookie.isSecure
                && ["kagi.com", ".kagi.com"].contains(cookie.domain.lowercased())
        }?.value
    }

    /// Requests that carry no cookie, store none, keep nothing on disk and
    /// follow no redirect, so the session goes to `kagi.com` alone.
    final class Transport: NSObject, URLSessionTaskDelegate, Sendable {
        private let session: URLSession

        override init() {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            session = URLSession(configuration: configuration)
            super.init()
        }

        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let (data, response) = try await session.data(for: request, delegate: self)
            guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            return (data, response)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? {
            nil
        }
    }

    static let transport = Transport()
}
