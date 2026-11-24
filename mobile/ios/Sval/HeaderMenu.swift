// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UniformTypeIdentifiers

/// The header's ••• menu (15a1). A view of its own that redraws only when
/// what it shows changes: rebuilt with the sheet, the open menu flashed.
struct HeaderMenu: View, Equatable {
    @Binding var layout: TabLayout
    /// The Workspace the actions act on: a menu kept for another one would
    /// edit that one.
    let workspaceId: String
    let editable: Bool
    let groups: Bool
    let editsWorkspace: Bool
    let onEditTabs: () -> Void
    let onEditWorkspace: () -> Void
    let onNewGroup: () -> Void

    static func == (a: HeaderMenu, b: HeaderMenu) -> Bool {
        a.layout == b.layout && a.workspaceId == b.workspaceId && a.editable == b.editable && a.groups == b.groups && a.editsWorkspace == b.editsWorkspace
    }

    var body: some View {
        Menu {
            Picker("Show Tabs As", selection: $layout) {
                ForEach(TabLayout.allCases, id: \.self) { choice in choice.label.tag(choice) }
            }
            .pickerStyle(.palette)
            .menuActionDismissBehavior(.enabled)
            if editable {
                Section {
                    Button(groups ? "Edit Tabs and Groups…" : "Edit Tabs…", systemImage: "checkmark.circle",
                           action: onEditTabs)
                    if editsWorkspace {
                        Button("Edit Workspace…", systemImage: "pencil", action: onEditWorkspace)
                    }
                }
                if groups {
                    Button("New Group…", systemImage: "folder.badge.plus", action: onNewGroup)
                }
            }
        } label: {
            Label("Workspace options", systemImage: "ellipsis")
        }
    }
}
