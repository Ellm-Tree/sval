// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// The revision of each document a refresh reads, taken in one hop.
struct Revisions: Equatable, Sendable {
    var workspaces: UInt64
    var settings: UInt64
    var favorites: UInt64
}

/// The revision each document beside the tree was last read at, so a
/// refresh reads one again only once it moved, and a read older than the
/// one kept never replaces it. Revisions count within one `Syncer`'s
/// documents, so a new syncer starts new marks.
struct ReadMarks {
    private var settings: UInt64?
    private var favorites: UInt64?
    private var pins: UInt64?
    /// The Workspaces the pins were read for, each with whether it is an
    /// agent's.
    private var pinsFor: [String: Bool]?

    func settingsDue(_ revisions: Revisions) -> Bool { settings != revisions.settings }

    func favoritesDue(_ revisions: Revisions) -> Bool { favorites != revisions.favorites }

    /// Whether the favorites moved past the pins read, or the Workspaces
    /// they show in changed.
    func pinsDue(_ revisions: Revisions, for workspaces: [String: Bool]) -> Bool {
        pins != revisions.favorites || pinsFor != workspaces
    }

    /// Notes a read of the settings at `revision`, and returns whether to
    /// keep it.
    mutating func keepSettings(at revision: UInt64) -> Bool { Self.keep(&settings, at: revision) }

    mutating func keepFavorites(at revision: UInt64) -> Bool { Self.keep(&favorites, at: revision) }

    mutating func keepPins(at revision: UInt64, for workspaces: [String: Bool]) -> Bool {
        guard Self.keep(&pins, at: revision) else { return false }
        pinsFor = workspaces
        return true
    }

    private static func keep(_ held: inout UInt64?, at revision: UInt64) -> Bool {
        if let held, revision < held { return false }
        held = revision
        return true
    }
}

extension SvalDocument {
    /// A settings document's settings, key to value. A setting reset to its
    /// default is left out.
    func syncedSettings() -> [String: Any] {
        guard let json = try? settingsJson(),
              let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        else { return [:] }
        return object.filter { !($0.value is NSNull) }
    }

    /// A favorites document's favorites, folders and separators, as the
    /// desktop's store reads them.
    func favoriteRows() -> [Favorite] {
        guard let json = try? favoritesJson() else { return [] }
        return (try? JSONDecoder().decode([Favorite].self, from: Data(json.utf8))) ?? []
    }
}
