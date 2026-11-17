// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// How the Launcher matches what was typed, as the desktop's does
/// (`SvalFavoritesProvider`'s `fold`, `onBoundary` and `matchableUrl`,
/// after Places' own `findOnBoundary`).
enum LauncherMatch {
    /// How much of a name or address is matched (Places'
    /// `MAX_CHARS_TO_SEARCH_THROUGH`).
    private static let maxChars = 255

    /// Text without accents, in lower case.
    static func fold(_ text: String) -> String {
        bare(text).lowercased()
    }

    /// The words typed, folded.
    static func words(_ text: String) -> [String] {
        fold(text).split(whereSeparator: \.isWhitespace).map(String.init)
    }

    private static func bare(_ text: String) -> String {
        String(String.UnicodeScalarView(text.decomposedStringWithCanonicalMapping.unicodeScalars.filter { scalar in
            ![.nonspacingMark, .spacingMark, .enclosingMark].contains(scalar.properties.generalCategory)
        }))
    }

    /// Whether `token`, folded, occurs in `source` at a word boundary: at
    /// the start, or where the letter found does not follow another letter
    /// in the same word. A capital after a lower-case letter starts a word,
    /// so CamelCase words match.
    static func onBoundary(_ token: String, _ source: String) -> Bool {
        guard !token.isEmpty else { return true }
        let original = Array(bare(String(source.prefix(maxChars))))
        let folded = original.map { Character($0.lowercased()) }
        let needle = Array(token)
        guard needle.count <= folded.count else { return false }
        for at in 0...(folded.count - needle.count) where Array(folded[at..<at + needle.count]) == needle {
            let here = original[at]
            let before = at > 0 ? Character(original[at - 1].lowercased()) : nil
            let inWord = isLowerLetter(here) && before.map(isLowerLetter) == true
            if !inWord { return true }
        }
        return false
    }

    /// Whether `token` occurs anywhere in `source`, folded.
    static func anywhere(_ token: String, _ source: String) -> Bool {
        token.isEmpty || fold(String(source.prefix(maxChars))).contains(token)
    }

    private static func isLowerLetter(_ c: Character) -> Bool {
        guard let ascii = c.asciiValue else { return false }
        return (97...122).contains(ascii)
    }

    /// The address as Places matches it: unescaped where that yields text,
    /// without an `http://`, `https://` or `ftp://` prefix.
    static func matchable(_ url: String) -> String {
        let spec = url.removingPercentEncoding ?? url
        return spec.replacingOccurrences(of: "^(https?|ftp)://", with: "", options: [.regularExpression, .caseInsensitive])
    }

    /// Whether every word matches on a boundary of the title or address.
    static func onBoundary(_ words: [String], title: String, url: String) -> Bool {
        let address = matchable(url)
        return words.allSatisfy { onBoundary($0, title) || onBoundary($0, address) }
    }

    /// Whether every word occurs anywhere in the title or address.
    static func anywhere(_ words: [String], title: String, url: String) -> Bool {
        let address = matchable(url)
        return words.allSatisfy { anywhere($0, title) || anywhere($0, address) }
    }

    /// Whether a tab matches strongly: what was typed starts a word of its
    /// title, or starts its host (`matchTabs` in `SvalLauncherTabs`).
    static func strong(_ words: [String], title: String, url: String) -> Bool {
        let whole = words.joined(separator: " ")
        let host = (URL(string: url)?.host() ?? "").lowercased()
        return onBoundary(whole, title) || host.hasPrefix(whole)
            || (host.hasPrefix("www.") && host.dropFirst(4).hasPrefix(whole))
    }
}
