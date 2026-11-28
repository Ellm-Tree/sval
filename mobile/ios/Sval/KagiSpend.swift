// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import WebKit

/// How a private tab spends Kagi Privacy Pass tokens, as `SvalKagi.sys.mjs`
/// does in the desktop's private windows.
///
/// A token goes to `kagi.com` itself over https, on one of Kagi's own pages
/// (`pages`), and only on requests the user or Kagi started: a top-level
/// load from Sval or from a page of `kagi.com`, and a fetch or XHR a page of
/// `kagi.com` makes. A link from another site reaches Kagi signed out.
///
/// WebKit lets an app set a request's headers only on a load it starts
/// itself. So a top-level load that should carry a token is cancelled and
/// started again with one (`Page`), and a page of `kagi.com` gets its fetch
/// and XHR wrapped in its own world (`pageScript`). That wrapper asks for a
/// token through a script in Sval's world (`bridgeScript`), so no page of
/// any site can see Sval's handler, and the handler gives one only to a
/// frame of `https://kagi.com` (`TokenReply`).
enum KagiSpend {
    static let host = "kagi.com"

    /// Kagi's own pages, the path list of Kagi's Privacy Pass extension,
    /// matched against the path and query.
    static let pages = #"^/(html/|socket/)?($|\?|search|images|videos|news|podcasts|settings|summarizer|mother/|reverse/)"#

    /// Whether `url` is one of Kagi's own pages on exactly `kagi.com` over
    /// https.
    static func isKagiPage(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.host()?.lowercased() == host,
              url.port == nil || url.port == 443,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        let pathQuery = path + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
        return pathQuery.range(of: pages, options: .regularExpression) != nil
    }

    /// Whether a frame is a page of `https://kagi.com`.
    static func isKagi(_ origin: WKSecurityOrigin) -> Bool {
        origin.protocol == "https" && origin.host.lowercased() == host && (origin.port == 0 || origin.port == 443)
    }

    /// The header a token goes in.
    static func authorization(_ token: String) -> String {
        "\(KagiPrivacyPass.scheme)token=\"\(token)\""
    }

    /// `url` loaded with `token`, as Kagi's extension sends it: no cookie
    /// and no referrer go with it.
    static func request(_ url: URL, token: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue(authorization(token), forHTTPHeaderField: "Authorization")
        request.setValue("true", forHTTPHeaderField: KagiPrivacyPass.clientHeader)
        request.httpShouldHandleCookies = false
        return request
    }

    /// Whether `request` carries `token`, the one Sval last started a load
    /// with. A page can set no header on a navigation, so a load carrying
    /// it is Sval's own.
    static func carries(_ request: URLRequest, token: String?) -> Bool {
        guard let token else { return false }
        return request.value(forHTTPHeaderField: "Authorization") == authorization(token)
    }

    static let message = "svalKagiToken"
    private static let requestEvent = "sval-kagi-token-request"
    private static let answerEvent = "sval-kagi-token"

