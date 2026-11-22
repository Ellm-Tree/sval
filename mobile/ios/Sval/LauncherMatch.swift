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

    fileprivate static func bare(_ text: String) -> String {
        String(String.UnicodeScalarView(text.decomposedStringWithCanonicalMapping.unicodeScalars.filter { scalar in
            ![.nonspacingMark, .spacingMark, .enclosingMark].contains(scalar.properties.generalCategory)
        }))
    }

    /// A title or address prepared for matching: folded once, as UTF-8,
    /// so a keystroke folds nothing and compares bytes. Folding and
    /// comparing `Character`s are most of a match's cost.
    struct Text: Equatable, Sendable {
        /// Its first `maxChars` without accents, each letter in lower case.
        let lower: [UInt8]
        /// Whether a match may start at each byte of `lower`: the start of
        /// a character that does not continue a word.
        let starts: [Bool]
        /// Its first `maxChars` folded as one text: `lower`'s bytes, except
        /// where lower-casing the whole text cases a letter by its context.
        let folded: [UInt8]

        init(_ source: String) {
            let prefix = String(source.prefix(maxChars))
            // Most titles and addresses are ASCII, which has no accents and
            // cases by the byte.
            if prefix.utf8.allSatisfy({ $0 < 0x80 }) {
                let bytes = Array(prefix.utf8)
                let lower = bytes.map { (65...90).contains($0) ? $0 + 32 : $0 }
                starts = bytes.indices.map { at in
                    !((97...122).contains(bytes[at]) && at > 0 && (97...122).contains(lower[at - 1]))
                }
                self.lower = lower
                folded = lower
                return
            }
            let bare = LauncherMatch.bare(prefix)
            var lower: [UInt8] = []
            var starts: [Bool] = []
            var previous: Character?
            for character in bare {
                let low = Character(character.lowercased())
                let inWord = isLowerLetter(character) && previous.map(isLowerLetter) == true
                let bytes = Array(String(low).utf8)
                lower += bytes
                starts += [!inWord] + Array(repeating: false, count: bytes.count - 1)
                previous = low
            }
            let folded = Array(bare.lowercased().utf8)
            self.lower = lower
            self.starts = starts
            self.folded = folded == lower ? lower : folded
        }
    }

    /// A page's title and its address as Places matches it, prepared.
    struct Fields: Equatable, Sendable {
        let title: Text
        let address: Text

        init(title: String, url: String) {
            self.title = Text(title)
            address = Text(matchable(url))
        }
    }

    /// What was typed, word by word, folded.
    struct Query: Sendable {
        let words: [String]
        fileprivate let needles: [[UInt8]]

        init(_ text: String) {
            words = LauncherMatch.words(text)
            needles = words.map { Array($0.utf8) }
        }

        var isEmpty: Bool { words.isEmpty }
    }

    /// Whether `token`, folded, occurs in `source` at a word boundary: at
    /// the start, or where the letter found does not follow another letter
    /// in the same word. A capital after a lower-case letter starts a word,
    /// so CamelCase words match.
    static func onBoundary(_ token: String, _ source: String) -> Bool {
        let text = Text(source)
        return find(Array(token.utf8), in: text.lower, startsOnly: text.starts)
    }

    /// Whether `needle` occurs in `haystack`, at a position `startsOnly`
    /// allows when it is given.
    private static func find(_ needle: [UInt8], in haystack: [UInt8], startsOnly: [Bool]? = nil) -> Bool {
        guard let first = needle.first else { return true }
        guard needle.count <= haystack.count else { return false }
        return haystack.withUnsafeBufferPointer { hay in
            needle.withUnsafeBufferPointer { pin in
                search: for at in 0...(hay.count - pin.count) where hay[at] == first {
                    if let startsOnly, !startsOnly[at] { continue }
                    for k in 1..<pin.count where hay[at + k] != pin[k] { continue search }
                    return true
                }
                return false
            }
        }
    }

    private static func isLowerLetter(_ c: Character) -> Bool {
        guard let ascii = c.asciiValue else { return false }
        return (97...122).contains(ascii)
    }

    /// The address as Places matches it: unescaped where that yields text,
    /// without an `http://`, `https://` or `ftp://` prefix.
    static func matchable(_ url: String) -> String {
        let spec = url.contains("%") ? url.removingPercentEncoding ?? url : url
        for scheme in ["http://", "https://", "ftp://"]
        where spec.prefix(scheme.count).lowercased() == scheme {
            return String(spec.dropFirst(scheme.count))
        }
        return spec
    }

    /// Whether every word matches on a boundary of the title or address.
    static func onBoundary(_ query: Query, _ fields: Fields) -> Bool {
        query.needles.allSatisfy {
            find($0, in: fields.title.lower, startsOnly: fields.title.starts)
                || find($0, in: fields.address.lower, startsOnly: fields.address.starts)
        }
    }

    /// Whether every word occurs anywhere in the title or address.
    static func anywhere(_ query: Query, _ fields: Fields) -> Bool {
        query.needles.allSatisfy { find($0, in: fields.title.folded) || find($0, in: fields.address.folded) }
    }

    /// Whether a tab matches strongly: what was typed starts a word of its
    /// title, or starts its host (`matchTabs` in `SvalLauncherTabs`).
    /// `host` is in lower case.
    static func strong(_ query: Query, title: Text, host: String) -> Bool {
        let whole = query.words.joined(separator: " ")
        return find(Array(whole.utf8), in: title.lower, startsOnly: title.starts) || host.hasPrefix(whole)
            || (host.hasPrefix("www.") && host.dropFirst(4).hasPrefix(whole))
    }
}
