# 0087. Names come from the user's data, and a suggestion is shown before it is written

**Status:** Accepted on 2026-10-08.

## Context

A prefilled name field and a reflexive OK would put "New workspace" in
English on every device, whatever the user's language. Refusing every name Sval
chooses is too broad, though: a Chrome window has no name, and every imported
window would become an unnamed workspace, a panel full of rows the user
cannot tell apart (`2026-10-08-import-design.md`).

## Decision

1. A name the source already has is imported as it is: an Arc Space's name, a
   tab group's title, a bookmark folder's name. These are the user's own words.
2. Where there is none, Sval may suggest one in the user's language, such as
   "Chrome Window 1", in an editable field.
3. Nothing Sval suggests is written until the user has seen it in that field
   and continued past it. The user can keep it, change it or clear it.

The first-launch workspace stays unnamed, and the new-workspace dialog keeps
its empty field: neither has a moment where a suggestion is shown first.

## Consequences

A suggestion the user accepted syncs in the language it was shown in, as any
name the user typed does. Localisation never migrates synced data,
because nothing reaches the document without the user having seen it.
