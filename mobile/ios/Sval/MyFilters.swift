// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import CryptoKit
import Foundation

/// The user's own filter rules, My filters, as the desktop keeps them: a
/// synced setting per line under `branch`, each a JSON `{line, order}`
/// (`SvalMyFilters.sys.mjs`, decision 0117). The lines sort by `order`, then
/// by key, both compared as bytes.
enum MyFilters {
    static let branch = "browser.sval.adblock.myFilter."

    private struct Entry: Decodable {
        let line: String
        let order: String
    }

    /// My filters as one text, a line each. A setting that isn't a line, as
    /// a newer build or a device with a bad value could write, is left out.
    static func text(settings: [String: Any]) -> String {
        entries(settings: settings).map(\.entry.line).joined(separator: "\n")
    }

    /// Every line's setting, in order.
    private static func entries(settings: [String: Any]) -> [(key: String, entry: Entry)] {
        settings
            .compactMap { key, value -> (key: String, entry: Entry)? in
                guard key.hasPrefix(branch),
                      let json = value as? String,
                      let entry = try? JSONDecoder().decode(Entry.self, from: Data(json.utf8)),
                      isLine(entry.line), isOrder(entry.order)
                else { return nil }
                return (key, entry)
            }
            .sorted {
                $0.entry.order.utf8.lexicographicallyPrecedes($1.entry.order.utf8)
                    || ($0.entry.order == $1.entry.order
                        && $0.key.utf8.lexicographicallyPrecedes($1.key.utf8))
            }
    }

    /// One of My filters' lines that removes something on a host.
    struct Removal: Identifiable, Equatable {
        enum Kind { case hide, network }
        /// The line's setting, `branch` and its name.
        let key: String
        let line: String
        let kind: Kind
        /// The selector of a hiding line, the address of a network line.
        let shown: String
        /// The line's site that names the host, or the nearest name above
        /// it, which Show Again takes out.
        let scope: String
        fileprivate let order: String
        fileprivate let domains: [Substring]
        fileprivate let rebuild: ([Substring]) -> String

        var id: String { key }

        static func == (a: Removal, b: Removal) -> Bool { a.key == b.key && a.line == b.line && a.scope == b.scope }
    }

    /// My filters' lines that remove something on `host`, newest first:
    /// each hiding line whose sites name it or a name above it, and each
    /// network line whose `domain=` does, as the desktop's site menu lists
    /// a site's removals (`SvalElementRules`). An exception, a scriptlet,
    /// an HTML filter and a `~` entry remove nothing there.
    static func removals(on host: String, settings: [String: Any]) -> [Removal] {
        let host = host.lowercased()
        return entries(settings: settings).reversed().compactMap { key, entry in
            guard let parsed = parse(entry.line) else { return nil }
            // The most specific of the line's names that covers the host.
            let scope = parsed.domains
                .map { $0.lowercased() }
                .filter { !$0.isEmpty && !$0.hasPrefix("~") && (host == $0 || host.hasSuffix("." + $0)) }
                .max { $0.count < $1.count }
            guard let scope else { return nil }
            return Removal(key: key, line: entry.line, kind: parsed.kind, shown: parsed.shown, scope: scope,
                           order: entry.order, domains: parsed.domains, rebuild: parsed.rebuild)
        }
    }

    /// The settings that take `removal`'s scope out of its line: the line
    /// rewritten in its place, or cleared when no plain site is left, since
    /// a line of `~` entries alone would apply to every other site
    /// (`SvalElementRules.showAgain`). Each value is nil to clear it.
    static func showingAgain(_ removal: Removal, settings: [String: Any]) -> [(key: String, value: String?)] {
        let rest = removal.domains.filter { $0.lowercased() != removal.scope }
        var writes: [(key: String, value: String?)] = [(removal.key, nil)]
        guard rest.contains(where: { !$0.hasPrefix("~") }) else { return writes }
        let line = removal.rebuild(rest)
        var n = 0
        while settings[branch + lineKey(line, n)] != nil { n += 1 }
        guard let value = value(line: line, order: removal.order) else { return writes }
        writes.append((branch + lineKey(line, n), value))
        return writes
    }

    private struct Parsed {
        let kind: Removal.Kind
        let domains: [Substring]
        let shown: String
        let rebuild: ([Substring]) -> String
    }

