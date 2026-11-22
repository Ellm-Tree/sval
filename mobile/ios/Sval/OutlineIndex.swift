// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

/// The tree's rows with the lookups views make on every frame answered from
/// tables built once per change: a row by id, a row's children, the
/// Workspace a row is in and a Workspace's tabs.
struct OutlineIndex {
    private(set) var rows: [OutlineRow]
    /// Each id's first row: an id the tree holds twice answers as the
    /// first.
    private let byId: [String: Int]
    private let childrenOf: [String: [Int]]
    private let workspaceOf: [String: String]
    private let tabsIn: [String: [Int]]
    /// The tabs and the groups below each row, at any depth.
    private let inside: [String: (tabs: Int, groups: Int)]

    init(_ rows: [OutlineRow] = []) {
        self.rows = rows
        var byId: [String: Int] = [:]
        var childrenOf: [String: [Int]] = [:]
        for (index, row) in rows.enumerated() {
            if byId[row.id] == nil { byId[row.id] = index }
            if let parent = row.parentId { childrenOf[parent, default: []].append(index) }
        }
        var workspaceOf: [String: String] = [:]
        var tabsIn: [String: [Int]] = [:]
        var inside: [String: (tabs: Int, groups: Int)] = [:]
        for (index, row) in rows.enumerated() {
            // A row whose parent the tree doesn't hold is in no Workspace,
            // and neither is one in a loop of parents, where the walk ends
            // at the first row it meets again. A missing parent still
            // counts what names it, as `children(of:)` lists it.
            var top: OutlineRow? = row
            var seen: Set<String> = [row.id]
            while let node = top, let parent = node.parentId {
                guard seen.insert(parent).inserted else {
                    top = nil
                    break
                }
                if row.kind == .tab { inside[parent, default: (0, 0)].tabs += 1 }
                if row.kind == .group { inside[parent, default: (0, 0)].groups += 1 }
                top = byId[parent].map { rows[$0] }
            }
            guard let workspace = top else { continue }
            if byId[row.id] == index { workspaceOf[row.id] = workspace.id }
            if row.kind == .tab { tabsIn[workspace.id, default: []].append(index) }
        }
        self.byId = byId
        self.childrenOf = childrenOf
        self.workspaceOf = workspaceOf
        self.tabsIn = tabsIn
        self.inside = inside
    }

    /// Puts `changed` in place of the rows with their ids. Each keeps its
    /// row's parent, depth and kind, which the tables are built from, so
    /// they stand.
    mutating func replace(_ changed: [OutlineRow]) {
        for row in changed {
            guard let at = byId[row.id] else { continue }
            rows[at] = row
        }
    }

    func row(_ id: String) -> OutlineRow? {
        byId[id].map { rows[$0] }
    }

    /// The rows whose parent is `id`, in tree order.
    func children(of id: String) -> [OutlineRow] {
        (childrenOf[id] ?? []).map { rows[$0] }
    }

    /// The Workspace `id` is in, or is.
    func workspace(of id: String) -> String? {
        workspaceOf[id]
    }

    /// The tabs in `workspace`, at any depth, in tree order.
    func tabs(in workspace: String) -> [OutlineRow] {
        (tabsIn[workspace] ?? []).map { rows[$0] }
    }

    /// How many tabs and groups `id` holds, at any depth.
    func inside(_ id: String) -> (tabs: Int, groups: Int) {
        inside[id] ?? (0, 0)
    }
}
