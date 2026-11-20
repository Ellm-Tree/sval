// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

extension View {
    /// Asks before deleting the Workspace in `workspace`, and deletes it on
    /// yes. The strip's long-press menu and Edit Workspace both ask with it.
    /// `onDelete` runs first, for a sheet to close before the Workspace goes.
    func confirmsWorkspaceDelete(_ workspace: Binding<OutlineRow?>, onDelete: @escaping () -> Void = {}) -> some View {
        modifier(DeleteWorkspaceDialog(workspace: workspace, onDelete: onDelete))
    }
}

struct DeleteWorkspaceDialog: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var workspace: OutlineRow?
    let onDelete: () -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(
            workspace.map { "Delete the “\(WorkspaceTile.name($0))” Workspace?" } ?? "",
            isPresented: Binding(get: { workspace != nil }, set: { if !$0 { workspace = nil } }),
            titleVisibility: .visible, presenting: workspace
        ) { row in
            Button("Delete Workspace", role: .destructive) {
                onDelete()
                Task { await model.deleteWorkspace(row.id) }
            }
        } message: { row in
            let inside = model.tree.inside(row.id)
            if let text = Self.message(tabs: inside.tabs, groups: inside.groups) {
                Text(text)
            }
        }
    }

    /// What deleting a Workspace holding `tabs` tabs and `groups` groups,
    /// at any depth, takes with it, or nil when it holds nothing. The tree
    /// is synced, so the delete reaches every device.
    static func message(tabs: Int, groups: Int) -> String? {
        // "The tab and 3 groups", "The 9 tabs and 1 group": a number
        // reads oddly only straight after "The".
        let tabsText = tabs == 1 ? "tab" : "\(tabs) tabs", groupsText = groups == 1 ? "1 group" : "\(groups) groups"
        switch (tabs, groups) {
        case (0, 0): return nil
        case (1, 0): return "The tab inside will close on every device."
        case (_, 0): return "The \(tabs) tabs inside will close on every device."
        case (0, 1): return "The group inside will be deleted on every device."
        case (0, _): return "The \(groups) groups inside will be deleted on every device."
        default:
            return "The \(tabsText) and \(groupsText) inside will be deleted on every device."
        }
    }
}
