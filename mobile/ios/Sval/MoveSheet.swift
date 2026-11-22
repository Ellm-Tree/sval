// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// Where tabs or groups can move (14d2): every Workspace, this one first.
/// A tap on a Workspace moves them to its top level; its › opens its
/// groups.
struct MoveSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let rows: [OutlineRow]
    /// Told what moved where, with a way to put it back.
    let onMoved: (Toast) -> Void

    init(rows: [OutlineRow], onMoved: @escaping (Toast) -> Void) {
        self.rows = rows
        self.onMoved = onMoved
    }

    init(row: OutlineRow, onMoved: @escaping (Toast) -> Void) {
        self.init(rows: [row], onMoved: onMoved)
    }

    @State private var openWorkspaces: Set<String> = []
    /// New Group…'s editor, and what puts the rows back once it makes
    /// the group.
    @State private var naming: LookTarget?
    @State private var putBack: [[String: Any]] = []

    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var home: String? { rows.first.flatMap { model.workspace(of: $0.id) } }

    /// This Workspace, then the others. A private tab never leaves the
    /// private session, and nothing moves into an agent's Workspace.
    private var targets: [OutlineRow] {
        let here = home.flatMap(model.row)
        if rows.contains(where: { model.isPrivate($0.id) }) { return here.map { [$0] } ?? [] }
        return (here.map { [$0] } ?? []) + model.workspaces.filter { $0.id != home && $0.agent == nil }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(targets, id: \.id) { workspace in
                        workspaceRow(workspace)
                        if openWorkspaces.contains(workspace.id) {
                            ForEach(groups(in: workspace.id), id: \.id) { group in
                                destination(group, text: name(group), icon: "folder",
                                            pad: 50 + CGFloat(group.depth - 1) * 30)
                            }
                            if model.makesGroups(in: workspace.id) {
                                NewDestinationRow(text: "New Group…", indent: 50, theme: theme) {
                                    nameNewGroup(in: workspace.id)
                                }
                            }
                        }
                    }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(theme.cell)
            }
            // A Workspace's row holds two buttons, the move and its ›; a
            // List row would otherwise run both on any tap.
            .buttonStyle(.borderless)
            .foregroundStyle(theme.text)
            .sheetGround()
            .navigationTitle("Move to…")
            .navigationSubtitle(subject)
            .sheetTitleMode("Move to…", subtitle: subject)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
        .onAppear {
            // The groups of the Workspace the rows are in are open, as the
            // likeliest place to move within.
            if let home { openWorkspaces.insert(home) }
        }
        .sheet(item: $naming) { target in
            LookEditor(target: target, onClose: { naming = nil }) { id in
                guard let group = model.row(id) else { return }
                let undo = putBack
                dismiss()
                onMoved(Toast(text: "Moved to \(describe(group))") {
                    Task { await model.moveBack(undo) }
                })
            }
        }
    }

    /// What's moving: the row's name, or how many tabs.
    private var subject: String {
        rows.count == 1 ? name(rows[0]) : "\(rows.count) tabs"
    }

    private func name(_ row: OutlineRow) -> String {
        row.displayTitle
    }

    /// A Workspace: a tap moves to its top level, and the 44pt › beside it
    /// opens its groups.
    private func workspaceRow(_ workspace: OutlineRow) -> some View {
        let current = rows.allSatisfy { $0.parentId == workspace.id }
        let open = openWorkspaces.contains(workspace.id)
        return HStack(spacing: 0) {
            Button { Task { await move(to: workspace) } } label: {
                HStack(spacing: 11) {
                    WorkspaceTile(workspace: workspace, size: 28)
                    Text(WorkspaceTile.name(workspace))
                        .font(.system(.body, weight: .medium))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if current {
                        Text("Current")
                            .font(.system(.footnote))
                            .foregroundStyle(theme.muted)
                    }
                }
                .padding(.leading, 14)
                .frame(minHeight: RowMetrics.chooser)
                .contentShape(.rect)
            }
            .disabled(current)
            if !groups(in: workspace.id).isEmpty || model.makesGroups(in: workspace.id) {
                Button {
                    withAnimation(reduceMotion ? nil : Motion.disclose) {
                        if open { openWorkspaces.remove(workspace.id) } else { openWorkspaces.insert(workspace.id) }
                    }
                } label: {
                    Chevron(open: open, color: theme.muted)
                        .frame(width: 44, height: RowMetrics.chooser)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Groups in \(WorkspaceTile.name(workspace))")
                .accessibilityValue(open ? "Expanded" : "Collapsed")
            } else {
                Color.clear.frame(width: 14, height: RowMetrics.chooser)
            }
        }
    }

    private func destination(_ target: OutlineRow, text: String, icon: String, pad: CGFloat) -> some View {
        DestinationRow(text: text, icon: icon, indent: pad, current: rows.allSatisfy { $0.parentId == target.id },
                       theme: theme) { Task { await move(to: target) } }
    }

    /// The groups in a Workspace in tree order, without the rows moving or
    /// anything inside them.
    private func groups(in workspace: String) -> [OutlineRow] {
        var excluded = Set(rows.map(\.id))
        return model.rows.filter { candidate in
            guard model.workspace(of: candidate.id) == workspace, candidate.id != workspace else { return false }
            if let parent = candidate.parentId, excluded.contains(parent) {
                excluded.insert(candidate.id)
                return false
            }
            return candidate.kind == .group && !excluded.contains(candidate.id)
        }
    }

    private func move(to target: OutlineRow) async {
        guard let undo = await model.move(rows, to: target.id) else { return }
        dismiss()
        onMoved(Toast(text: "Moved to \(describe(target))") {
            Task { await model.moveBack(undo) }
        })
    }

    /// New Group…: the group is named first, as the desktop's is, and
    /// made with the rows in it in one write; Cancel writes nothing.
    private func nameNewGroup(in workspace: String) {
        putBack = model.returnOps(for: model.outermost(rows))
        naming = .newGroup(parent: workspace, members: rows.map(\.id))
    }

    /// "✈️ Travel › Lyon": the Workspace, and the group when there is one.
    private func describe(_ target: OutlineRow) -> String {
        let workspace = model.workspace(of: target.id).flatMap(model.row)
        let title = workspace.map { [$0.emoji, WorkspaceTile.name($0)].compactMap { $0 }.joined(separator: " ") } ?? ""
        return target.parentId == nil ? title : "\(title) › \(name(target))"
    }
}
