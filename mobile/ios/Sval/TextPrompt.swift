// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// What each text prompt saves from the text it was given, or nil to save
/// nothing. What the model then does with an empty or unchanged value is
/// the model's: `AppModel.rename`, `renameSplit`, `renamePin`.
enum PromptValue {
    /// Rename Tab: the name without the spaces round it. An empty one is
    /// saved, which takes a tab's label away.
    static func tabName(_ text: String) -> String? {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Rename Split and Rename Pin: the text as typed.
    static func asTyped(_ text: String) -> String? {
        text
    }

    /// Rename Favorite: the name without the spaces round it. An empty one
    /// changes nothing.
    static func favoriteName(_ text: String) -> String? {
        let name = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    /// Create Pin Folder: the name without the spaces round it, and the
    /// placeholder name for an empty one, since Create always makes the
    /// folder.
    static func pinFolderName(_ text: String) -> String? {
        let name = text.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? PinsRow.newPinFolderName : name
    }

    /// Edit Address: the web address typed, as the Launcher reads one.
    static func address(_ text: String) -> URL? {
        Address.typed(text)
    }
}

/// Asks for one line of text in the system's alert, opened while `item`
/// is set: its title, the field holding `initial(item)`, Cancel, and
/// `confirm`, which saves `value` of the text when it gives one. The
/// keyboard comes up with the text selected, so typing replaces it.
struct TextPrompt<Item, Value>: ViewModifier {
    @Binding var item: Item?
    let title: String
    let placeholder: String
    let confirm: String
    let keyboard: UIKeyboardType
    let submit: SubmitLabel?
    let initial: (Item) -> String
    let value: (String) -> Value?
    let save: (Item, Value) -> Void
    @State private var text = ""

    func body(content: Content) -> some View {
        content
            .alert(title, isPresented: Binding(get: { item != nil }, set: { if !$0 { item = nil } })) {
                TextField(placeholder, text: $text)
                    .keyboardType(keyboard)
                    .modifier(PromptField(address: keyboard == .URL, submit: submit))
                Button("Cancel", role: .cancel) {}
                Button(confirm) {
                    guard let item, let value = value(text) else { return }
                    save(item, value)
                }
            }
            .onChange(of: item != nil, initial: true) { _, shown in
                if shown, let item { text = initial(item) }
            }
            .modifier(FocusesAlertField(presented: item != nil))
    }
}

/// An address field neither capitalizes nor corrects, and a field with a
/// return key label shows it.
private struct PromptField: ViewModifier {
    let address: Bool
    let submit: SubmitLabel?

    func body(content: Content) -> some View {
        let field = Group {
            if address {
                content.textInputAutocapitalization(.never).autocorrectionDisabled()
            } else {
                content
            }
        }
        if let submit { field.submitLabel(submit) } else { field }
    }
}

extension View {
    func textPrompt<Item, Value>(
        _ title: String, item: Binding<Item?>, placeholder: String = "Name", confirm: String = "Rename",
        keyboard: UIKeyboardType = .default, submit: SubmitLabel? = nil,
        initial: @escaping (Item) -> String, value: @escaping (String) -> Value?,
        save: @escaping (Item, Value) -> Void
    ) -> some View {
        modifier(TextPrompt(item: item, title: title, placeholder: placeholder, confirm: confirm, keyboard: keyboard,
                            submit: submit, initial: initial, value: value, save: save))
    }
}

/// Puts the keyboard up in an alert's text field with all its text
/// selected, so typing replaces it at once, as every action that asks for
/// text does. SwiftUI draws an alert as a `UIAlertController`, whose field
/// doesn't always take focus, as when the alert opens from a drop, and
/// which leaves the caret after the text when it does: opened from a
/// context menu or a menu button on iOS 27.2, its text isn't selected. A
/// modifier on the field in the alert reaches no `UITextField`. So once
/// the alert is up, this finds its field and asks UIKit.
private struct FocusesAlertField: ViewModifier {
    let presented: Bool

    func body(content: Content) -> some View {
        content.onChange(of: presented) { _, now in
            guard now else { return }
            Task { @MainActor in
                // The alert is presented a moment after the state that
                // asks for it; a second is far longer than that takes.
                for _ in 0..<40 {
                    if let field = Self.field() {
                        field.becomeFirstResponder()
                        DispatchQueue.main.async { field.selectAll(nil) }
                        Diagnostics.log("alert: the field took focus")
                        return
                    }
                    try? await Task.sleep(for: .milliseconds(25))
                }
                Diagnostics.log("alert: no field to focus")
            }
        }
    }

    /// The first text field of the alert in front, if one is up.
    @MainActor private static func field() -> UITextField? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        for window in windows {
            var controller = window.rootViewController
            while let next = controller?.presentedViewController { controller = next }
            if let alert = controller as? UIAlertController, let field = alert.textFields?.first {
                return field
            }
        }
        return nil
    }
}
