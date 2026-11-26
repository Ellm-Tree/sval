// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit

/// While the bar is swiped, the Workspace the swipe would switch to, with
/// where it sits in the order, on glass in that Workspace's colour, as
/// its bar sliding in is.
struct WorkspaceSwipeHUD: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    let target: OutlineRow
    let index: Int
    let count: Int

    var body: some View {
        let colors = BarColors(token: model.tint(of: target), dark: scheme == .dark)
        VStack(spacing: 8) {
            HStack(spacing: Space.rowGap) {
                WorkspaceTile(workspace: target, size: 32)
                Text(WorkspaceTile.name(target))
                    .font(.system(.body, weight: .semibold))
                    .foregroundStyle(colors.ink)
                    .lineLimit(1)
            }
            if count <= 12 {
                PageDots(count: count, current: index, on: colors.ink, off: colors.muted.opacity(Dim.pageDot), height: 6)
            }
        }
        .padding(.horizontal, Space.glassInset)
        .padding(.vertical, 12)
        .glassEffect(workspaceGlass(colors.layer, interactive: false), in: .rect(cornerRadius: Radius.card))
        .accessibilityHidden(true)
    }
}

/// A field that takes one emoji, typed on the system's emoji keyboard.
struct EmojiField: UIViewRepresentable {
    @Binding var emoji: String
    let placeholder: String
    var size: CGFloat = 44

    func makeUIView(context: Context) -> UITextField {
        let field = EmojiTextField()
        field.textAlignment = .center
        field.font = .systemFont(ofSize: size)
        field.tintColor = .clear
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        field.text = emoji
        field.placeholder = placeholder
    }

    func makeCoordinator() -> Coordinator { Coordinator(emoji: $emoji) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        let emoji: Binding<String>
        init(emoji: Binding<String>) { self.emoji = emoji }

        /// Keeps the last emoji typed, so a second tap replaces the first.
        /// The robot marks an agent's Workspace alone, so a tap on it keeps
        /// the emoji there was: the desktop's picker never offers it, and a
        /// desktop reads it as none (`unreserved`).
        @objc func changed(_ field: UITextField) {
            let picked = (field.text ?? "").last.map(String.init) ?? ""
            let isEmoji = picked.unicodeScalars.first?.properties.isEmojiPresentation == true
                || picked.unicodeScalars.count > 1
            if picked.unicodeScalars.first?.value != 0x1F916 {
                emoji.wrappedValue = isEmoji ? picked : ""
            }
            field.text = emoji.wrappedValue
        }
    }
}

/// A text field that opens the emoji keyboard, as the desktop's emoji
/// picker opens on the Workspace's tile.
final class EmojiTextField: UITextField {
    override var textInputMode: UITextInputMode? {
        UITextInputMode.activeInputModes.first { $0.primaryLanguage == "emoji" } ?? super.textInputMode
    }
}
