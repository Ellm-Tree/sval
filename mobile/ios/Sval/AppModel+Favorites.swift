// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AVFoundation
import Foundation
import Security
import Observation
import UIKit

extension AppModel {
    /// The top of Favorites, which the Favorites page opens on.
    var favoritesRootId: String? { favorites.first { $0.guid == Self.favoritesRoot }?.id }

    /// What a folder shows, in order: its favorites, folders and
    /// separators, without pins, which the pins row shows (pins spec §8.2).
    func favoriteItems(in parent: String) -> [Favorite] {
        favorites.filter { $0.parent == parent && !$0.pinned }
    }

    /// How many favorites a folder holds at any depth, as the desktop
    /// counts them (`SvalFavoritesStore.countIn`).
    func favoriteCount(in folder: String) -> Int {
        favoriteItems(in: folder).reduce(0) { count, item in
            switch item.kind {
            case "favorite": count + 1
            case "folder": count + favoriteCount(in: item.id)
            default: count
            }
        }
    }

    func favorite(_ id: String) -> Favorite? { favorites.first { $0.id == id } }

    /// Every favorite of `url` in Favorites, which the address bar's star
    /// fills for (`SvalFavoritesStore.favoritesWithUrl`): a pin is no
    /// favorite, nor is an item under another root.
    func favorites(of url: URL) -> [Favorite] {
        guard let root = favoritesRootId else { return [] }
        let address = Self.normalAddress(url)
        return favorites.filter { item in
            guard item.kind == "favorite", item.url == address else { return false }
            var parent = item.parent
            for _ in 0..<64 {
                guard let at = parent else { return false }
                if at == root { return true }
                parent = favorite(at)?.parent
            }
            return false
        }
    }

    /// The address a favorite or pin holds for `url`: parsed and written
    /// back, as the desktop stores one (`normalUrl`), so two spellings of
    /// one address are one favorite. A scheme and host take lower case, a
    /// scheme's default port goes, and an empty path is "/".
    static func normalAddress(_ url: URL) -> String {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        parts.scheme = parts.scheme?.lowercased()
        if let host = parts.host { parts.host = host.lowercased() }
        if (parts.scheme == "https" && parts.port == 443) || (parts.scheme == "http" && parts.port == 80) {
            parts.port = nil
        }
        if parts.host != nil, parts.path.isEmpty { parts.path = "/" }
        return parts.url?.absoluteString ?? url.absoluteString
    }

