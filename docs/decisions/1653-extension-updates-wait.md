# 1653. Extension updates wait before they install

**Status:** Accepted on 2026-10-31. Specified in
2026-10-31-extension-controls-design.md.

## Context

An extension can behave for months, gather users, and then turn harmful
through an automatic update. Such an update asks for no new permission, so no
prompt fires. Urban VPN Proxy 5.5.0 began copying its users' AI chats, and a
Trust Wallet update drained its users' wallets within 48 hours. Mozilla's
blocklist (`addons-bloomfilters`) turns such an extension off once it is
reported, but an update that installs the day it ships reaches users first.

The update manifest carries no publish date (`AddonUpdateChecker.sys.mjs`
reads version, link, hash, info URL and `applications.gecko`).

## Decision

- A background update check holds an extension update for a number of days,
  counted from when the device first saw that version
  (`SvalUpdateDelay.sys.mjs`, `extension-update-wait.patch`). A newer version
  starts its own wait.
- The default is 7 days. The user sets the number in Settings › Extensions,
  and 0 installs updates as soon as they are found.
- The setting syncs like other settings: the latest change wins.
- Only add-ons of type `extension` wait. A language pack must match the app's
  version, and dictionaries update as Firefox updates them.
- Nothing the user starts waits: a first install, an extension page's Update
  now, and about:addons' Check for Updates.
- The blocklist acts as it does in Firefox, without a wait.

## Consequences

The wait depends on `AddonManagerInternal.backgroundUpdateCheck` installing a
found update from its `onUpdateAvailable` listener; a rebase that moves that
decision fails the patch. Updates that fix a security hole wait too, because
nothing marks them; Update now installs one at once.
