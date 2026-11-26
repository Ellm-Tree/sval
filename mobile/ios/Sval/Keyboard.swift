// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit

/// A Hide Keyboard button in the bar over the keyboard. The iPhone's
/// keyboard has no key of its own that puts it away, and a field with
/// several lines has no Return that does. SwiftUI puts the bar over its
/// own fields alone, so `EmojiField`'s keyboard goes without it.
struct HidesKeyboard: ViewModifier {
    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Hide Keyboard", systemImage: "keyboard.chevron.compact.down", action: Keyboard.hide)
            }
        }
    }
}

enum Keyboard {
    /// Ends editing in whichever field has the keyboard.
    static func hide() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// How much of the screen's foot the keyboard covers as it ends the
    /// change `note` tells of. A keyboard floating clear of the foot
    /// covers none.
    static func height(_ note: Notification) -> CGFloat {
        guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let screen = note.object as? UIScreen else { return 0 }
        let bounds = screen.bounds
        guard end.maxY >= bounds.maxY, end.minY < bounds.maxY else { return 0 }
        return bounds.maxY - end.minY
    }
}

extension View {
    /// Puts a Hide Keyboard button over the keyboard ([`HidesKeyboard`]).
    func hidesKeyboard() -> some View {
        modifier(HidesKeyboard())
    }
}