    /// The parts of a line that can name a site, or nil for any other line
    /// (`SvalElementRules`'s `parse`).
    private static func parse(_ line: String) -> Parsed? {
        let text = line.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, !text.hasPrefix("!"), !text.hasPrefix("@@") else { return nil }
        let cosmetic = text.firstMatch(of: /^([^#\s]*)(##|#\?#)(.+)$/)
        if let cosmetic, !cosmetic.1.contains(where: "/|*".contains) {
            let separator = String(cosmetic.2), selector = String(cosmetic.3)
            guard !cosmetic.1.isEmpty, !selector.hasPrefix("+js("), !selector.hasPrefix("^") else { return nil }
            return Parsed(kind: .hide, domains: cosmetic.1.split(separator: ",", omittingEmptySubsequences: false),
                          shown: selector) { $0.joined(separator: ",") + separator + selector }
        }
        if cosmetic == nil, text.firstMatch(of: /^[^#\s]*#[@$%]?\??#/) != nil { return nil }
        guard let at = text.lastIndex(of: "$") else { return nil }
        let pattern = String(text[..<at])
        let options = text[text.index(after: at)...].split(separator: ",", omittingEmptySubsequences: false)
        guard let slot = options.firstIndex(where: { $0.hasPrefix("domain=") }) else { return nil }
        return Parsed(kind: .network, domains: options[slot].dropFirst("domain=".count).split(separator: "|"),
                      shown: pattern) { domains in
            var rebuilt = options.map(String.init)
            rebuilt[slot] = "domain=" + domains.joined(separator: "|")
            return pattern + "$" + rebuilt.joined(separator: ",")
        }
    }

    /// The setting that adds `line` after every line My filters hold: its
    /// key under `branch` and its JSON value. The key is the next free one
    /// for the line's text, and the order falls after the last line's, as
    /// the desktop's `store` writes an added line (`lineKey`,
    /// `orderBetween`).
    static func adding(_ line: String, settings: [String: Any]) -> (key: String, value: String)? {
        guard isLine(line) else { return nil }
        let stored = entries(settings: settings)
        var n = 0
        while settings[branch + lineKey(line, n)] != nil { n += 1 }
        guard let value = value(line: line, order: orderBetween(stored.last?.entry.order ?? "", nil)) else { return nil }
        return (branch + lineKey(line, n), value)
    }

    /// A line's setting value, as the desktop writes it (`JSON.stringify`).
    private static func value(line: String, order: String) -> String? {
        (try? JSONSerialization.data(withJSONObject: ["line": line, "order": order],
                                     options: [.sortedKeys, .withoutEscapingSlashes]))
            .map { String(decoding: $0, as: UTF8.self) }
    }

    /// The setting key's name for a line under `branch`: the first 32 hex
    /// digits of the SHA-256 of its text and how many lines of the same
    /// text come before it.
    static func lineKey(_ line: String, _ n: Int) -> String {
        SHA256.hash(data: Data("\(line)\n\(n)".utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description
    }

    private static let digits = Array("0123456789abcdefghijklmnopqrstuvwxyz")

    /// An order strictly between `a` and `b`, read as base-36 fractions, or
    /// after `a` where `b` is nil.
    static func orderBetween(_ a: String, _ b: String?) -> String {
        let a = Array(a)
        var b = b.map(Array.init)
        var order = ""
        var i = 0
        while true {
            let lo = i < a.count ? digits.firstIndex(of: a[i]) ?? 0 : 0
            let hi = b.flatMap { i < $0.count ? digits.firstIndex(of: $0[i]) : nil } ?? digits.count
            if hi - lo > 1 { return order + String(digits[(lo + hi) / 2]) }
            order.append(digits[lo])
            // `order` is below `b` from this digit on, so only `a` bounds
            // the rest.
            if hi - lo == 1 { b = nil }
            i += 1
        }
    }

    /// Text a filter list's line could hold: no line break, and no control
    /// character but a tab (`isPlainText` on the desktop).
    private static func isLine(_ line: String) -> Bool {
        !line.unicodeScalars.contains { $0.value < 0x20 && $0 != "\t" || $0.value == 0x7F }
    }

    /// An order: base-36 digits that don't end in `0`.
    private static func isOrder(_ order: String) -> Bool {
        guard let last = order.utf8.last, last != UInt8(ascii: "0") else { return false }
        return order.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x7A).contains($0) }
    }
}
