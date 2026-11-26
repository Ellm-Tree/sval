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
other categories are ([0082](0082-sval-settings-are-categories-of-about-preferences.md)),
and it is where extensions are managed. It lists each extension about:addons'
list shows, with an on/off switch. An extension's page, in the site page's
form, turns it on or off, sets whether it runs in private windows and updates
itself, checks for a newer version, lists its permissions in Mozilla's words
with a switch for each optional one, shows its own options page in a card,
edits its shortcuts and removes it after a confirmation. Each change goes
through the add-on manager, `ExtensionPermissions` and `ExtensionShortcuts` as
about:addons makes it, and a new shortcut is checked against every
extension's as Firefox's editor checks it. Every way Firefox opens about:addons
at an extension or its list (`BrowserAddonUI.openAddonsMgr`) opens the
matching place in Settings, so an extension that opens its options lands on
its page. The category's foot installs from a file and links to
addons.mozilla.org. Extensions' shortcuts are listed in Keyboard shortcuts,
each extension's with a way to its page. Firefox's footer link is hidden.
Abuse reports are left out, as Sval turns them off.

## Consequences

Sval's Extensions category depends on the add-on manager's wrapper
(`permissions`, `userDisabled`, `optionsURL`, `optionsType`,
`applyBackgroundUpdates`, `uninstall`), `ExtensionPermissions`,
`ExtensionShortcuts`, `Extension.formatPermissionStrings` and
`inline-options-browser` keeping their shapes; a rebase that changes them
breaks the category, and its browser test fails on it. An options page is a
remote browser inside Settings, which Gecko allows only for the addresses
`nsFrameLoader` lists, so about:preferences is on that list. How long updates
wait, and installing a waiting one, are in the category
([1653](1653-extension-updates-wait.md)). A typed about:addons still opens
Firefox's page, for dictionaries, with a way back to Settings.
