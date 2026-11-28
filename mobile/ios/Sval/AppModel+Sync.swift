// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AVFoundation
import Foundation
import Security
import Observation
import UIKit

extension AppModel {
    func sync() async {
        guard stage == .ready, let syncer = await loadedSyncer(), source != nil,
              let key = secrets.syncKey()
        else { return }
        guard !syncing else {
            syncAgain = true
            return
        }
        syncing = true
        defer {
            syncing = false
            if syncAgain {
                syncAgain = false
                Task { await sync() }
            }
        }
        // A pass that ends after the phone left the folder reports on a
        // folder it no longer uses.
        let from = source
        do {
            let report = try await syncer.sync(shared: sharedFolder(), syncKey: key, starting: starting)
            guard source == from else { return }
            if starting { starting = false }
            Diagnostics.log("sync: merged \(report.merged), errors \(report.errors.count), unreadable \(report.unreadable.count), wrote \(report.wrote)")
            lastSynced = .now
            unreachableSince = nil
            // A file caught mid-write fails once and is read on the next
            // pass, so only a file that fails twice running is reported.
            let lasting = report.problems.intersection(lastProblems)
            lastProblems = report.problems
            let problem = lasting.isEmpty ? nil : "\(lasting.count) file(s) in the folder couldn't be read."
            if problem != message { message = problem }
        } catch {
            guard source == from else { return }
            Diagnostics.log("sync: failed \(Diagnostics.name(error))")
            // A lost connection is made again on the next pass.
            if error is ConnectorError {
                connected = nil
            }
            let since = unreachableSince ?? .now
            unreachableSince = since
            let away = Date.now.timeIntervalSince(since)
            if away < 0 || away >= Self.unavailableAfter {
                message = error.localizedDescription
            }
        }
        // The tree as the pass left it, from the syncer in use once it is
        // read: leaving the folder meanwhile replaces it.
        var read: (Syncer, TreeRead)?
        if let current = self.syncer {
            let tree = await current.treeRead(since: treeStore.revision)
            if self.syncer === current { read = (current, tree) }
        }
        if let read { await keepTabsInFront(read.1) }
        await refreshRows(read)
        await keepOwnWorkspace()
        await refreshHistory()
    }

