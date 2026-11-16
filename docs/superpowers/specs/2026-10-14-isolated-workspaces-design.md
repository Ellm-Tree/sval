# Sval — Isolated workspaces

**Status:** Built: `SvalWorkspaceJar`, `SvalNewWorkspace`.
**Date:** 2026-10-14
**Author:** John Postlethwait

---

## 1. What this is

A workspace is Sval's unit of isolation. Each workspace is **shared** or
**isolated** (main spec §10.1), and an isolated workspace gets a cookie jar of
its own. Firefox's container tabs are gone as a user-visible feature, and the
word "container" appears nowhere in Sval's UI.

A Firefox container is a named, coloured cookie jar that any number of tabs can
share. Its tabs sit mixed in with every other tab, marked only by a coloured
line, links opened from one stay in it, and a tab cannot change container. A
workspace already gathers its tabs, so it carries the jar instead.

## 2. The model

- **A workspace is shared or isolated.** Shared is the default and uses the
  profile's default jar (`userContextId` 0).
- **Every tab in an isolated workspace uses that workspace's jar,** and no
  other tab does. There is no per-tab isolation: a tab never has a jar other
  than its workspace's.
- **The jar is local** (decision 0006). The workspace's isolated flag syncs;
  each device makes its own jar the first time it needs one, because an
  identity's `userContextId` belongs to one profile. A user signs in once per
  device in each isolated workspace.
- **Private windows are unchanged.** They already have a jar of their own.

## 3. The engine

- A workspace node has `isolated: bool` in its lifecycle group, beside
  `pinned`: it is the workspace's state, and recolouring or renaming it must
  never compete with it (spec §5.1). It defaults to `false`, and a file
  written before the field existed loads as shared.
- `addWorkspace` and `addAgentWorkspace` take `isolated`.
- The op `setIsolation(id, isolated, device_id, now)` changes it. It throws
  on a node that is not a workspace.
- The host contract (`docs/host-contract.md`) documents the field and the op.

## 4. The jar (Sval)

- **One hidden identity per isolated workspace.** Sval makes it through
  `ContextualIdentityService` as a non-public identity named
  `sval.workspace.<workspaceId>`, the kind Firefox uses for its own internal
  jars (`userContextIdInternal.thumbnail`). Non-public identities appear in no
  container menu, give a tab no colour line, and show no name in the address
  bar or a tab's tooltip. `ContextualIdentityService.create` makes only public
  identities, so `workspace-identities.patch` lets it take `public: false`;
  no other API makes one. `getPrivateIdentity(name)` finds it again.
- **Opening a tab.** Every path that puts a tab in a workspace gives it the
  workspace's `userContextId` at creation: the new-tab button and Cmd+T, a
  Favorite, history, an external link from the OS, an agent's tab, a tab
  restored from the tree, and undo-close. A link opened from a tab inherits the
  tab's jar, as Firefox already does. A test opens a tab by each path in an
  isolated workspace and checks its `originAttributes`.
- **Restore.** The jar comes from the workspace, so the tree stores nothing per
  tab.
- **Deleting an isolated workspace** removes its identity and clears its data
  (`Services.clearData.deleteDataFromOriginAttributesPattern` with its
  `userContextId`). Each device does this when the workspace leaves its
  document, whoever deleted it.
- **Kagi.** `SvalKagi` reads the Kagi session cookie from the default jar only,
  so a search from an isolated workspace carries Kagi's header only after the
  user signs in to Kagi there. That is the isolation working.

## 5. Changing a workspace

- **New workspace.** `SvalNewWorkspace` has an "Isolated" checkbox, off by
  default, with one line saying what it does: sites in this workspace can't see
  your sign-ins from other workspaces.
- **Later.** The workspace's context menu has "Isolate Workspace…" or "Stop
  isolating Workspace…". Gecko cannot move a live tab between jars, so either
  change reopens every tab in the workspace at its URL, in the new jar. The
  confirm names the cost: "Every tab in this workspace reloads. You'll need to
  sign in again on sites you used here." Stopping isolation then deletes the
  old jar's data. Cookies are not copied across: site storage (IndexedDB,
  localStorage) cannot follow, and a half-moved sign-in is worse than a clean
  one.
