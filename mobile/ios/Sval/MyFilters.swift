// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

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
            .map(\.entry.line)
            .joined(separator: "\n")
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