    /// Records a use of tab `id`, so a device that archives idle tabs keeps
    /// one used only here (idle-tab archive spec §4.1). The engine stamps a
    /// tab at most once an hour (`mark_used`), so this writes rarely, and
    /// the next pass carries it.
    func markUsed(_ id: String) async {
        guard let syncer, row(id)?.kind == .tab, !isPrivate(id) else { return }
        do {
            try await syncer.edit(workspacesDocument, opsJson: #"[{"kind":"markUsed","id":"\#(id)"}]"#)
        } catch {
            Diagnostics.log("edit: a tab's use was not recorded: \(Diagnostics.name(error))")
        }
    }

    /// Gives back each tab another device's close took while it is in
    /// front here, under its own id: at its parent when the
    /// tree still holds that in the tab's Workspace, beside it for a split,
    /// and at the top of the Workspace otherwise. Every peer reads the node
    /// as news, so the tab returns on the device that closed it. Run as the
    /// pass returns, while `rows` still shows the tree before it, and
    /// before `reconcile` lets the page go. A Workspace the pass deleted
    /// takes its tabs with it.
    private func keepTabsInFront(_ read: TreeRead) async {
        // A change of content alone leaves every row where it was, so no
        // tab left the tree.
        guard case .whole(_, let after) = read else { return }
        let ops = Self.keptInFrontOps(tree, after: after, privateIds: privateIds, inFront: browser.isInFront)
        guard !ops.isEmpty else { return }
        Diagnostics.log("sync: kept \(ops.filter { $0["kind"] as? String == "addTab" }.count) tab(s) in front that another device closed")
        await edit(ops)
    }

    /// The edits that give back each tab of `before` in front here, by
    /// `inFront`, that `after`, the outline a pass left, no longer holds
    /// (`keepTabsInFront`).
    nonisolated static func keptInFrontOps(_ before: OutlineIndex, after: [OutlineRow], privateIds: Set<String>,
                                           inFront: (String) -> Bool) -> [[String: Any]] {
        let now = Dictionary(after.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        func within(_ id: String, _ workspace: String) -> Bool {
            var node: String? = id
            for _ in 0..<64 {
                guard let at = node else { return false }
                if at == workspace { return true }
                node = now[at]?.parentId
            }
            return false
        }
        var ops: [[String: Any]] = []
        for tab in before.rows where tab.kind == .tab && now[tab.id] == nil && !privateIds.contains(tab.id) {
            guard inFront(tab.id), let url = tab.url, let home = before.workspace(of: tab.id), now[home] != nil
            else { continue }
            var former = tab.parentId
            var place = place(of: tab, in: before)
            if let parent = former, before.row(parent)?.kind == .split {
                former = before.row(parent)?.parentId
                place = closedPlace(of: tab, in: before)
            }
            var add: [String: Any] = ["kind": "addTab", "name": tab.name, "url": url, "id": tab.id, "local": tab.local]
            if let former, now[former] != nil, within(former, home) {
                add["parent"] = former
                add["before"] = place?.previous.flatMap { now[$0]?.parentId == former ? $0 : nil }
                add["after"] = place?.next.flatMap { now[$0]?.parentId == former ? $0 : nil }
            } else {
                add["parent"] = home
                add["after"] = after.first { $0.parentId == home }?.id
            }
            ops.append(add)
            if let label = tab.label { ops.append(["kind": "setLabel", "id": tab.id, "label": label]) }
        }
        return ops
    }

    @discardableResult
    func edit(_ op: [String: Any]) async -> Bool {
        await edit([op])
    }

    /// Every change the user makes, to any document, comes through here:
    /// applied as one batch, all of it or none, and shown at once. The pass
    /// that carries it to the shared folder runs behind it, since a pass can
    /// take seconds and nothing on screen waits for it.
    @discardableResult
    func edit(_ ops: [[String: Any]], in document: String = workspacesDocument) async -> Bool {
        if document == workspacesDocument, touchesPrivate(ops) { return await editPrivate(ops) }
        guard let syncer = await loadedSyncer() else { return false }
        // Titles held back go out with any other change to the tree, as
        // the desktop's flush carries them, ahead of it so a tab the
        // change removes still takes its title first.
        let (held, taken) = document == workspacesDocument ? heldTitleOps() : ([], [:])
        let ops = held + ops
        let kind = ops.compactMap { $0["kind"] as? String }.joined(separator: "+")
        let started = ContinuousClock.now
        do {
            let json = try JSONSerialization.data(withJSONObject: ops)
            try await syncer.edit(document, opsJson: String(decoding: json, as: UTF8.self))
            Diagnostics.log("edit: \(document) \(kind) in \((ContinuousClock.now - started).components.attoseconds / 1_000_000_000_000_000 + (ContinuousClock.now - started).components.seconds * 1000) ms")
            if message != nil { message = nil }
        } catch {
            Diagnostics.log("edit: \(document) \(kind) failed \(Diagnostics.name(error))")
            message = error.localizedDescription
            TitleHold.shared.putBack(taken)
            return false
        }
        await refreshRows()
        Task { await sync() }
        return true
    }

    /// What a refresh began from: the syncer, its documents' revisions,
    /// and the private session's document and revision.
    struct RefreshMark: Equatable {
        let syncer: ObjectIdentifier
        let revisions: Revisions
        let own: ObjectIdentifier?
        let ownRevision: UInt64?
    }

    private func refreshMark(_ syncer: Syncer) async -> RefreshMark {
        let revisions = await syncer.revisions()
        return RefreshMark(syncer: ObjectIdentifier(syncer), revisions: revisions,
                           own: privateDocument.map(ObjectIdentifier.init), ownRevision: privateDocument?.revision())
    }

    /// Reads the documents again and shows what changed. `read` is the
    /// tree as a pass's end already read it, and the syncer it came from.
    /// A refresh asked for while one runs waits for it, and runs again
    /// only if a document moved since that one began.
    func refreshRows(_ read: (Syncer, TreeRead)? = nil) async {
        var waited = false
        await refreshes.run(isDue: {
            waited = true
            guard let syncer else { return false }
            return await refreshMark(syncer) != refreshedFrom
        }, { [weak self] in
            // A read taken before a refresh this one waited on is older
            // than what that refresh showed.
            await self?.refreshOnce(waited ? nil : read)
        })
    }

    private func refreshOnce(_ read: (Syncer, TreeRead)?) async {
        guard let syncer else { return }
        let refresh = Signposts.refresh.beginInterval("refreshRows")
        // A read from a syncer that was replaced meanwhile counts another
        // syncer's revisions.
        func current() -> Bool { self.syncer === syncer }
        let mark = await refreshMark(syncer)
        refreshedFrom = mark
        let revisions = mark.revisions
        let outlining = Signposts.outline.beginInterval("outline")
        // A pass reads the tree before this refresh takes its mark, and an
        // edit landing between the two is in the mark: a read without it
        // would stand for the mark, and the edit's own refresh, finding the
        // mark unmoved, would show nothing.
        var tree = read.flatMap { $0.0 === syncer ? $0.1.current(at: revisions.workspaces) : nil }
        if tree == nil { tree = await syncer.treeRead(since: treeStore.revision) }
        let own = privateDocument?.outline() ?? []
        Signposts.outline.endInterval("outline", outlining)
        let assigning = Signposts.outline.beginInterval("rows")
        // Set only when changed: every view reading them redraws on each
        // set, and a refresh often changes nothing.
        let ownIds = Set(own.map(\.id))
        if ownIds != privateIds { privateIds = ownIds }
        var treeChange = TreeStore.Change.none
        if current(), let tree { treeChange = treeStore.install(tree, own: own) }
        if treeChange != .none {
            reindexLauncher()
            browser.refreshBar()
        }
        Signposts.outline.endInterval("rows", assigning, "\(self.rows.count) rows")
        let reading = Signposts.refresh.beginInterval("settings")
        if marks.settingsDue(revisions) {
            let (revision, synced) = await syncer.settings()
            if current(), marks.keepSettings(at: revision), !NSDictionary(dictionary: synced).isEqual(to: settings) {
                settings = synced
                browser?.applyMediaChoices()
            }
        }
        Signposts.refresh.endInterval("settings", reading, "\(self.settings.count) settings")
        let favoring = Signposts.refresh.beginInterval("favorites")
        if marks.favoritesDue(revisions) {
            let (revision, read) = await syncer.favorites()
            let marked = Self.markingPins(read)
            if current(), marks.keepFavorites(at: revision), marked != favorites { favorites = marked }
        }
        await keepFavoriteRoots()
        Signposts.refresh.endInterval("favorites", favoring, "\(self.favorites.count) favorites")
        let pinning = Signposts.refresh.beginInterval("pins")
        var pinsChanged = false
        let listed = workspaces
        let shown = Dictionary(listed.map { ($0.id, $0.agent != nil) }, uniquingKeysWith: { a, _ in a })
        if marks.pinsDue(revisions, for: shown) {
            let (revision, all) = await syncer.pins(workspaces: listed.map(\.id))
            var pins: [String: [PinRow]] = [:]
            for workspace in listed where workspace.agent == nil {
                // The phone opens web addresses only, so another device's pin
                // at any other address gets no tile (pins spec §5, decision
                // 1372).
                pins[workspace.id] = all[workspace.id]?
                    .filter { $0.kind == "folder" || $0.url.map(Self.opensHere) ?? false }
            }
            if current(), marks.keepPins(at: revision, for: shown), pins != pinsByWorkspace {
                pinsByWorkspace = pins
                pinsChanged = true
            }
        }
        Signposts.refresh.endInterval("pins", pinning, "\(self.pinsByWorkspace.count) workspaces")
        let pages = Signposts.refresh.beginInterval("pages")
        // Which pages live follows the tree's tabs and the pins alone.
        if treeChange == .structure || pinsChanged {
            browser.reconcile()
            PagePreviews.shared.keep(only: Browser.pictured(rows, pins: pinsByWorkspace))
        }
        await browser.offloadHiddenWorkspaces()
        Signposts.refresh.endInterval("pages", pages)
        Signposts.refresh.endInterval("refreshRows", refresh, "\(self.rows.count) rows")
    }

    /// `rows` with each one under the pins root marked a pin.
    private static func markingPins(_ rows: [Favorite]) -> [Favorite] {
        guard let root = rows.first(where: { $0.guid == pinsRoot })?.id else { return rows }
        let parents = Dictionary(rows.map { ($0.id, $0.parent) }, uniquingKeysWith: { first, _ in first })
        func under(_ id: String) -> Bool {
            var at = parents[id] ?? nil
            for _ in 0..<rows.count {
                guard let parent = at else { return false }
                if parent == root { return true }
                at = parents[parent] ?? nil
            }
            return false
        }
        return rows.map { row in
            var row = row
            row.pinned = under(row.id)
            return row
        }
    }

    /// Makes any root folder the favorites document lacks, and moves pins
    /// still carrying the old pin flag into the pins root, as the desktop
    /// does on start (`SvalFavoritesStore.start`, pins-root spec §8). A
    /// phone that starts syncing a folder has no roots until it makes them.
    private func keepFavoriteRoots() async {
        guard browsing, !keepingFavoriteRoots else { return }
        let missing = Self.rootGuids.filter { guid in !favorites.contains { $0.guid == guid } }
        let marked = favorites.contains(where: \.marked)
        guard !missing.isEmpty || marked else { return }
        keepingFavoriteRoots = true
        defer { keepingFavoriteRoots = false }
        var ops: [[String: Any]] = missing.map {
            ["kind": "addFavorite", "favoriteKind": "folder", "guid": $0, "name": ""]
        }
        if marked { ops.append(["kind": "movePinsToRoot"]) }
        if await editFavorites(ops) {
            Diagnostics.log("favorites: made \(missing.count) roots\(marked ? ", moved pins to their root" : "")")
        }
    }
}
