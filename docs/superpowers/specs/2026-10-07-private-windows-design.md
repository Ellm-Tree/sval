# Private windows use Sval's sidebar and save nothing

Date: 2026-10-07. Status: built.

A private window shows Sval's sidebar with one temporary workspace holding
just that window's tabs, and nothing about those tabs is written anywhere:
the disk, the shared folder, the synced document and session state. It is
safe because its tree cannot write, and the guarantee is proved by tests that
inspect what is on disk (decision 0074).

## Behaviour

**In a private window:**

- Sval's sidebar replaces the tab strip, exactly as in a normal window: the same
  rows, the same tree, drag, keyboard and context menu.
- A notice sits at the top of the sidebar and cannot be dismissed. It reads:
  "Private window. Tabs here aren't saved or synced, and they're gone when you
  close this window."
- The window has one workspace. It has no name in the switcher, because there
  is no switcher.

**What works:**

- Tabs, groups and nesting.
- Drag and move.
- Rename.
- Colour and emoji on groups.
- Collapse and expand.
- Selection.
- Closing tabs, and Firefox's own reopen-closed-tab, which becomes a new row.

**What is absent in a private window:**

- The workspace switcher and "New workspace".
- Opening a workspace in a new window.
- Moving a tab to another workspace.
- Sync status and pairing messages.
- The agent band.

These are filtered from the context menu and the keyboard commands, never just
disabled.

**More than one private window:** each private window is a session of its
own, with its own temporary workspace. No private window can see another's
cookies, storage, cache, HSTS, permissions, site choices, zoom, downloads or
any other site state. A popup a page opens, such as a sign-in window, shares
the session of the page that opened it, so sign-in flows keep working.

**Tabs never leave a private window.** A tab cannot be dragged to another
window, and "Move to New Window" is not offered for a tab in a private
window. No tab can be moved into a private window from elsewhere either. A
user who wants a page elsewhere copies its address. Firefox already refuses
moves between a private and a normal window (`getDropEffectForTabDrag` and
`swapBrowsersAndCloseOther` in tabbrowser); Sval refuses moves between two
private windows the same way.

**Nothing about any site is saved from a private window.** A choice made
there (site controls, protections, media, permissions, zoom) applies in
memory to that window alone, is never written to disk or to the profile's
stores, and is dropped when the window closes. Favicons of pages seen there
are not stored either.

**Downloads:** each private window's Downloads panel lists only the
downloads started in it. The files stay on disk, as in Firefox.

**When things end:**

- Closing a private window drops its workspace and everything in it, and
  clears its session's data, once no popup it opened is still open.
- When the last private window closes, the in-memory document is freed, and
  what Gecko keeps in memory for every private session (image and font
  caches, TLS session tickets) is freed.

**"Always use private browsing mode"** (`browser.privatebrowsing.autostart`):

- Every window is private, so every window behaves as above: each window
  is a session of its own.
- Sval's engine, sync, the shared-folder helper, agents and settings sync never
  start.
- Sval creates no identity, no key and no local copy. If this is a first launch,
  the profile ends the session with no Sval files at all.
- Settings opened in this mode shows its sync and pairing sections as
  unavailable, with one line explaining why.

**Normal windows open alongside private ones** behave as they do with no
private window open. Nothing a private window does can reach their tree.

**The private home page belongs to private windows.** `about:privatebrowsing`
shows Sval's home page in the private palette, which says the window is
private. Typed into a normal window, it opens in a new private window
instead. The tab it was typed into goes back to the page it showed, or closes
if it showed none; if that tab is the window's last, a new tab on the normal
home page takes its place, so the window stays open. The decision is made in
the parent process from the browser's own privacy, never from the page.
Typed into a private window, it stays where it was typed.

## Architecture

### `SvalPrivateSession.sys.mjs`

This module holds every private window's state for the life of the private
browsing session, in a `SvalMemorySession`. The windows a WebDriver client
opens (`SvalWebDriver`) use a second instance of the same class. It holds
three things:

