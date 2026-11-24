// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Observation

/// What the workspaces document holds after a revision, read in one go
/// from where the document lives.
enum TreeRead: Sendable {
    /// Nothing changed after `since`.
    case same(since: UInt64)
    /// Only the content of these rows changed after `since`: every row
    /// keeps its place, parent, depth and kind.
    case rows(since: UInt64, revision: UInt64, [OutlineRow])
    /// The whole outline, read when a row may have moved, or when no
    /// revision was held or the document forgot it.
    case whole(revision: UInt64, [OutlineRow])

    /// The revision the read leaves the tree at.
    var revision: UInt64 {
        switch self {
        case .same(let since): since
        case .rows(_, let revision, _), .whole(let revision, _): revision
        }
    }

    /// The read, when it holds every change up to `revision`.
    func current(at revision: UInt64) -> TreeRead? {
        self.revision >= revision ? self : nil
    }
}

/// A document the tree is read from: the `Syncer`'s, or a test's own.
protocol TreeSource {
    func treeRead(since revision: UInt64?) async -> TreeRead
}

extension SvalDocument: TreeSource {
    func treeRead(since held: UInt64?) -> TreeRead {
        guard let held, let changes = changesSince(revision: held) else {
            let revision = revision()
            return .whole(revision: revision, outline())
        }
        if changes.revision == held { return .same(since: held) }
        if changes.structural { return .whole(revision: changes.revision, outline()) }
        return .rows(since: held, revision: changes.revision, outlineRows(ids: changes.changed))
    }
}

/// One row of the tree, observed on its own, so a view that shows one row
/// redraws when that row changes alone.
@Observable @MainActor final class RowBox {
    private(set) var row: OutlineRow

    init(_ row: OutlineRow) {
        self.row = row
    }

    fileprivate func set(_ row: OutlineRow) {
        if row != self.row { self.row = row }
    }
}

/// The synced tree followed by the private session's rows, as of the
/// revision of the workspaces document last installed, with a box for
/// each row. A change of content puts the rows that changed in place; a
/// change that may move rows builds the index again.
@Observable @MainActor final class TreeStore {
    /// What changed when a read was installed.
    enum Change {
        case none
        /// Rows changed in place.
        case content
        /// The index was built again.
        case structure
    }

    private(set) var index = OutlineIndex()
    /// The revision `index`'s synced rows are at, nil before the first read.
    @ObservationIgnored private(set) var revision: UInt64?
    @ObservationIgnored private var boxes: [String: RowBox] = [:]
    @ObservationIgnored private var synced: [OutlineRow] = []
    @ObservationIgnored private var own: [OutlineRow] = []

    func box(_ id: String) -> RowBox? {
        boxes[id]
    }

    /// Reads what changed in `source` after the revision held, and installs
    /// it with `own`, the private session's rows.
    @discardableResult
    func refresh(from source: some TreeSource, own: [OutlineRow]) async -> Change {
        install(await source.treeRead(since: revision), own: own)
    }

    /// Installs `read` with `own`. A read no newer than the revision held
    /// leaves the synced rows as they are, as does a change of content
    /// read against a revision this store no longer holds the rows of.
    @discardableResult
    func install(_ read: TreeRead, own: [OutlineRow]) -> Change {
        var rebuilt = false
        var patched: [OutlineRow] = []
        switch read {
        case .same:
            break
        case .rows(_, let revision, let rows):
            guard let held = self.revision, revision > held else { break }
            self.revision = revision
            let changed = rows.filter { boxes[$0.id]?.row != $0 }
            for row in changed {
                guard let at = synced.firstIndex(where: { $0.id == row.id }) else { continue }
                synced[at] = row
                patched.append(row)
            }
        case .whole(let revision, let rows):
            if let held = self.revision, revision <= held { break }
            self.revision = revision
            if rows != synced {
                synced = rows
                rebuilt = true
            }
        }
        if own != self.own {
            self.own = own
            rebuilt = true
        }
        if rebuilt {
            let all = synced + own
            index = OutlineIndex(all)
            var kept: [String: RowBox] = [:]
            for row in all where kept[row.id] == nil {
                if let box = boxes[row.id] {
                    box.set(row)
                    kept[row.id] = box
                } else {
                    kept[row.id] = RowBox(row)
                }
            }
            boxes = kept
            return .structure
        }
        guard !patched.isEmpty else { return .none }
        index.replace(patched)
        for row in patched { boxes[row.id]?.set(row) }
        return .content
    }

    /// Forgets the tree, for a syncer whose revisions count afresh.
    func reset() {
        revision = nil
        synced = []
        own = []
        boxes = [:]
        index = OutlineIndex()
    }
}