- **Another device** reopens the workspace's tabs in the new jar when the
  flag arrives by sync, with no confirm: the user confirmed on the device that
  made the change.

## 6. Moving a tab or group between workspaces

"Move to workspace" and dragging in the panel keep working. When the source and
target workspaces have different jars (shared to isolated, isolated to shared,
or two isolated workspaces), Sval asks first:

> **Move to "Research"?**
> The page opens in "Research" fresh. You may need to sign in again.
> [Cancel] [Move]

For a group, the dialog says how many tabs move. Moving reopens each tab at its
URL in the target jar; its back/forward history does not come along. Between
workspaces with the same jar a move asks nothing and reopens nothing.

## 7. Agents

- An agent pairs through `request_isolated_pairing` or
  `request_shared_pairing` (`SvalAgentSession.sys.mjs`), one tool for each kind
  of workspace.
- The pairing alert says which the agent asked for: "It asks for a shared
  workspace, signed in where you are" or "It asks for an isolated workspace,
  signed in nowhere." An "Isolate this agent's workspace" checkbox starts at
  the agent's request, and the user's answer wins. The result tells the agent
  which it got.
- The pairing record stores the answer, so the replacement workspace
  `#house` makes after the user deletes the agent's own is created the same
  way.
- The user can change an agent's workspace later through §5, like any other.

## 8. Import

Cookies are never imported (import spec §2), so isolation carries nothing
across: the user signs in again either way. What import can carry is the
user's intent to keep accounts apart.

- **Chromium profiles and Arc profiles are separate cookie jars.** When one
  import takes workspaces from two or more profiles of the same browser, the
  workspaces from every profile but that browser's default (`Default` in
  `Local State`) are created isolated. A single profile imports shared,
  whichever it is. The import picker shows an "Isolated" checkbox on each
  profile's row, set by that rule, and the user's answer wins.
- **Firefox's containers are not imported.** A container tab lands in its
  window's workspace like any other tab. A container spans windows, so turning
  each into an isolated workspace would pull tabs out of the windows the user
  arranged them in.
- **Safari** imports as one profile (import spec §4.3), so it imports shared.

## 9. Removing Firefox's containers

Sval sets and locks these in `branding/sval/pref/app-sval-firefox-ui.js`. Locked prefs
still show in about:config, marked locked:

| Pref | Value | What it removes |
|---|---|---|
| `privacy.userContext.enabled` | `false` | Tab context "Open in New Container Tab", link context "Open Link in New Container Tab", File → New Container Tab, the new-tab button's container menu, the all-tabs menu's "New container tab", "Open in Container Tab" in the address bar, history, sidebar, bookmarks and synced tabs, and the `contextualIdentities` extensions API |
| `privacy.userContext.ui.enabled` | `false` | Settings → Tabs "Enable Container Tabs" and its Containers pane |
| `privacy.userContext.newTabContainerOnLeftClick.enabled` | `false` | The new-tab button asking for a container |
| `privacy.userContext.extension` | `""` | An add-on claiming the containers setting |

An add-on with the `contextualIdentities` permission sets
`privacy.userContext.enabled` to `true` at startup
(`ext-contextualIdentities.js`, `onStartup`). The lock must win; a test
installs such an add-on and checks the pref and the menus stay off.

`privacy.userContext.*` stay unsynced, because Sval locks them.

Left alone on purpose:

- Firefox's `Containers` enterprise policy. A policy is an administrator's
  choice.
- Strings in Mozilla's `.ftl` files. Unreachable strings cost nothing, and
  patching them out costs every rebase.
- `siteProtections.ftl`'s `-container` strings and Safari import's
  `~/Library/Containers` path, which are other meanings of the word.

A browser test walks every surface in the table and fails on any visible item
that names a container.

## 10. The indicator

An isolated workspace carries a persistent mark beside its name: on its
switcher entry, on the workspace header while it is active, and in Settings.
The mark is drawn in ink, never the workspace's colour, because no colour reads
on every tint and an uncoloured workspace has none. `sval-iso-pill.css` and
`workspace-isolated.svg` own its look.

## 11. Out of scope

- Isolating a single tab.
- More than one jar per workspace, or two workspaces sharing one isolated jar.
- Moving a tab's history or site storage between jars.