- **The tree:** a `SvalDocument` from `sval_core.mjs`, the same WASM document the
  sync worker uses, held in memory in a worker of its own,
  `SvalPrivate.worker.mjs`.
  - A worker because the parent process's system CSP refuses to compile WASM
    on the main thread (`WebAssembly.instantiate() blocked by CSP`).
  - A worker of its own, so the code holding private tabs imports only the
    engine module, `SvalDocumentOps.mjs` and `SvalWorkerHost.mjs`, and has no
    file, network or sync code in reach. It accepts only the operations a
    private window makes, and refuses an agent's workspace, a setting and any
    other document.
  - It gives private windows the engine's exact ordering, repair and move
    semantics with no second implementation.
  - The WASM module's only host imports are randomness, `console.error` and
    string helpers (checked in the generated glue), so the document itself
    cannot reach a file or a socket.
- **Settings:** an in-memory object with `SvalLocalSettings`' interface, whose
  `flush` does nothing. Placement is read once from the profile's settings
  without writing.
- **Tab to node ids:** a `WeakMap` keyed by the tab's `permanentKey`, which
  tabbrowser carries with the browser. SessionStore's `sval-node-id` custom
  value is never set on a private tab.

It exposes the subset of `SvalEngine`'s surface that the panel and `SvalTabs`
use (`tree()`, `mutate(op)`, and a `publishPending()` and
`finishBeforeShutdown()` that do nothing), with `isPrivate: true`. It has no
`sync`, `setSharedRoot`, `setKey` or shared-folder listener methods. A caller
that reaches for them fails loudly instead of doing something quietly.

Two more methods manage workspaces:

- `forWindow(win)` creates the window's workspace on first call.
- `releaseWindow(win)` removes the window's workspace and all its descendants.
  When no private window remains, it frees the document. It also listens for
  `last-pb-context-exited` as a backstop.

**What the private code may import and name** is enforced by
`test_sval_private.js`, which reads the source. Each private module has an
allowlist of imports, and none may name a file, socket, SessionStore,
xulStore, prefs, logins, or Sval's saved-state modules (`SvalEngine`,
`SvalLocalSettings`, `SvalSharedFolder`, `SvalIdentity`, `SvalRestore`,
`SvalAgents`, `SvalSettingsSync`, `SvalLog`).

**Applying operations.** `SvalDocumentOps.mjs` is the pure op-to-document
switch. The sync worker and the private worker both call it, so an op behaves
identically in both, and a new op cannot exist in one and not the other.

### The panel (`sval-panel.js`)

`init` keeps one branch on whether the window is private. A private window
starts on the private session in place of the profile's engine, which does
the following:

- Hides the tab strip for this window only, through the existing non-persisting
  path, so xulStore is never written from a private window.
- Builds the sidebar, applies placement and draws the notice.
- Binds `this._engine` to the private session, and `this._settings` to the
  session's settings.
- Calls `SvalTabs.attach` with the session and `syncDocument: null`.
- Never calls these:
  - `SvalEngine`;
  - `SvalIdentity`;
  - `SvalLocalSettings.open` for writing;
  - `SvalRestore`;
  - `SvalAgents.start` or `_startSettingsSync`;
  - push registration;
  - `setCustomWindowValue`;
  - `_rememberWorkspace`;
  - first run.

If the panel fails to start, the window shows Firefox's tab strip, which is
live underneath, so the window's tabs stay visible (decision 0074).

**Rendering is shared.** `render`, `rows` and the drag and keyboard code
read only `_nodes`, `_settings` and `_currentWorkspaceId`, so the private window
draws through the same code as every other window.

**Filtered actions.** `SvalPanelModel.contextMenuItems` and `keyCommand` take an
`isPrivate` flag that removes the actions listed above. Every handler that
mutates a workspace (add workspace, open in new window, move to workspace)
checks `_engine.isPrivate` and refuses, so a stale menu cannot reach one.

