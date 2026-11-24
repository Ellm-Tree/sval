// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// What the Workspace and group dialog is open for.
enum LookTarget: Identifiable {
    case newWorkspace
    /// A new group in a Workspace, holding `members`, the rows ticked or
    /// moving, as it is made.
    case newGroup(parent: String, members: [String] = [])
    /// A tab dropped on a tab's middle: the group the two go into.
    case mergeGroup(MergePlan)
    case edit(OutlineRow)

    var id: String {
        switch self {
        case .newWorkspace: "new-workspace"
        case .newGroup(let parent, _): "new-group-" + parent
        case .mergeGroup(let plan): "merge-" + plan.id + "-" + plan.target
        case .edit(let row): "edit-" + row.id
        }
    }
}

/// A Workspace's or group's emoji, name and colour, in a sheet over the
/// Workspace sheet that takes the colour picked (`sval-dialog.css`,
/// `data-sval-tint`). Titles and buttons are the
/// desktop's (`sval-panel-edits.js`).
struct LookEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint

    let target: LookTarget
    let onClose: () -> Void
    /// Told the new Workspace's or group's id once it is made.
    var onCreated: (String) -> Void = { _ in }

    @State private var name: String
    @State private var emoji: String
    @State private var color: String?
    @State private var saving = false
    @State private var deleting: OutlineRow?
    /// The one custom colour, kept while a preset is chosen (16a).
    @State private var custom: DesktopColor.Custom?
    @FocusState private var nameFocused: Bool

    init(target: LookTarget, onClose: @escaping () -> Void, onCreated: @escaping (String) -> Void = { _ in }) {
        self.target = target
        self.onClose = onClose
        self.onCreated = onCreated
        switch target {
        // Sval never names a Workspace or group itself: a new one starts
        // unnamed, and Create waits for a name (`_promptForNewGroup`).
        case .newWorkspace, .newGroup, .mergeGroup:
            _name = State(initialValue: "")
            _emoji = State(initialValue: "")
            _color = State(initialValue: nil)
        case .edit(let row):
            _name = State(initialValue: row.name)
            _emoji = State(initialValue: row.emoji ?? "")
            _color = State(initialValue: row.color)
        }
    }

    private var editing: OutlineRow? {
        if case .edit(let row) = target { return row }
        return nil
    }

    /// Whether this is the phone's own Workspace (decision 2254).
    private var ownDevices: Bool {
        editing.map { $0.id == model.ownWorkspace?.id } ?? false
    }

    private var isWorkspace: Bool {
        switch target {
        case .newWorkspace: true
        case .newGroup, .mergeGroup: false
        case .edit(let row): row.kind == .workspace
        }
    }

    private var title: String {
        switch target {
        case .newWorkspace: "New Workspace"
        case .newGroup, .mergeGroup: "New Group"
        case .edit: isWorkspace ? "Edit Workspace" : "Edit Group"
        }
    }

    /// The Workspace's colour a group sits in, or none for a Workspace.
    private var workspaceColor: String? {
        sheetTint == Theme.privateToken ? nil : sheetTint
    }

    /// The surface a group's blocks step from: its Workspace's window.
    private var surface: DesktopColor.Surface {
        DesktopColor.surface(ofWorkspace: workspaceColor, dark: scheme == .dark)
    }

    /// The sheet's colours, every one solved on the colour chosen (16e): a
    /// Workspace's window, a group's block on its Workspace's window, or
    /// with a group's No color the Workspace's own.
    private var sheet: DesktopColor.Sheet {
        let dark = scheme == .dark
        let solved = isWorkspace ? DesktopColor.sheet(color, group: nil, dark: dark)
            : color == nil ? DesktopColor.sheet(workspaceColor, group: nil, dark: dark)
            : DesktopColor.sheet(color, group: surface, dark: dark)
        return solved ?? DesktopColor.Sheet(sheet: 0xEEF2FC, title: 0x060A2E, footer: 0x5A6699, cell: 0xFFFFFF,
                                            cellText: 0x060A2E, cellSecondary: 0x5A6699, ring: 0x929292,
                                            cancel: 0xE2E8F6, cancelInk: 0x060A2E, danger: 0xC42F3A, darkInk: true)
    }

    private var look: Look {
        let s = sheet
        return Look(ground: Color(hex: s.sheet), title: Color(hex: s.title), ink: Color(hex: s.cellText),
                    muted: Color(hex: s.footer), field: Color(hex: s.cell), ring: Color(hex: s.ring),
                    danger: Color(hex: s.danger), cancelInk: Color(hex: s.cancelInk),
                    scheme: s.darkInk ? .light : .dark)
    }

    var body: some View {
        let look = look
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 16) {
                        emojiTile(look)
                        TextField("Name", text: $name)
                            .font(.system(.body, weight: .medium))
                            .focused($nameFocused)
                            .selectsAllWhenEditing(name)
                            .submitLabel(.done)
                            .onSubmit(save)
                    }
                }
                .listRowBackground(look.field)
                ColorSection(color: $color, custom: $custom, isWorkspace: isWorkspace, surface: surface,
                             sheet: sheet) { nameFocused = false }
                if let editing, isWorkspace {
                    Section {
                        Button("Delete This Workspace…", systemImage: "trash", role: .destructive) {
                            deleting = editing
                        }
                        .foregroundStyle(look.danger)
                        .disabled(!model.canDelete(workspace: editing))
                        .confirmsWorkspaceDelete($deleting, onDelete: onClose)
                    } footer: {
                        if ownDevices {
                            Text("This \(UIDevice.current.model) can't delete its own Workspace.")
                                .foregroundStyle(look.muted)
                        }
                    }
                    .listRowBackground(look.field)
                }
            }
            // The bar's buttons keep the app's accent, so Save is Sval's
            // blue on every colour (16e).
            .tint(look.ink)
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(title)
            .sheetTitleMode(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close, action: onClose)
                        .foregroundStyle(look.cancelInk)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editing == nil ? "Create" : "Save", role: .confirm, action: save)
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
        }
        .foregroundStyle(look.ink)
        // The title, Cancel, Save and the fields are the system's, so they
        // take the side the colour reads on.
        .preferredColorScheme(look.scheme)
        // The sheet takes the colour picked, so the Workspace or group
        // previews as it will look, as the desktop's dialog does.
        .presentationBackground(look.ground)
        .presentationCornerRadius(Radius.sheet)
        .presentationDetents([.medium, .large])
        .animation(Motion.disclose, value: color)
        .onAppear {
            // A new one is named first; an edit opens on its look.
            if editing == nil { nameFocused = true }
        }
    }

    private func emojiTile(_ look: Look) -> some View {
        EmojiField(emoji: $emoji, placeholder: "", size: 32)
            .frame(width: 64, height: 64)
            .background(look.field, in: .rect(cornerRadius: 18))
            .overlay {
                if emoji.isEmpty {
                    Image(systemName: "face.smiling")
                        .font(.system(size: 26))
                        .foregroundStyle(look.ring)
                        .allowsHitTesting(false)
                }
            }
            .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(look.ring, lineWidth: 1.5).allowsHitTesting(false) }
            .overlay(alignment: .bottomTrailing) {
                Image(systemName: "pencil")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(look.ground)
                    .frame(width: 24, height: 24)
                    .background(look.title, in: .circle)
                    .overlay { Circle().strokeBorder(look.ground, lineWidth: 2) }
                    .offset(x: 6, y: 6)
                    .allowsHitTesting(false)
            }
            .accessibilityLabel("Choose Emoji")
    }

    private struct Look {
        let ground: Color, title: Color, ink: Color, muted: Color, field: Color, ring: Color, danger: Color
        let cancelInk: Color
        let scheme: ColorScheme
    }

    private func save() {
        guard !saving, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        saving = true
        Task {
            let picked = emoji.isEmpty ? nil : emoji
            switch target {
            case .edit(let row):
                if await model.saveLook(row, name: name, emoji: picked, color: color) { onClose() }
            case .newGroup(let parent, let members):
                if let id = await model.addGroup(named: name, emoji: picked, color: color, in: parent,
                                                 holding: members.compactMap(model.row)) {
                    onClose()
                    onCreated(id)
                }
            case .mergeGroup(let plan):
                if let id = await model.makeGroup(named: name, emoji: picked, color: color, for: plan) {
                    onClose()
                    onCreated(id)
                }
            case .newWorkspace:
                if let id = await model.addWorkspace(named: name, emoji: picked, color: color) {
                    onClose()
                    onCreated(id)
                }
            }
            saving = false
        }
    }
}
