// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AVFoundation
import Foundation
import Security
import Observation
import UIKit

extension AppModel {
    /// The Favorites root a favorite made here goes in
    /// (`SvalFavoritesStore`'s `FAVORITES_ROOT`).
    static let favoritesRoot = "toolbar_____"

    /// A new favorite's guid: twelve characters, as Places mints them.
    static func mintGuid() -> String {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        return String((0..<12).map { _ in alphabet.randomElement()! })
    }

    /// The root pins live under, beside Favorites' (pins-root spec §4).
    static let pinsRoot = "pins________"

    /// Every root folder of the favorites document
    /// (`SvalFavoritesStore`'s `ROOT_GUIDS`).
    static let rootGuids = [favoritesRoot, "menu________", "unfiled_____", pinsRoot]

    var pinsRootId: String? { favorites.first { $0.guid == Self.pinsRoot }?.id }

    /// The last item in `parent`, which a new one goes after.
    func lastChild(of parent: String) -> String? {
        favorites.last { $0.parent == parent }?.id
    }

    /// Pins `url` at the end of the row, as a pin of its own and no
    /// favorite (pins-root spec §6), even where a pin of that address
    /// exists, as the desktop's `pinTab` adds one (`duplicate`). Returns
    /// the pin's guid.
    func pinTab(url: URL, title: String) async -> String? {
        let address = url.absoluteString
        guard Self.opensHere(address), let root = pinsRootId else { return nil }
        let guid = Self.mintGuid()
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "favorite", "guid": guid, "parent": root,
            "name": title.isEmpty ? address : title, "url": address,
        ]
        add["before"] = lastChild(of: root)
        return await editFavorites([add]) ? guid : nil
    }

    /// Where a pin sits, so Undo can put it back: its folder, the items
    /// either side of it there, and its Show in choices.
    struct PinPlace {
        let parent: String?
        let previous: String?
        let next: String?
        let scope: [String]?
    }

    func place(of pin: PinRow) -> PinPlace {
        let me = favorites.first { $0.id == pin.id }
        let siblings = favorites.filter { $0.parent == me?.parent }
        let index = siblings.firstIndex { $0.id == pin.id }
        return PinPlace(
            parent: me?.parent,
            previous: index.flatMap { $0 > 0 ? siblings[$0 - 1].id : nil },
            next: index.flatMap { $0 + 1 < siblings.count ? siblings[$0 + 1].id : nil },
            scope: pin.scope)
    }

    /// Puts a pin moved to Favorites back where it was in the row, with its
    /// Show in choices.
    func repin(_ pin: PinRow, at place: PinPlace, refolding: [[String: Any]] = []) async {
        guard let parent = place.parent ?? pinsRootId else { return }
        var move: [String: Any] = ["kind": "moveNode", "id": pin.id, "newParent": parent]
        move["before"] = place.previous
        move["after"] = place.next
        var ops = refolding + [move]
        if let scope = place.scope, !scope.isEmpty {
            ops.append(["kind": "setPinScope", "id": pin.id, "scope": scope])
        }
        await editFavorites(ops)
    }

    /// When moving `id` out of its pin folder leaves one pin there or
    /// none, the op that removes the pin folder, any pin left taking
    /// its place, and the ops that make it again round it.
    func dissolving(_ id: String, to newParent: String) -> (ops: [[String: Any]], undo: [[String: Any]])? {
        guard let folderId = favorites.first(where: { $0.id == id })?.parent, folderId != newParent,
              let folder = favorites.first(where: { $0.id == folderId }),
              folder.kind == "folder", folder.pinned, let parent = folder.parent, let guid = folder.guid
        else { return nil }
        let rest = favorites.filter { $0.parent == folderId && $0.id != id }
        guard rest.count <= 1 else { return nil }
        let siblings = favorites.filter { $0.parent == parent }
        let at = siblings.firstIndex { $0.id == folderId }
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "folder", "guid": guid, "parent": parent, "name": folder.name,
        ]
        add["before"] = at.flatMap { $0 > 0 ? siblings[$0 - 1].id : nil }
        add["after"] = at.flatMap { $0 + 1 < siblings.count ? siblings[$0 + 1].id : nil }
        var undo = [add] + rest.map { ["kind": "moveNode", "id": $0.id, "newParent": folderId] }
        if let scope = folder.pinScope, !scope.isEmpty {
            undo.append(["kind": "setPinScope", "id": folderId, "scope": scope])
        }
        return ([["kind": "removeKeepingChildren", "id": folderId]], undo)
    }

    /// Adds a deleted pin back where it was, under its guid: adding a
    /// deleted guid again is news to every device (`Document::add_favorite`).
    func restore(_ pin: PinRow, at place: PinPlace) async {
        guard let parent = place.parent, let url = pin.url else { return }
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "favorite", "guid": pin.guid, "parent": parent,
            "name": pin.name, "url": url,
        ]
        add["before"] = place.previous
        add["after"] = place.next
        var ops = [add]
        if let scope = place.scope, !scope.isEmpty {
            ops.append(["kind": "setPinScope", "id": pin.id, "scope": scope])
        }
        await editFavorites(ops)
    }

    /// Moves a pin or folder of pins to the end of Favorites and clears its
    /// Show in choices, as one change (pins-root spec §6).
    /// Returns the ops that make again a folder the move dissolved.
    @discardableResult
    func moveToFavorites(_ pin: PinRow) async -> [[String: Any]] {
        guard let root = favoritesRootId else { return [] }
        let dissolve = dissolving(pin.id, to: root)
        var ops: [[String: Any]] = []
        if pin.scope != nil {
            ops.append(["kind": "setPinScope", "id": pin.id])
        }
        var move: [String: Any] = ["kind": "moveNode", "id": pin.id, "newParent": root]
        move["before"] = lastChild(of: root)
        ops.append(move)
        ops += dissolve?.ops ?? []
        return await editFavorites(ops) ? dissolve?.undo ?? [] : []
    }

    /// Deletes the pin (pins-root spec §7).
    func deletePin(_ pin: PinRow) async {
        await editFavorites([["kind": "remove", "id": pin.id]])
    }

    func renamePin(_ pin: PinRow, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name != pin.name else { return }
        var op: [String: Any] = ["kind": "setContent", "id": pin.id, "name": name]
        op["url"] = pin.url
        await editFavorites([op])
    }

    /// Sets the address a pin returns to.
    func setPinAddress(_ pin: PinRow, to url: URL) async {
        let address = Self.normalAddress(url)
        guard address != pin.url, Self.opensHere(address) else { return }
        await editFavorites([["kind": "setContent", "id": pin.id, "name": pin.name, "url": address]])
    }

    /// Shows a pin in `workspaces` alone, or in every Workspace when that is
    /// all of them, so it shows in ones made later too (pins spec §7).
    func setPinScope(_ pin: PinRow, to workspaces: Set<String>) async {
        let mine = Set(self.workspaces.filter { $0.agent == nil }.map(\.id))
        guard !workspaces.isEmpty else { return }
        var op: [String: Any] = ["kind": "setPinScope", "id": pin.id]
        op["scope"] = workspaces.isSuperset(of: mine) ? nil : Array(workspaces).sorted()
        await editFavorites([op])
    }
}
