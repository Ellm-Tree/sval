// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// What the user typed into the address bar, as somewhere to go: a web
/// address, or a search with the synced search engine. What counts as an
/// address follows Gecko's `URIFixup` for what the phone opens.
enum Address {
    static func resolve(_ text: String, settings: [String: Any]) -> URL? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return typed(text) ?? SearchEngine(settings: settings).search(text)
    }

    /// `text` as an address, fixed up as the address bar fixes it up, or
    /// nil for a search: what a typed favorite or pin address is saved as
    /// (the desktop's `SvalFavorites.addressOf`).
    static func typed(_ text: String) -> URL? {
        page(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Whether `text` is a search rather than an address.
    static func isSearch(_ text: String) -> Bool {
        typed(text) == nil
    }

    /// The web address `text` names, or none when Gecko would search for
    /// it. A typed address without a scheme loads over HTTPS where Gecko's
    /// HTTPS-First tries HTTPS (`nsHTTPSOnlyUtils::ShouldUpgradeHttpsFirstRequest`),
    /// and over HTTP where it doesn't: a local address, a name without a
    /// known public suffix, a port of its own.
    static func page(_ text: String) -> URL? {
        if let url = URL(string: text), let scheme = url.scheme?.lowercased(),
           ["http", "https"].contains(scheme) {
            return url.host() != nil ? url : nil
        }
        // What starts with "?" is a search (`keywordURIFixup`). The phone
        // also searches for anything that holds a space.
        guard !text.hasPrefix("?"), !text.contains(where: \.isWhitespace) else { return nil }
        // `host:port` is an address; any other scheme is one the phone
        // doesn't open, which Gecko searches for (`possiblyHostPortRegex`).
        let hostPort = text.range(of: #"^[a-z0-9-]+(\.[a-z0-9-]+)*:[0-9]{1,5}([/?#]|$)"#,
                                  options: [.regularExpression, .caseInsensitive]) != nil
        if URL(string: text)?.scheme != nil, !hostPort { return nil }
        guard let url = URL(string: "http://\(text)"),
              let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty else { return nil }
        let ip = isIP(host)
        let knownSuffix = !ip && host.contains(".") && !host.hasSuffix(".") && hasKnownPublicSuffix(host: host)
        let lastLabel = host.split(separator: ".").last.map(String.init) ?? ""
        let unknownSuffix = !ip && !knownSuffix && host.contains(".") && !host.hasSuffix(".")
            && host != "localhost" && !lastLabel.allSatisfy(\.isNumber)
        // A trailing slash insists on an address, as does `www.` and a name.
        let insisted = text.hasSuffix("/") || (host.hasPrefix("www.") && host.lastIndex(of: ".") == host.index(host.startIndex, offsetBy: 3))
        if !insisted, !ip {
            // `keywordURIFixup`: a known name, or one that looks like an
            // address, isn't searched for.
            let dottedName = host.hasSuffix(".") && host.firstIndex(of: ".") != host.index(before: host.endIndex)
            if !knownSuffix, host != "localhost", !dottedName, !looksLikeAddress(text, host: host) {
                return nil
            }
            if unknownSuffix { return nil }
        }
        let local = isLocal(host)
        let https = !local && (ip || knownSuffix) && (url.port == nil || url.port == 80)
        return https ? URL(string: "https://\(text)") : url
    }

    /// `isURILike`: a path followed by a query or fragment, or a port.
    private static func looksLikeAddress(_ text: String, host: String) -> Bool {
        if let slash = text.firstIndex(of: "/"),
           text[slash...].contains(where: { $0 == "?" || $0 == "#" }) {
            return true
        }
        let rest = text.lowercased().hasPrefix(host) ? String(text.dropFirst(host.count)) : text
        return rest.range(of: #"^:\d{1,5}([?#/]|$)"#, options: .regularExpression) != nil
    }

    private static func isIP(_ host: String) -> Bool {
        host.contains(":") || ipv4(host) != nil
    }

    private static func ipv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let numbers = parts.compactMap { Int($0) }.filter { (0...255).contains($0) }
        return numbers.count == 4 ? numbers : nil
    }

    /// Loopback and local addresses, which HTTPS-First leaves on HTTP
    /// (`LoopbackOrLocalException`, `NetAddr::IsIPAddrLocal`).
    private static func isLocal(_ host: String) -> Bool {
        if host == "localhost" { return true }
        if let ip = ipv4(host) {
            return ip[0] == 0 || ip[0] == 127 || ip[0] == 10 || (ip[0] == 172 && (16...31).contains(ip[1]))
                || (ip[0] == 192 && ip[1] == 168) || (ip[0] == 169 && ip[1] == 254)
        }
        guard host.contains(":") else { return false }
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if bare == "::1" || bare == "::" { return true }
        if bare.hasPrefix("::ffff:"), let mapped = ipv4(String(bare.dropFirst(7))) {
            return isLocal(mapped.map(String.init).joined(separator: "."))
        }
        guard let first = bare.split(separator: ":", omittingEmptySubsequences: false).first,
              let piece = UInt16(first, radix: 16) else { return false }
        return piece >> 9 == 0xFC >> 1 || piece >> 6 == 0xFE80 >> 6
    }
}

/// The search engine the desktop syncs (`SvalSettingsRegistry`'s
/// `SEARCH_ENGINE_KEY`), by its identifier in Sval's search configuration
/// (`SvalSearchConfig.sys.mjs`, whose engines `SearchEngines.swift`
/// lists). An engine the phone doesn't know, such as one the user added on
/// a computer, searches with the default.
struct SearchEngine {
    static let key = "sval.search.engine"
    static let defaultId = "ddg"

    /// An engine's address for a search or for suggestions: its base, the
    /// parameter that takes the terms, and the parameters it always sends.
    struct Address: Sendable {
        let base: String
        let term: String
        let params: [(String, String)]

        func url(_ terms: String) -> URL? {
            guard var url = URLComponents(string: base) else { return nil }
            url.queryItems = params.map { URLQueryItem(name: $0.0, value: $0.1) } + [URLQueryItem(name: term, value: terms)]
            return url.url
        }
    }

    struct Engine: Sendable {
        let search: Address
        /// None for a site search, which Sval contacts only when the user
        /// searches it (spec §10.9).
        let suggestions: Address?
    }

    let id: String

    init(settings: [String: Any]) {
        let synced = settings[Self.key] as? String ?? Self.defaultId
        id = Self.engines[synced] == nil ? Self.defaultId : synced
    }

    func search(_ terms: String) -> URL? {
        Self.engines[id]?.search.url(terms)
    }

    /// The address that asks the engine for suggestions for `terms`.
    func suggestions(_ terms: String) -> URL? {
        Self.engines[id]?.suggestions?.url(terms)
    }
}
