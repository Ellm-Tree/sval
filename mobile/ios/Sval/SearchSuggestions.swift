// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// The synced search engine's suggestions for what was typed, asked for
/// as the desktop asks (`UrlbarProviderSearchSuggestions`,
/// `SearchSuggestionController`), under the same synced settings
/// (decision 0098).
enum SearchSuggestions {
    static let enabledKey = "browser.search.suggest.enabled"
    static let limitKey = "browser.sval.launcher.limit.suggestions"
    static let defaultLimit = 3

    /// How many suggestions the Launcher lists: none in private, as
    /// `browser.search.suggest.enabled.private` defaults on the desktop,
    /// or when either of the desktop's switches is off.
    static func limit(settings: [String: Any], inPrivate: Bool) -> Int {
        guard !inPrivate, settings[enabledKey] as? Bool ?? true,
              LauncherResults.suggests("searches", settings: settings) else { return 0 }
        return max(0, settings[limitKey] as? Int ?? defaultLimit)
    }

    /// Whether `query` may go to the engine. One character gets nothing
    /// useful, and an address would tell the engine a site the user
    /// visits (`UrlbarQueryContext.allowRemoteResults`). One word shaped
    /// like an address the phone would search for, such as `mailto:` text
    /// or a name with a login, stays on the phone as well: the desktop
    /// takes it for a possible origin or a URI and asks nothing.
    static func asks(_ query: String) -> Bool {
        query.count >= 2 && Address.isSearch(query) && !looksLikeURL(query)
    }

    /// Without cookies or a cache on disk, as the desktop asks
    /// (`LOAD_ANONYMOUS`, `INHIBIT_PERSISTENT_CACHING`).
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    /// The engine's suggestions for `query`, or none when it has no
    /// suggestion address or doesn't answer. Throws `CancellationError`
    /// when the task is cancelled, as the next key cancels it.
    static func fetch(_ query: String, settings: [String: Any], limit: Int) async throws -> [String] {
        guard limit > 0, asks(query), let url = SearchEngine(settings: settings).suggestions(query) else { return [] }
        let data: Data
        do {
            (data, _) = try await session.data(from: url)
        } catch {
            try Task.checkCancellation()
            return []
        }
        return parse(data, query: query, limit: limit)
    }

    /// The suggestions of an OpenSearch answer, `[query, [suggestion, …]]`.
    /// An answer for other terms is dropped, as are a suggestion that looks
    /// like an address and one that is what was typed, which the row Enter
    /// takes already searches (`SearchSuggestionController`'s
    /// `#onRemoteLoaded`, `UrlbarProviderSearchSuggestions`'s `looksLikeUrl`,
    /// and the muxer's dedupe against the heuristic).
    static func parse(_ data: Data, query: String, limit: Int) -> [String] {
        guard let answer = try? JSONSerialization.jsonObject(with: data) as? [Any],
              answer.count > 1,
              let terms = answer[0] as? String,
              terms.compare(query, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame,
              let suggestions = answer[1] as? [Any] else { return [] }
        var seen: Set<String> = [query.lowercased()]
        var kept: [String] = []
        for case let suggestion as String in suggestions {
            let trimmed = suggestion.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !looksLikeURL(trimmed), seen.insert(trimmed.lowercased()).inserted else { continue }
            kept.append(trimmed)
            if kept.count == limit { break }
        }
        return kept
    }

    /// `UrlbarProviderSearchSuggestions`'s `looksLikeUrl`: one word holding
    /// a dot or one of `/@:[`.
    static func looksLikeURL(_ text: String) -> Bool {
        !text.contains(where: \.isWhitespace) && text.contains { "/@:[.".contains($0) }
    }
}
