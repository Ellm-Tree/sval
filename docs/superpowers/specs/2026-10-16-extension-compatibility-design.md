# Sval — Extensions that Sval's changes break

**Status:** Built.
**Date:** 2026-10-16
**Author:** John Postlethwait

---

## 1. What this is

Sval keeps Firefox's front end so WebExtensions keep working (main spec §2).
It also replaces parts of that front end. Most extensions do not notice. Some
lose the thing they exist to do:

| Sval change | Effect on the extensions API |
|---|---|
| No themes (decision 0093) | A theme cannot change Sval's colours. |
| No containers (isolated workspaces §9) | `contextualIdentities` is gone. `cookieStoreId` shows Sval's private workspace jars. |
| Sval owns the tabs (decisions 0049–0051) | `browser.tabs` works, but switching workspace closes the outgoing tabs and they come back with new ids. Tabs of inactive workspaces are not Firefox tabs, so queries never see them. |
| Sval's tab panel | Draws its own rows, so it must honour `tabs.hide` itself (§5). |
| History sidebar restyle | Hides the sidebar switcher, the usual way into an extension's `sidebar_action` panel (§6). |

## 2. Rule

Sval decides from what an extension asks for, never from a list of extension
ids. Sval keeps no list of known extensions.

1. **Refused.** Themes, and any extension whose manifest asks for the
   `contextualIdentities` permission. The API it needs does not exist in Sval,
   so it cannot work.
2. **Installed, with a warning.** Any extension whose manifest asks for the
   `tabHide` permission. Such extensions manage tabs as groups or sets, and
   Sval's workspaces change what they see.
3. **Installed, silently.** Everything else.

Tab-strip replacements that ask for neither permission (Tree Style Tab,
Sidebery) fall in tier 3. They work, alongside Sval's panel.

`SvalExtensionCompat.sys.mjs` implements these rules.

## 3. Refused

The add-on manager's install listener cancels the install: in
`onDownloadEnded`, before Firefox's install prompt, for a download, and in
`onInstallStarted` for an install from a file. A doorhanger on the extensions
button says why (messages spec §6). An update check for an extension the user
already turned off is cancelled without one.

No `ExtensionSettings` policy, for the reason in decision 0093.

**Already installed.** A profile imported from Firefox can bring such an
extension with it. At startup Sval disables every installed extension asking
for `contextualIdentities`, and shows a notice for each with a Remove button.
It does not uninstall them, so the user's data in the extension stays. The
pref lock from isolated workspaces §9 stays as a second guard.

## 4. Warned

The install completes as usual, including Firefox's permission prompt. Then
Sval opens the extensions panel on a notice (messages spec §6) saying the
extension sees only the current workspace's tabs, with **Remove** and
**Keep** buttons. Remove uninstalls it. The answer is recorded per extension
id. An unanswered warning shows again at the next start.

## 5. Hidden tabs

`browser.tabs.hide()` hides a tab without closing it; it keeps running.
Firefox's tab strip drops it, and so does Sval's panel.

- A tab with `hidden` set does not render in the panel. Its tree node stays.
- `TabHide` and `TabShow` re-render the affected row.
- A hidden tab is not offered by tab switching, search over open tabs, or
  "next tab" navigation in the panel, matching Firefox's strip.
- Selecting a tab shows it, as in Firefox (`gBrowser` unhides a tab on
  selection).
- Firefox shows every tab an extension hid when that extension is disabled or
  removed. Sval relies on that and adds nothing.

## 6. Extension sidebars

Firefox's sidebar shows one panel at a time; a dropdown in its header (the
switcher) moves between them. Sval hides that switcher
(`SvalHistorySidebar.sys.mjs`), which leaves an extension's sidebar reachable
only through its own toolbar button, its own shortcut, or View → Sidebar
(hidden until Alt on Windows and Linux).

The switcher shows while at least one installed, enabled extension declares a
`sidebar_action`. It lists:

- History, so the user can get back to Sval's history sidebar;
- every extension sidebar.

Bookmarks stays out (Favorites replaces it, decision 0099) and so does Synced
Tabs. The switcher hides again when the last such extension is disabled or
removed.

## 7. Tests

- A theme install and a `contextualIdentities` install are both cancelled, and
  each shows its doorhanger.
- An installed `contextualIdentities` extension is disabled at startup, and
  `privacy.userContext.enabled` stays false.
- A `tabHide` install completes and shows the warning once. Remove uninstalls.
- An ordinary extension installs with no notice.
- `tabs.hide` removes the row from the panel; `tabs.show` and disabling the
  extension bring it back; selecting the hidden tab shows it.
- With a `sidebar_action` extension enabled the switcher shows History and the
  extension's panel, with no Bookmarks or Synced Tabs; disabling it hides the
  switcher.

## 8. Not in scope

- Theme accent colours.
- Reordering extension buttons in the fixed toolbar.
- `sessions.getRecentlyClosed`, which Sval degrades by keeping no closed-tab
  history (decision 0013).