    /// Adds a page at the end of Favorites' top level, named with its
    /// title, as the desktop's star does (`SvalFavorites.addPage`).
    @discardableResult
    func addFavorite(_ url: URL, title: String) async -> Favorite? {
        let address = url.absoluteString
        guard Self.opensHere(address), let root = favoritesRootId else { return nil }
        let guid = Self.mintGuid()
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "favorite", "guid": guid, "parent": root,
            "name": title.isEmpty ? address : title, "url": address,
        ]
        add["before"] = favorites.last { $0.parent == root }?.id
        guard await editFavorites([add]) else { return nil }
        return favorite(favoriteId(guid: guid))
    }

    /// Makes an empty folder at the end of `parent`. Returns its id.
    func addFavoriteFolder(named name: String, in parent: String) async -> String? {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }
        let guid = Self.mintGuid()
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "folder", "guid": guid, "parent": parent, "name": name,
        ]
        add["before"] = favorites.last { $0.parent == parent }?.id
        return await editFavorites([add]) ? favoriteId(guid: guid) : nil
    }

    func renameFavorite(_ item: Favorite, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name != item.name else { return }
        var op: [String: Any] = ["kind": "setContent", "id": item.id, "name": name]
        op["url"] = item.url
        await editFavorites([op])
    }

    func setFavoriteAddress(_ item: Favorite, to url: URL) async {
        let address = Self.normalAddress(url)
        guard address != item.url, Self.opensHere(address) else { return }
        await editFavorites([["kind": "setContent", "id": item.id, "name": item.name, "url": address]])
    }

    /// Where an item sits in its folder: what puts it back there.
    struct FavoritePlace {
        let parent: String?
        let previous: String?
        let next: String?
    }

    func place(of item: Favorite) -> FavoritePlace {
        let siblings = favorites.filter { $0.parent == item.parent }
        let at = siblings.firstIndex { $0.id == item.id }
        return FavoritePlace(
            parent: item.parent,
            previous: at.flatMap { $0 > 0 ? siblings[$0 - 1].id : nil },
            next: at.flatMap { $0 + 1 < siblings.count ? siblings[$0 + 1].id : nil })
    }

    /// Whether `folder` is `item` or inside it, where `item` can't move.
    func isWithin(_ folder: String, _ item: String) -> Bool {
        var node: String? = folder
        while let id = node {
            if id == item { return true }
            node = favorite(id)?.parent
        }
        return false
    }

    /// Moves an item to the end of `folder`. Returns where it was.
    func moveFavorite(_ item: Favorite, to folder: String) async -> FavoritePlace? {
        guard item.parent != folder, !isWithin(folder, item.id) else { return nil }
        let back = place(of: item)
        var op: [String: Any] = ["kind": "moveNode", "id": item.id, "newParent": folder]
        op["before"] = favorites.last { $0.parent == folder && $0.id != item.id }?.id
        return await editFavorites([op]) ? back : nil
    }

    func moveFavorite(_ id: String, back place: FavoritePlace) async {
        guard let parent = place.parent else { return }
        var op: [String: Any] = ["kind": "moveNode", "id": id, "newParent": parent]
        op["before"] = place.previous
        op["after"] = place.next
        await editFavorites([op])
    }

    /// Deletes items, each folder with everything in it, as one change. Returns the change that brings them all back
    /// where they were (`SvalFavoritesStore`'s `#deleteOps`): adding a
    /// deleted guid again is news to every device (`Document::add_favorite`).
    func deleteFavorites(_ items: [Favorite]) async -> [[String: Any]]? {
        let top = items.filter { item in !items.contains { $0.id != item.id && isWithin(item.parent ?? "", $0.id) } }
        guard !top.isEmpty else { return nil }
        var undo: [[String: Any]] = []
        func readd(_ item: Favorite, previous: String?, next: String?) {
            var add: [String: Any] = [
                "kind": "addFavorite", "favoriteKind": item.kind, "guid": item.guid ?? "", "name": item.name,
            ]
            add["parent"] = item.parent
            add["before"] = previous
            add["after"] = next
            add["url"] = item.url
            if item.local { add["local"] = true }
            undo.append(add)
            var last: String?
            for child in favorites where child.parent == item.id {
                readd(child, previous: last, next: nil)
                last = child.id
            }
        }
        for item in top {
            let at = place(of: item)
            readd(item, previous: at.previous, next: at.next)
        }
        guard await editFavorites(top.map { ["kind": "remove", "id": $0.id] }) else { return nil }
        return undo
    }

    /// Whether a pin already has `item`'s address, when Pin is not offered
    /// for it (pins-root spec §6).
    func hasPin(for item: Favorite) -> Bool {
        item.kind == "favorite" && favorites.contains { $0.pinned && $0.kind == "favorite" && $0.url == item.url }
    }

    /// Pins a favorite or folder: a copy of it, with new guids, at the end
    /// of the row, the favorite left where it is (pins-root spec §6). A
    /// bookmarklet inside a folder is copied too, and gets no tile.
    func pinFavorite(_ item: Favorite) async {
        guard let root = pinsRootId else { return }
        var ops: [[String: Any]] = []
        @discardableResult
        func copy(_ from: Favorite, into parent: String, after: String?) -> String? {
            guard from.kind != "separator" else { return nil }
            let guid = Self.mintGuid()
            var add: [String: Any] = [
                "kind": "addFavorite", "favoriteKind": from.kind, "guid": guid, "parent": parent, "name": from.name,
            ]
            add["before"] = after
            if let url = from.url {
                add["url"] = url
                if from.local { add["local"] = true }
            }
            ops.append(add)
            let id = favoriteId(guid: guid)
            var last: String?
            for child in favorites where child.parent == from.id {
                last = copy(child, into: id, after: last) ?? last
            }
            return id
        }
        copy(item, into: root, after: lastChild(of: root))
        await editFavorites(ops)
    }

    /// Applies `ops` to Favorites and pins as one batch.
    @discardableResult
    func editFavorites(_ ops: [[String: Any]]) async -> Bool {
        await edit(ops, in: favoritesDocument)
    }
}
