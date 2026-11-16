# 0083. Sval's keys live in the system store, and only a syncing device holds a sync key

**Status:** Accepted on 2026-10-08.

## Context

Firefox's login store protects nothing once the Primary Password is off,
which decision 0078 makes the norm, and "Remove all logins", about:logins and
an extension's `browsingData.removePasswords` delete what it holds. One key
for both this device's copy and the shared folder would let a locked or
missing key stop the whole panel. A key minted at startup would let holding a
key decide whether a device has workspaces. The key-storage spec
(`docs/superpowers/specs/2026-10-08-key-storage-design.md`) has the design.

## Decision

- **Two keys.** A local key, a plain file in the profile, encrypts this
  device's own copy. It protects nothing and can never be locked. A sync key
  encrypts the shared folder and names its directory.
- **Only a device set up to share holds a sync key.** It is made when the user
  sets up sharing as new, or received through pairing. Sval never mints one to
  replace a key that is missing.
- **The sync key lives in the system store.** `nsIOSKeyStore` cannot hold bytes
  Sval chose, so `SvalSecretStore` keeps them in the profile, encrypted under a
  system-store secret with one label per user of the machine, shared by all
  the user's profiles and never removed, so a reinstall can open the sealed key
  copy in the folder. A Linux machine with no keyring
  keeps them in the profile instead, and records that choice.
- **A sync key that cannot be used stops only syncing.** The panel starts with
  this device's workspaces, and its sync indicator says syncing is off and
  offers to ask the store again or to reconnect.
- **The Kagi session token lives in the same store.** Sval keeps nothing in
  Firefox's login store.
- **Pairing re-keys only the shared folder.** The profile is not written while
  a received key is a candidate, so an abandoned pairing leaves the local copy
  as it was.

## Consequences

- Tests run against an in-memory system store, so no test run leaves secrets
  in a developer's keychain. Nothing in CI exercises the real Keychain,
  Credential Manager or Secret Service.
- A macOS dev build signed differently from the build that stored the key gets
  the system's access prompt.
- A Windows password reset or a new computer loses the system secret, and the
  device asks to pair again.

