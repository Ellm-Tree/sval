# 0133. Safe Browsing and extension updates sync one way

**Status:** Accepted on 2026-10-18.

## Context

Settings sync carries Firefox Sync's pref list, which includes Safe Browsing's
switches and `extensions.update.enabled`. Any device holding the sync key can
write the settings document, so a compromised device, or malware writing one
device's prefs, could turn these protections off on every device. Firefox
Sync has the same reach, but it trusts devices that sign in to one account;
Sval's devices share a folder.

## Decision

`browser.safebrowsing.malware.enabled`, `browser.safebrowsing.phishing.enabled`,
`browser.safebrowsing.downloads.enabled`,
`browser.safebrowsing.downloads.remote.block_potentially_unwanted` and
`extensions.update.enabled` sync one way. A value from another device that
turns one on applies. A value that turns one off does not apply, and the
device keeps its own setting.

## Consequences

Turning one of these off is a choice for one device, and other devices do not
follow it. Each is on by default, so turning it back on clears the device's
value, which reaches the others as a reset to on. The rule is a value rule in
`SvalSettingsRegistry.VALUE_RULES`, the mechanism every synced pref's checks
use.