    /// In the page's world, in every frame of a private tab; it does
    /// nothing outside `https://kagi.com`. Each fetch and asynchronous XHR
    /// to one of Kagi's own pages waits for a token and carries it, without
    /// cookies or a referrer. When this month's tokens are used it fails
    /// as a blocked request does, and nothing is sent. A synchronous XHR
    /// cannot wait, so it goes signed out.
    static let pageScript = """
        (() => {
          if (location.origin !== "https://\(host)") return;
          const pages = new RegExp(\(jsString(pages)));
          const eligible = address => {
            try {
              const url = new URL(address, location.href);
              return url.origin === location.origin && pages.test(url.pathname + url.search);
            } catch (e) {
              return false;
            }
          };
          const waiting = new Map();
          let next = 0;
          addEventListener("\(answerEvent)", event => {
            let answer;
            try { answer = JSON.parse(event.detail); } catch (e) { return; }
            const resolve = waiting.get(answer.id);
            if (!resolve) return;
            waiting.delete(answer.id);
            resolve(answer);
          });
          const ask = () => new Promise(resolve => {
            const id = String(++next);
            waiting.set(id, resolve);
            dispatchEvent(new CustomEvent("\(requestEvent)", { detail: id }));
          });
          const authorization = token => `\(KagiPrivacyPass.scheme)token="${token}"`;

          const fetch = window.fetch;
          window.fetch = new Proxy(fetch, {
            apply(target, self, args) {
              let request;
              try { request = new Request(...args); } catch (e) { return Reflect.apply(target, self, args); }
              if (!eligible(request.url)) return Reflect.apply(target, self, args);
              return ask().then(answer => {
                if (answer.out) throw new TypeError("Load failed");
                if (!answer.token) return Reflect.apply(target, self, [request]);
                const headers = new Headers(request.headers);
                headers.set("Authorization", authorization(answer.token));
                headers.set("\(KagiPrivacyPass.clientHeader)", "true");
                return Reflect.apply(target, self, [new Request(request, {
                  headers, credentials: "omit", referrer: "",
                })]);
              });
            },
          });

          const xhr = XMLHttpRequest.prototype;
          const open = xhr.open, send = xhr.send, setHeader = xhr.setRequestHeader;
          const opened = new WeakMap();
          xhr.open = function (method, url, async) {
            opened.set(this, { url: String(url), async: arguments.length < 3 || !!async });
            return open.apply(this, arguments);
          };
          xhr.send = function (body) {
            const request = opened.get(this);
            if (!request || !request.async || !eligible(request.url)) return send.apply(this, arguments);
            ask().then(answer => {
              if (answer.out) {
                for (const type of ["error", "loadend"]) this.dispatchEvent(new ProgressEvent(type));
                return;
              }
              if (answer.token) {
                setHeader.call(this, "Authorization", authorization(answer.token));
                setHeader.call(this, "\(KagiPrivacyPass.clientHeader)", "true");
              }
              send.call(this, body);
            });
          };
        })();
        """

    /// In Sval's world: carries the page's asks to `TokenReply` and its
    /// answers back. It answers only in a frame of `https://kagi.com`.
    static let bridgeScript = """
        (() => {
          if (location.origin !== "https://\(host)") return;
          addEventListener("\(requestEvent)", event => {
            const id = String(event.detail);
            const answer = reply => dispatchEvent(new CustomEvent("\(answerEvent)", {
              detail: JSON.stringify(Object.assign({ id }, reply)),
            }));
            webkit.messageHandlers.\(message).postMessage(null).then(answer, () => answer({}));
          });
        })();
        """

    /// A JavaScript string literal of `text`.
    private static func jsString(_ text: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [text])
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }

    /// Hands a token to a frame of `https://kagi.com` in a private tab, one
    /// per ask: `{token}`, `{out: true}` when this month's are used, or
    /// nothing, which sends the request signed out.
    final class TokenReply: NSObject, WKScriptMessageHandlerWithReply {
        private let tokens: KagiPrivacyPass

        init(_ tokens: KagiPrivacyPass) {
            self.tokens = tokens
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
            MainActor.assumeIsolated {
                guard KagiSpend.isKagi(message.frameInfo.securityOrigin) else {
                    replyHandler([String: Any](), nil)
                    return
                }
                switch tokens.state {
                case .ready:
                    let token = tokens.take()
                    if token != nil {
                        Diagnostics.debug("kagi: a private page's request signed in with Privacy Pass, \(tokens.count) left")
                    }
                    replyHandler(token.map { ["token": $0] } ?? [:], nil)
                case .out:
                    replyHandler(["out": true], nil)
                case .unsupported, .signedOut:
                    replyHandler([String: Any](), nil)
                }
            }
        }
    }

    /// Where a private tab's Kagi search goes when this month's tokens are
    /// used. Nothing reaches Kagi.
    static func outOfTokensPage(until: Date) -> String {
        let date = until.formatted(.dateTime.month(.wide).day())
        return """
            <!doctype html>
            <html lang="en"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta name="color-scheme" content="light dark">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
            <title>Kagi searches used up</title>
            <style>
              body { font: -apple-system-body; margin: 0; padding: 48px 24px; max-width: 32em; }
              h1 { font: -apple-system-title2; font-weight: 600; }
            </style></head>
            <body>
              <h1>This month's private Kagi searches are used up</h1>
              <p>Private tabs sign in to Kagi with Privacy Pass. Kagi allows a set number of Privacy Pass searches each month, and the count resets on \(date).</p>
              <p>Normal tabs still search Kagi as usual.</p>
            </body></html>
            """
    }
}
