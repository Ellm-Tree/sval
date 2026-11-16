# 0084. The sync key also travels in iCloud Keychain

**Status:** Accepted on 2026-10-08.

## Context

A user who installs Sval again and points first run at the same iCloud folder
must get back in without leaving first run, even with no other device to pair
with and no backup saved. A sealed copy of the sync key in the shared folder
answers the same machine (key-storage spec, "Installing again"). A new Mac, an
iPhone and a wiped system store need another way.

## Decision

- **On macOS, and the iOS app to come, the sync key also lives in iCloud
  Keychain.**
  - It is a password item with `kSecAttrSynchronizable`, in the
    data-protection keychain, under one access group that the Mac and iOS
    apps both declare: `WN6TRJ4H8P.app.sval.shared`. The group is never
    renamed, because a key stored under one group is invisible to another.
  - Sval reaches it from chrome JavaScript through js-ctypes calls into
    Security.framework (`SecItemAdd`, `SecItemCopyMatching`), which adds no
    native code and patches nothing in Mozilla's C++. Gecko's `KeychainSecret`
    stays as it is.
  - It needs the `keychain-access-groups` entitlement in a Developer ID
    provisioning profile. Apple lists Keychain Sharing as supported for
    Developer ID. Without the profile, AMFI kills the app at launch, or calls
    fail with -34018.
  - It works only in signed release builds, which set
    `browser.sval.keychainAccessGroup`. Other builds keep the per-user system
    store and the copy in `sval/keys/`.
- The copy in `sval/keys/` stays the base layer. iCloud Keychain adds new
  machines and wiped stores on top of it.

## Consequences

- It needs Sval's macOS signing: a Developer ID certificate, a provisioning
  profile carrying the access group, and the entitlement in the signed
  bundle. CI runs no build that has them, so no CI job exercises it.
- The key-storage spec's "Installing again" section describes the layers.
