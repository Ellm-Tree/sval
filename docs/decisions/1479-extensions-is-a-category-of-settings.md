# 1479. Extensions is a category of Settings

**Status:** Accepted on 2026-10-27.

## Context

Firefox's Settings reach extensions through a footer link, which leaves
Settings for about:addons. Sval installs no themes (`SvalThemes`) and has no
plugins, so about:addons lists extensions alone. Settings installs one
extension (the password manager card), Firefox keeps extensions' shortcuts
apart from the Keyboard shortcuts category, and the Agents category manages
installed things with permissions.

## Decision

Extensions is a category of Sval's Settings, before Agents, added as Sval's
other categories are ([0082](0082-sval-settings-are-categories-of-about-preferences.md)).
It lists each extension about:addons' list shows, with an on/off switch. An
extension's page, in the site page's form, turns it on or off, sets whether it
runs in private windows, lists its permissions in Mozilla's words with a switch
for each optional one, opens its options in a tab, and removes it after a
confirmation. Each change goes through the add-on manager and
`ExtensionPermissions` as about:addons makes it. The category's foot installs
from a file and opens about:addons, so nothing about:addons does is lost.
Extensions' shortcuts are listed in Keyboard shortcuts, read-only, with a way
to the extensions page, where Firefox's editor checks a new key against every
extension's. Firefox's footer link is hidden.

## Consequences

Sval's Extensions category depends on the add-on manager's wrapper
(`permissions`, `userDisabled`, `optionsURL`, `uninstall`),
`ExtensionPermissions` and `Extension.formatPermissionStrings` keeping their
shapes; a rebase that changes them breaks the category, and its browser test
fails on it. How long updates wait, and installing a waiting one, are in the
category ([1653](1653-extension-updates-wait.md)). Checking for updates by
hand, abuse reports and changing an extension's shortcut stay in about:addons.