### `SvalTabs.sys.mjs`

The backstop in `attach` is two-sided:

- It throws if a private window is given anything but a `SvalPrivateSession`.
- It throws if a normal window is given a `SvalPrivateSession`.

A private window's adapter reads and writes node ids through the session's
map, and never through SessionStore. A private observer has no
`syncDocument` and a no-op `onFlush`, so it schedules no sync and no poll that
reaches the engine.

### Everything that enumerates windows

`BrowserWindowTracker` returns private windows unless it is asked not to
(`BrowserWindowTracker.getTopWindow` and `orderedWindows`). Every Sval call site that looks for "a
window" passes `private: false` or skips private windows explicitly:

- `settings.js`, which picks a window's panel settings;
- `SvalAgentTabs.openElsewhere`, `windowsShowing` and `fullWindowShowing`;
- `SvalAgentDialog.askToPair`'s `getTopWindow`;
- `SvalAgentGate`'s window hooks, which act only on agent browsers, and
  agent browsers are never private.

No agent tool can list, read, act in or open a private window or tab.

### Logging

The private session logs counts only. It never logs a node id, so a private
window leaves no trace even in the console.

## What can never be written, and why

Each write site, with what stops a private window reaching it:

| Write site | Why a private window cannot reach it |
|---|---|
| Local copy (`SvalSync.worker.mjs`) | The private session has no worker and no `sync` method. |
| Shared folder (`SvalEngine.#shareOne`, the helper) | The same: there is no engine. |
| Shutdown publish (`SvalEngine` profile-before-change) | It publishes only `sharedEngine`, which private windows never touch. |
| `sval-local-settings.json` (expanded, lastActive, selection) | Private settings are an in-memory object whose `flush` does nothing. |
| SessionStore `sval-node-id`, `sval-current-workspace` | They are never called for a private window. Firefox also drops private windows from the session file (`SessionSaver._saveState`, through `PrivacyFilter.filterPrivateWindowsAndTabs`). |
| xulStore (tab-strip collapse) | The private path uses the non-persisting hide. |
| `SvalIdentity` (device id, key) | It is never called from the private path. Under permanent private browsing nothing calls it. |
| `agents.json`, `port.json` | Agents never start from a private window. |
| Settings sync prefs | Settings sync never starts from a private window. |

## Tests

The guarantee is "nothing is saved". Most of these tests therefore look at the
disk and the shared folder after a scripted private session, instead of
trusting the code path. Every private test uses marker strings, unique random
tokens in URLs, page titles, group names and emoji choices, so a leak is found
wherever it lands.

### Structural (xpcshell)

1. `SvalPrivateSession.sys.mjs` and `SvalDocumentOps.mjs` import only their
   allowlist, and mention none of the forbidden names above. This is the same
   approach `test_sval_log.js` takes: the test reads the source.
2. The private settings object has every method `SvalLocalSettings` has. A
   method added to one and not the other fails the test.
3. The private session has none of `sync`, `setSharedRoot`, `setKey` or
   `addSharedListener`.

### The private session (xpcshell)

4. Parity with the engine: the same sequence of ops on a real `SvalEngine` and on
   a private session gives identical `SvalPanelModel.rows()`. This covers adding,
   grouping, nesting, every move shape, renaming, appearance and removal.
5. `releaseWindow` removes the workspace and every descendant, and leaves other
   private windows' workspaces whole.
6. The last `releaseWindow`, and `last-pb-context-exited` without it, free the
   document. A later call starts empty.
7. The worker and the session apply each op through `SvalDocumentOps`: one test
   per op kind, run against both.

### `SvalTabs` (xpcshell)

8. `attach` throws for a private window given the profile engine.
9. `attach` throws for a normal window given a private session.
10. The private adapter never calls `setCustomTabValue` or
    `getCustomTabValue`. A spying SessionStore stub fails on any call.
