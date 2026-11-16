# 0078. The user's password manager owns every credential

**Status:** Accepted on 2026-10-08.

## Context

Merging candidates from several managers into one list, with Firefox's own
login store as the fallback, fails for two reasons. No desktop operating
system lets a browser read or write a password manager's website logins, so
there is nothing to merge. And the conflicts users complain about in other
browsers come from the browser's own manager running beside theirs.

Every user is treated alike, whatever manager and platform they use, so Sval
provides no store.

## Decision

- Sval keeps no credentials. Firefox's password manager and its address and
  card autofill are off completely.
- First run asks which manager the user has and installs its extension. "I
  don't use one" is accepted, and Sval then remembers no passwords.
- Passkeys go through the operating system or the user's manager. Firefox
  lists none in a sign-in field's dropdown: that list is drawn by its login
  manager, and beside the manager's own it would be a second list on one
  field.
- Native messaging stays at Mozilla's paths, so every manager's installer
  already works with Sval.
- Grants that admit Sval by signing identity are requested from Apple, from
  1Password and, for mobile, from the Android providers (spec §7.4).

## Consequences

- An Apple Passwords user on a Mac copies from the Passwords app until a macOS
  release carries Sval in the iCloud helper's launch constraint. A dev build
  never connects.
- A Windows user with no manager gets no saved passwords. First run says so.
- Google's and Microsoft's managers have no Firefox-family extension. Their
  users move through import's CSV hand-off.
- HTTP authentication dialogs stay manual.
- Sval keeps none of its own secrets in Firefox's login store either. Its keys
  and the Kagi token live in the system store
  ([0083](0083-svals-keys-live-in-the-system-store-and-only-a-syncing-device-holds-a-sync-key.md)).
