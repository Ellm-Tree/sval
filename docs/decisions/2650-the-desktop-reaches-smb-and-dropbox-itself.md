# 2650. The desktop reaches an SMB or Dropbox folder itself

**Status:** Accepted on 2026-11-25.
Specified in `docs/superpowers/specs/2026-11-25-desktop-connectors-design.md`.

## Context

The desktop syncs through a folder the operating system shows it (spec
§6.4). A folder on an SMB share has to be mounted before Sval can choose it,
and stays reachable only while the mount does. A folder in Dropbox needs
Dropbox's desktop client running. Some users can't or won't do either: a
Linux machine without a mount set up, a work Mac that forbids mounting, a
user who keeps Dropbox's client off.

The iPhone app reaches both itself, through `smb2` and `dropbox-sdk`
(mobile spec §8.1). Every shared-folder read and write on the desktop is
already a request to `sval-folder`, a native Rust program (decision 1437).

## Decision

- **`sval-folder` reaches a folder on an SMB share or in Dropbox itself**,
  beside the local folder it reaches through the file system: SMB with
  `smb2`, as the iPhone app does, and Dropbox's HTTP API through `ureq`.
  Every operation keeps the local folder's limits and refusals, so the
  browser and the engine can't tell the three apart.
- **A remote folder is a root of its own form**: `smb://user@host/share/folder`
  or `dropbox:/folder`. The root is what the settings keep, as they keep a
  local folder's path.
- **The password or token is kept with the sync key** (`SvalSecretStore`) and
  travels with each request to the helper, which writes it nowhere.
- **No iCloud connector.** Apple has no iCloud Drive API outside its own
  platforms, and the private web API others reverse-engineer breaks when
  Apple changes it. iCloud for Windows gives a folder on disk, which Sval
  already syncs through.
- **The helper calls Dropbox's API itself.** `dropbox-sdk` depends on `ring`
  whatever its features, and `ring` compiles C, which the Windows build of
  the helper has no compiler for. On Windows the calls go over SChannel; on
  macOS and Linux over rustls with `ring`.
- **The helper and the iPhone connectors share no code.** The phone's are
  UniFFI objects with the phone's own semantics, and the helper's operations
  refuse links, cap sizes and never replace on a move. A shared crate would
  change the phone's bindings for code the two use differently.

## Consequences

- An SMB share or a Dropbox folder works with no mount and no Dropbox client.
- A remote folder's listing reads each file over the network. The helper keeps
  what it read for the browser run and reads a file again only once its
  version changes.
- Sval contacts Dropbox's API hosts when the user chooses a Dropbox folder,
  and the SMB server the user names.