11. A private observer schedules no sync, poll or publish across tab opens,
    moves, content changes and closes.

### Nothing on disk (browser-chrome)

Each of these snapshots the whole profile directory and the shared folder
before and after: every file's path, size and SHA-256. They then:

- force a SessionStore save (`SessionSaver.run()`);
- wait for the engine to go idle and publish pending;
- decompress `sessionstore.jsonlz4` and every `.jsonlz4` in
  `sessionstore-backups/`, and search every file for every marker.

12. **A full private session.** The script:
    - opens tabs to marker URLs with marker titles;
    - groups and nests them;
    - renames a group with a marker;
    - sets a colour and an emoji;
    - drags tabs and groups;
    - collapses and expands;
    - selects tabs;
    - closes tabs and reopens one with undo-close-tab;
    - closes the window.

    After it, Sval's own files and the shared folder are byte-identical to the
    snapshot. Sval's own files are `sval/`, `sval-local-settings.json`,
    `sval-identity.json`, `agents.json`, `xulstore.json` and `port.json`. No file
    anywhere in the profile or the shared folder contains a marker.
13. **The same with a normal window open and syncing throughout.** The normal
    workspace's tree is unchanged by the private session. The engine's tree
    never contains a private node id or marker: it is checked after every step,
    not only at the end.
14. **Quit with a private window open.** The browser goes through
    profile-before-change and the shutdown publish. No marker is anywhere
    afterwards.
15. **Two private windows.** Neither sees the other's cookies, storage, HSTS,
    permissions, site choices, zoom or downloads, and a tab cannot move
    between them. Closing one drops only its workspace and clears only its
    session's data. A popup shares its opener's session. Closing both leaves
    the session empty, and nothing is on disk.
16. **SessionStore's tags.** No private tab has a `sval-node-id` value and no
    private window a `sval-current-workspace` value. Firefox's own live state
    holds private windows in memory and filters them out of what it saves,
    which tests 12 and 14 check on disk.
17. **Agents.**
    - With an agent paired, `list_tabs` and every tool that takes a tab never
      see a private tab.
    - `openElsewhere` ignores private windows.
    - A pairing request never opens over a private window.
18. **Settings.** Settings opened from a private window does not bind to the
    private session. Under permanent private browsing it shows sync and pairing
    as unavailable.

### One experience (browser-chrome)

19. A private window shows Sval's sidebar and the notice. The tab strip is
    hidden, and xulStore is not written.
20. For the same tree, a private and a normal window draw the same rows, with
    the same markup.
21. The context menu and keyboard commands in a private window offer none of the
    absent actions. Their handlers refuse when called directly.

### Permanent private browsing

22. A browser-chrome directory of its own, whose manifest sets
    `browser.privatebrowsing.autostart` at startup. It checks that:
    - every window has the sidebar and the notice;
    - no `SvalEngine` is created;
    - nothing calls `SvalIdentity`;
    - after a scripted session and a quit, the profile holds no `sval/`
      directory, no `sval-identity.json`, no `sval-local-settings.json`, no Sval
      login entry, and no marker anywhere.
23. `scripts/private-browsing-test.sh` is an end-to-end run from outside the
    browser, through Marionette like the network check. It does the following:
    - starts Sval on a fresh profile with a shared folder chosen;
    - drives a private session with markers;
    - **kills the browser with SIGKILL**;
    - relaunches it once normally;
    - searches the profile and the shared folder for markers.

    It runs twice: with permanent private browsing on, and with private windows
    opened from a normal session. This is the crash case, which no in-browser
    test can cover. It runs nightly and locally.
24. The nightly network check has a permanent-private run, so a private
    session's network contact is measured too.

## Out of scope

- What Firefox itself writes during private browsing. Tests 12, 14 and 23
  search the whole profile, so a Firefox leak of a marker would still fail
  them, and would be reported upstream.
- A way to save a private window's tabs into a real workspace. Nothing in a
  private window crosses into saved state.
