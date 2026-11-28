# 2713. An opened text field starts with the field's text selected

**Status:** Accepted on 2026-11-27.

## Context

Many actions open a text field with text already in it: Rename, a dialog
that asks for a name, a setup form with a value filled in. When the field
opens without focus, or with the caret at the end, the user has to click
into it and clear the old text before typing.

The iPhone app focuses every such field with its text selected
(`selectsAllWhenEditing` in `Theme.swift` and `FocusesAlertField` in
`TextPrompt.swift`).

## Decision

- **Every action that opens a text field focuses the field with the
  field's text selected**, on the desktop as on the iPhone. Typing replaces
  the old text, and pressing an arrow key keeps the old text.
- **`sval-field`'s `focus()` selects the field's text.** Code calls
  `focus()` when a dialog or an action opens a field, so a dialog's first
  field and a field an action reveals both open with the text selected.
- **A click into a field keeps the caret where the click put it.** Tabbing
  into a field selects the text as the platform's text fields do.

## Consequences

- A new action that opens a text field gets the selection by focusing a
  `sval-field`, from a dialog or with `focus()`.
