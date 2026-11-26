# Fixes to offer Mozilla

Every defect Sval has found in Mozilla's code, and what Sval did about it, so it
can be contributed back. A fix lives in `patches/`; this file says whether
Mozilla knows about the defect, what evidence Sval has, and what is left to do
upstream. Nothing here has been submitted yet unless its status says so.

Add an entry when a change fixes, works around or diagnoses a defect in
Mozilla's code, whether or not Mozilla already has a bug for it. A
sval-specific behaviour change is not a defect and does not belong here. Remove
an entry when Mozilla's fix reaches the pinned ESR and Sval drops its patch.

Each entry gives:

- **Patch**: the file in `patches/`, or "none" for a diagnosis without a fix.
- **Mozilla bug**: the Bugzilla bug and any Phabricator revision, or "none
  filed".
- **Defect**: what is wrong in Mozilla's code, in a sentence or two.
- **Evidence**: what Sval observed, and the test that fails without the fix.
- **Upstream**: what contributing it would take, and its status.

## Sval's own fixes

### A search engine's icon missing once stays missing for the session

- **Patch**: `patches/search-icon-retry.patch`
- **Mozilla bug**: none filed.
- **Defect**: `ConfigSearchEngine.getIconURL` keeps the promise of each
  icon lookup per size, including one whose attachment
  `ConfigSearchEngineIconHandler.createIconURL` could not find and resolved
  null. Every later call returns that null, so the address bar's search
  button (`SearchModeSwitcher.updateSearchIcon`) shows the glass for the
  rest of the session, unless the icon handler's idle update replaces it.
- **Evidence**: on a profile whose engine icon was missing at startup, the
  Launcher and the address showed the glass while the same engine's
  `getIconURL` gave its icon in a new process.
  `browser_sval_search_icon_retry.js` fails without the fix.
- **Upstream**: a small patch to `getIconURL` and a unit test in
  `toolkit/components/search/tests/xpcshell`. Not submitted.

### A Mac on AC power reads as running on battery

- **Patch**: `patches/mac-battery-on-ac-charging.patch`
- **Mozilla bug**: none filed.
- **Defect**: `MacPowerInformationService::HandleChange` sets the battery's
  `charging` from `kIOPSIsChargingKey` alone. macOS reports that key false
  on a Mac that is plugged in with a full battery, or one Optimized Battery
  Charging holds below full, so `BatteryManager.charging` reads false on AC
  power. Windows (`ACLineStatus`) and UPower (Full and PendingCharge) count
  AC power as charging. The fix also counts a power source whose
  `kIOPSPowerSourceStateKey` is `kIOPSACPowerValue`.
- **Evidence**: found reading `HandleChange`. Battery Saver
  (`SvalBatterySaver`) turns on while `charging` is false, so without the
  fix it would turn on for a plugged-in Mac with a full battery. No test
  covers it, because a test cannot change the Mac's power source.
- **Upstream**: file a bug in Core :: DOM: Device Interfaces with the patch.
  Not submitted.

### A page that gets narrower loses the reader's place

- **Patch**: `patches/scroll-anchor-on-resize.patch`
- **Mozilla bug**: none filed.
- **Defect**: `PresShell::DoReflow` posts a scroll anchor adjustment only for
  a reflow whose target is in an anchor chain (`IsInScrollAnchorChain`). A
  viewport resize reflows from the root frame, which is in no chain, so
  `ScrollAnchorContainer::ApplyAdjustments` never runs for it. Text above
  the view rewraps taller and the content the reader was on slides down,
  where Chrome keeps it in place. The fix posts the root scroller's anchor
  after a root reflow.
- **Evidence**: `browser_sval_scroll_anchor_resize.js` halves a page's
  width. Without the patch the paragraph at the top of the view moves from
  100 px to 220 px.
- **Upstream**: file a bug in Core :: Layout: Scrolling and Overflow with
  the patch and the test as a mochitest. Not submitted.

### A reused objdir keeps the files of a removed install target

- **Patch**: `patches/faster-make-purge-removed-targets.patch`, with the
  logic in `chrome/python/mozbuild/mozbuild/backend/sval_stale_installs.py`.
- **Mozilla bug**: none filed.
- **Defect**: `FasterMakeBackend` writes an install manifest per install
  target under `dist/bin`, and `config/faster/rules.mk` processes each with
  its own `.track` file, which is how `process_install_manifest` finds the
  files a manifest stopped listing. When a target leaves the build, as when
  a directory's `MOZ_SRC_FILES` go, the backend deletes its manifest and
  make never processes its `.track`, so everything it installed stays in
  `dist/bin`. `browser/installer/package-manifest.in` packages
  `@RESPATH@/moz-src/*`, so a package built from that objdir ships the
  removed modules. The fix processes each orphaned `.track` with an empty
  manifest when the backend is written.
- **Evidence**: on a Windows CI runner whose objdir outlives each job,
  `browser_sval_no_ai.js` found `moz-src:///browser/components/aiwindow/`
  and `genai/` modules after their directories were deleted. Locally, a
  directory added with `MOZ_SRC_FILES`, built, then removed and rebuilt,
  kept its file in `dist/bin/moz-src` without the patch and lost it with it.
- **Upstream**: file a bug in Firefox Build System :: General. Upstream
  would fold the module into `fastermake.py`. Not submitted.

### PageLoadEventUtils.h needs its includer to bring the string traits

- **Patch**: `patches/page-load-event-utils-include.patch`
- **Mozilla bug**: none filed.
- **Defect**: `dom/ipc/PageLoadEventUtils.h` writes and reads an `nsCString`
  through `IPC::ParamTraits` but includes only `IPCMessageUtils.h`. The
  traits for strings live in `IPCMessageUtilsSpecializations.h`, so the
  header compiles only where something included earlier brings them.
- **Evidence**: `nsImageLoadingContent.cpp` stops including `PContent.h`
  once Sval removes text recognition, and the macOS Gecko build then fails
  in `nsImageLoadingContent.cpp` on `ParamTraitsFundamental<nsTString<char>>`.
- **Upstream**: file a bug in Core :: DOM: Content Processes with the
  one-line include. Not submitted.

### A tab moved mid-load files its session state under the wrong key

- **Patch**: `patches/tab-move-keeps-session-key.patch`
- **Mozilla bug**: [1938594](https://bugzilla.mozilla.org/show_bug.cgi?id=1938594)
  (NEW, no patch).
- **Defect**: tabbrowser's `_swapBrowserDocShells` swaps the browsers'
  `permanentKey`s after the docshell swap, and
  `CanonicalBrowsingContext::MaybeSetPermanentKey` gives the moved page the
  other tab's key in between. Session store files the page's updates under a
  key no tab holds, so `SessionStore.onMoveToNewWindow` throws "Unexpected
  undefined tabState" and the moved tab loses its history, form data and
  scroll. The fix swaps the keys first and removes `onMoveToNewWindow`.
- **Evidence**: `browser_sval_tab_move_state.js` fails on every run without the patch.
- **Upstream**: attach the patch and a test to Bug 1938594. Not submitted.

### Inserting a browser beside a lazy tab throws

- **Patch**: `patches/tabbrowser-siblings-of-a-lazy-tab.patch`
- **Mozilla bug**: none filed.
- **Defect**: `_insertBrowser` in `tabbrowser.js`, when a window reaches two
  tabs, sets `hasSiblings` on `this.tabs[0]` and `this.tabs[1]`'s browsing
  contexts, and a lazy tab's browser has none, so it throws "browsingContext
  is null". A session restore that does not overwrite (`setWindowState`
  without `overwrite`, or Restore Previous Session with
  `browser.sessionstore.restore_on_demand` false) into a window holding one
  loaded and one lazy tab then rejects in `createTabsForSessionRestore`.
- **Evidence**: `browser_closed_objects_changed_notifications_windows.js`
  fails when a window Sval restores holds a lazy tab beside its first.
- **Upstream**: the patch, with a test that restores a non-overwrite state
  into a window with a lazy tab. Not submitted.

### A window opened for an address loses it when the first load is stopped

- **Patch**: `patches/window-first-page-kept-as-typed.patch`
- **Mozilla bug**: none filed.
- **Defect**: `addTab` keeps a new tab's address as its `userTypedValue`
  until the page loads, so a load stopped or cancelled before it commits
  leaves the tab with its address. A window opened with an address in its
  arguments loads it in `gBrowserInit._handleURIToLoad` through `openLinkIn`,
  which keeps nothing: the same stopped load leaves the window's tab at
  about:blank with an empty address bar and nothing for session store to
  save. The fix sets the value there as `addTab` does, and shows it with
  `gURLBar.setURI()`.
- **Evidence**: `browser_sval_peek_shown.js`
  (`a_cancelled_first_load_keeps_its_address_to_move`) fails without the
  patch.
- **Upstream**: file a bug with a browser test that opens a window for an
  address, cancels its first load at `http-on-modify-request`, and reads
  `userTypedValue`. Not submitted.

### Allowing two kinds of embed on a page blocks one again

- **Patches**: `patches/smartblock-embed-shim-state.patch` and
  `patches/smartblock-embed-observer-rescan.patch`
- **Mozilla bug**: none filed.
- **Defect**: every SmartBlock embed shim in a frame runs in one copy of the
  webcompat add-on's `lib/smartblock_embeds_helper.js`. `Shims` in
  `lib/shims.js` runs the file with `tabs.executeScript` for each shim, the
  shims share one content script sandbox, and the second run throws on the
  redeclared `const embedHelperLib`, which `lib/shims.js` swallows. The
  placeholders, the `MutationObserver` and its timeout are that copy's
  globals, so unblocking one shim disconnects the last shim's observer and
  restores every shim's embeds, while the first shim's observer, never
  disconnected, puts its placeholder back on its embed. Separately,
  `createEmbedMutationObserver` passes each added element's
  `querySelectorAll(embedSelector)` to `createShimPlaceholders` even when it
  is empty, which `createShimPlaceholders` reads as "search the whole
  document". Its search runs after awaiting the add-on's strings, so when
  the user allows both kinds of embed, the other shim's rescan finds its
  own embed just put back and blocks it again.
- **Evidence**: `browser_sval_protection_button.js`
  (`a_blocked_embeds_button_asks_before_it_loads`) failed locally with
  either patch alone, with a placeholder left after Allow, and passed with
  both. In xpcshell, running one script with a top-level `const` twice in
  one sandbox through `ChromeUtils.compileScript` throws
  `SyntaxError: redeclaration of const`.
- **Upstream**: both patches, with a test that allows an Instagram and a
  TikTok embed on one page and checks that no placeholder is left. Not
  submitted.

### macOS reports a failed default-browser change the user accepted

- **Patch**: `patches/macos-default-browser-nsworkspace.patch`
- **Mozilla bug**: none filed.
- **Defect**: `nsMacShellService::SetDefaultBrowser` uses NSWorkspace's
  `setDefaultApplicationAtURL` only from macOS 27, and below that the
  `LSSetDefault*` calls macOS 12 deprecated. On macOS 26 one of them returns an
  error for a change the user accepts, so the method throws `NS_ERROR_FAILURE`
  while the browser is made the default. The fix uses NSWorkspace from macOS
  12, where the API first exists.
- **Evidence**: seen on an install on macOS 26. No test:
  the change raises a system prompt and alters the machine's default browser.
- **Upstream**: lower the `@available` check in a bug of its own. Not
  submitted.

### nmhproxy on macOS opens whichever copy of the browser Launch Services picks

- **Patch**: `patches/nmhproxy-own-bundle.patch`, with
  `chrome/browser/app/nmhproxy/src/bundle.rs`.
- **Mozilla bug**: none filed.
- **Defect**: `launch_firefox` in `browser/app/nmhproxy/src/commands.rs` runs
  `open -b MOZ_MACBUNDLE_ID`, so with two copies of one channel installed, or a
  local build beside an installed one, the Firefox Bridge extension can open a
  copy other than the one whose proxy it reached. The fix opens the bundle
  that holds nmhproxy, by path.
- **Evidence**: found auditing which helpers name the
  compiled-in bundle id. Unit tests in `bundle.rs`; nothing exercises the
  launch, which needs a Chromium browser with the bridge extension.
- **Upstream**: send `bundle.rs`'s lookup as a change to `commands.rs`. Not
  submitted.

### ContentSearch answers a page that has closed

- **Patch**: `patches/content-search-reply-to-live-pages.patch`
- **Mozilla bug**: none filed.
- **Defect**: `ContentSearch._onMessageGetEngine` awaits the search state and
  then reads `actor.browsingContext`. A page closed during that await has a
  destroyed actor, whose `browsingContext` throws InvalidStateError, logged
  by `_processEventQueue`. `_reply` also sends to destroyed actors. The fix
  checks the actor is still in `gContentSearchActors`, which `didDestroy`
  leaves. On the child side, a page navigated to another process keeps its
  `ContentSearchChild` until the old process tears the page down; a reply
  arriving meanwhile finds `contentWindow` null, and `_fireEvent` passes it
  to `Cu.cloneInto`, which throws NS_ERROR_FAILURE. The fix returns when
  there is no window.
- **Evidence**: `a_home_page_closed_while_answered_logs_nothing` and
  `a_home_page_left_while_answered_logs_nothing` in `browser_sval_home_page.js`
  fail without the patch.
- **Upstream**: one bug, with the patch as it is. Not submitted.

### The query stripping list service misses a pref change during its init

- **Patch**: `patches/qps-observe-prefs-before-reading.patch`
- **Mozilla bug**: none filed.
- **Defect**: `URLQueryStrippingListService.#init` reads
  `privacy.query_stripping.strip_list` and `allow_list`, then awaits
  `_notifyStripOnShareObservers`, which awaits the strip-on-share list, and
  only then adds its pref observers. A change in that gap is never seen, so
  loads keep the old strip list until the pref changes again. The fix adds
  the observers before the reads.
- **Evidence**: `the_levels_lists_add_their_parameters` in
  `browser_sval_blocking_query_stripping.js` failed on a load that kept a
  downloaded list's parameter.
### PageThumbUtils logs an error for a page that has gone

- **Patch**: `patches/page-thumbs-closed-page-quiet.patch`
- **Mozilla bug**: none filed.
- **Defect**: `PageThumbUtils.getContentSize` and `determineCropSize` catch
  `getScrollbarSize` throwing for a window with no pres shell and go on
  without scrollbars, but also log a console error. A tab closed before a
  capture's `Browser:Thumbnail:ContentInfo` query reaches its page has no
  pres shell, so `PageThumbs.captureTabPreviewThumbnail` of a tab the user
  closes as it loads logs an error for an expected case. The fix keeps the
  fallback and drops the log.
- **Evidence**: `browser_sval_workspace_windows_taking.js` failed on the
  logged error when its teardown closed a tab the tab switcher was drawing.
- **Upstream**: one bug, with the patch as it is. Not submitted.

### A popup that closes unseen turns tab hover previews off for good

- **Patch**: `patches/tab-hover-preview-stale-popups.patch`
- **Mozilla bug**: none filed.
- **Defect**: `TabHoverPanelSet` (`tab-hover-preview.mjs`) counts every panel
  and menupopup as open from its `popupshowing` to its `popuphiding`, seeds
  the count with panels marked `panelopen` or `animating`, and shows no
  preview while any is counted (`shouldActivate`). A popup can close with no
  `popuphiding`: its `popupshowing` was cancelled, as `contentAreaContextMenu`
  cancels its own when it has nothing to show (`nsContextMenu.shouldDisplay`);
  it was removed from the document while open; or it was seeded closed but
  still marked `animating`, which `panel.js` clears only on `popupshown`, as
  a confirmation hint hidden while it opens is. Any one keeps the window
  from showing a tab preview again.
- **Evidence**: `browser_sval_tab_hover_preview.js` failed in every task when
  a file earlier in the same run had left one of these behind, on Linux,
  macOS and Windows. Its `a_menu_that_never_showed_leaves_previews_on`,
  `a_menu_removed_while_open_leaves_previews_on` and
  `a_hint_cut_short_leaves_previews_on` each fail without the patch.
- **Upstream**: the same count serves Firefox's tab strip. Dropping a counted
  popup that is closed or out of the document before the check, with tests
  like Sval's, would go to Bugzilla under Firefox :: Tabbed Browser.

### Screenshots' buttons lose the keyboard

- **Patch**: `patches/screenshots-keyboard-focus.patch`
- **Mozilla bug**: none filed.
- **Defect**: Left or Right on Screenshots' Save visible and Save full page
  buttons goes to `ScreenshotsUtils.handleArrowKeyDown`, which moves the
  crosshair and takes focus off the buttons, so no key moves between them.
  With nothing in the overlay focused, Tab does nothing: the overlay
  prevents every key's default (`ScreenshotsComponentChild.handleEvent`),
  and `ScreenshotsOverlay.maybeLockFocus` moves focus on from the face and
  Cancel alone. The fix moves between the buttons on Left and Right, and
  focuses the overlay's face on Tab, or Cancel on Shift+Tab, from anywhere
  else in the overlay.
- **Evidence**: both tasks in `browser_sval_screenshots_keyboard.js` fail
  without the patch.
- **Upstream**: one bug under Firefox :: Screenshots, with the patch as it
  is and a test like Sval's.

### Picture-in-Picture reads the browser of a tab that has closed

- **Patch**: `patches/pip-tab-hidden-after-close.patch`
- **Mozilla bug**: none filed.
- **Defect**: with
  `media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled`
  on, `PictureInPictureToggleChild.onVisibilityChange` sends
  `PictureInPicture:VideoTabHidden` when a page with a tracked video goes
  hidden. A page made hidden as its tab closes sends it after the tab's
  browser has gone, and `PictureInPictureToggleParent.receiveMessage` reads
  `documentGlobal` of the null `embedderElement` and throws a TypeError. The
  fix ignores the message when there is no browser.
- **Evidence**: the tasks in `browser_sval_agent_overlay_devices.js` that
  play a video log the TypeError as each task removes the agent's
  Workspace, and the file's console check fails without the patch.
- **Upstream**: one bug, with the patch as it is. Not submitted.

### CrashManager logs a crash folder that is not there

- **Patch**: `patches/crash-manager-missing-folder-allowed.patch`
- **Mozilla bug**: none filed.
- **Defect**: `CrashManager._getDirectoryEntries` comments that a missing
  folder is allowed, then logs its NotFoundError. A profile that has never
  crashed has no `pending` or `submitted` folder, so each read logs an error.
  The fix logs every other error.
- **Evidence**: `test_sval_crash_folders.js` fails without the
  patch.
- **Upstream**: one bug, with the patch as it is. Not submitted.

### The distribution add-ons scan warns on every update

- **Patch**: `patches/addons-distribution-scan-is-debug.patch`
- **Mozilla bug**: none filed.
- **Defect**: `XPIProvider.installDistributionAddons` runs whenever the
  application changes and logs "Checking … for addons" at warn level for each
  folder, though finding nothing there is the ordinary case. The fix logs it
  at debug; what the scan finds still warns.
- **Evidence**: seen in the Browser Console after an update.
- **Upstream**: a one-line bug. Not submitted.

### Accessibility looks up an empty relation id

- **Patch**: `patches/a11y-empty-relation-id.patch`
- **Mozilla bug**: none filed.
- **Defect**: `DocAccessible::AddDependentIDsFor` calls `GetElementById` for
  each atom of a relation attribute, including the empty atom an empty value
  parses to. Element reflection produces that value (`popoverTargetElement`
  sets `popovertarget` to ""), so with accessibility on, the address bar's
  search-mode `moz-button` logs "Empty string passed to getElementById()" on
  every tab switch. The fix skips the empty atom.
- **Evidence**: `browser_sval_accessibility_console.js` fails
  without the patch.
- **Upstream**: one bug, with the patch as it is. Not submitted.

### A stack's frame list in the console has an empty active descendant

- **Patch**: `patches/devtools-frames-empty-activedescendant.patch`
- **Mozilla bug**: none filed.
- **Defect**: the debugger's `Frames` component, which the Browser Console
  uses to show an error's stack, starts with `currentFrame` "" and renders
  `aria-activedescendant=""`. With accessibility on, resolving it looks up
  the empty id, so the console logs "Empty string passed to getElementById()"
  against its own `index.html` for each stack it shows. The fix leaves the
  attribute off until a frame has had focus.
- **Evidence**: `browser_sval_accessibility_console.js` fails without the
  patch.
- **Upstream**: one bug, with the patch as it is. Not submitted.

### Closing DevTools logs "No such JSProcessActor"

- **Patch**: `patches/devtools-unregister-after-process-replies.patch`
- **Mozilla bug**: 2044741, where a fix that delays the unregistering by a
  timer was backed out twice (assertions in bug 1756240, then shutdown hangs);
  also 1964907 and 2060055 for the Browser Console.
- **Defect**: `WatcherActor.destroy` sends `destroyWatcher` to every process's
  DevTools actor, then `ParentProcessWatcherRegistry.unregisterWatcher`
  unregisters the JS Process Actors at once when no watcher is left. Each
  process goes on sending while it destroys the watcher's targets
  (`targetDestroyed`, resource packets, the page's console messages), and
  each message that arrives after the unregistering logs "NotFoundError: No
  such JSProcessActor 'DevToolsProcess'" (or
  'BrowserToolboxDevToolsProcess') from `JSActorManager::ReceiveRawMessage`.
  Closing a page's toolbox or the Multiprocess Browser Console does it on
  most closes while the page is busy. The fix makes `destroyWatcher` a query,
  which each process answers after the messages it sent while destroying, and
  unregisters once every answer is in and no watcher has registered since.
  A frozen process keeps the actors registered until it answers.
  `DevToolsProcessParent` forgets the watcher when it sends the query, while
  the watcher's connection is open, and nothing is unregistered past XPCOM
  shutdown, where `JSActorService::UnregisterProcessActor` dereferences the
  in-process actors (bug 2056174, fixed in 154 and carried as
  `backport-bug-2056174-unregister-process-actor-in-shutdown.patch`).
- **Evidence**: `browser_sval_devtools_close.js` fails on every run without
  the patch and passes with it.
- **Upstream**: one bug, with the patch as it is. Not submitted.

### DevTools logs a slow content process as an error

- **Patch**: `patches/devtools-slow-process-warns.patch`
- **Mozilla bug**: none filed.
- **Defect**: `DevToolsProcessParent.sendQuery` logs `console.error` when a
  content process takes over a second to answer a query, and again when it
  answers. DevTools carries on either way, so neither is an error. On a
  loaded machine, opening the Multiprocess Browser Console logs both for
  every process.
- **Evidence**: `browser_sval_devtools_close.js`, which fails on any console
  error, failed with both lines for all nine content processes on a loaded
  Windows runner.
- **Upstream**: file a bug in DevTools :: General with the patch. Not
  submitted.

### A process that starts as DevTools closes reports targets for a gone watcher

- **Patch**: `patches/devtools-targets-for-a-gone-watcher.patch`
- **Mozilla bug**: none filed.
- **Defect**: `ParentProcessWatcherRegistry.unregisterWatcher` drops a
  watcher from its map without writing the map back to `sharedData`, so a
  content process that starts afterwards still reads the watcher there. A
  process that read it before the watcher's destruction reached it does the
  same. Either one's `DevToolsProcessChild.instantiate` creates targets for
  the watcher, and `DevToolsProcessParent.#onTargetAvailable` throws "Watcher
  Actor with ID ... can't be found" for each. `#onTargetDestroyed` already
  ignores a watcher that has gone. The fix writes the map back when a watcher
  is unregistered, and has `#onTargetAvailable` ignore a gone watcher as
  `#onTargetDestroyed` does; `destroyWatcher` destroys those targets once it
  reaches the process. Closing the Multiprocess Browser Console while
  processes start shows it.
- **Evidence**: `browser_sval_devtools_close.js` and
  `browser_sval_console_api_warning.js` logged the error in CI on Linux,
  macOS and Windows.
- **Upstream**: one bug, with the patch as it is. With Mozilla's own
  unregistering the window is shorter, since the actors go at once, but the
  same race applies. Not submitted.

### A Web Console batch queued before closing throws when its timer fires

- **Patch**: `patches/devtools-console-batch-after-closing.patch`
- **Mozilla bug**: none filed.
- **Defect**: `WebConsoleWrapper.setTimeoutIfNeeded` dispatches its queued
  messages 50 ms later. If the console closes in between,
  `WebConsoleUI.destroy` has dispatched `START_IGNORE_ACTION`, so the
  `ignore` middleware throws on that dispatch, and the timer's async
  callback rejects with nothing to catch it: "Dispatching 'MESSAGES_ADD'
  action after panel's closing". The fix drops the batch when the store is
  ignoring actions.
- **Evidence**: `browser_sval_devtools_close.js` failed with it in CI on
  macOS.
- **Upstream**: one bug, with the patch as it is. Not submitted.

### The Browser Console drops a batch with a request DevTools made

- **Patch**: `patches/devtools-console-skip-devtools-requests.patch`
- **Mozilla bug**: none filed. Bug 2038986 is about showing DevTools'
  own requests, which the skip leaves hidden.
- **Defect**: `WebConsoleUI._onResourceAvailable` skips a network event
  whose cause is "devtools" with `return`, before `dispatchMessagesAdd`
  sends the messages built from the batch. Every message in that batch is
  lost, so the Browser Console misses requests that arrive with one of
  DevTools' own. The fix skips that event alone, with `continue`.
- **Evidence**: Mozilla's `browser_console.js` failed 6 of 6 runs without
  the patch and passes with it.
- **Upstream**: one bug, with the patch as it is. Not submitted.

### Browser-chrome tests warn that a script disabled the console

- **Patch**: `patches/mochitest-window-keeps-console.patch`
- **Mozilla bug**: none filed.
- **Defect**: the mochitest harness's `WindowListener.setupWindow`
  (`testing/mochitest/api.js`) replaces every browser window's `console`
  with a `Console.sys.mjs` `ConsoleAPI`. `DocumentEventsListener.hasNativeConsoleAPI`
  finds no `IS_NATIVE_CONSOLE` on it, so each time a test opens the Browser
  Console, `WebConsoleUI.handleNavigated` logs "The Web Console logging API
  ... has been disabled by a script on this page". Mozilla's
  `browser_console.js` works around it by putting `nativeConsole` back. A
  real browser window keeps its own console and never warns. The fix keeps
  the window's console; the test profile's `devtools.console.stdout.chrome`
  prints its calls to the log as the replacement did.
- **Evidence**: `browser_sval_console_api_warning.js` fails without the
  patch.
- **Upstream**: one bug, with the patch as it is; `browser_console.js` can
  then drop its workaround. Not submitted.

### Native messaging reports a write to a host that stopped reading

- **Patch**: `patches/native-messaging-closed-host.patch`
- **Mozilla bug**: none filed.
- **Defect**: `NativeApp._startWrite` reports every write failure with
  `Cu.reportError`. A host that has closed its stdin or exited fails the
  write with "File closed" (`Subprocess.ERROR_END_OF_FILE`), which
  `_startRead` and `_cleanup` already treat as an ordinary disconnect. An
  extension that messages its host on tab events, such as iCloud Passwords,
  logs the error. The fix reports only other write failures.
- **Evidence**: `test_native_messaging_closed_host.js` fails without the
  patch.
- **Upstream**: one bug, with the patch and a task in
  `test_ext_native_messaging.js`. Not submitted.

### Letterboxing throws on the preloaded browser, and leaks a resize observer

- **Patch**: `patches/rfp-letterboxing-tab-browsers-only.patch`
- **Mozilla bug**: none filed. mozilla-central's RFPHelper is unchanged.
- **Defect**: two in `RFPHelper.sys.mjs`.
  - `_attachWindow` watches every `.browserStack`, including the preloaded
    new-tab browser, which has no tab. `_roundContentSize` then throws
    "aBrowser.getTabBrowser() is null".
  - `privacy.resistFingerprinting` is a prefix of the letterboxing pref, so
    one letterboxing change runs `_handleLetterboxingPrefChanged` twice. Each
    run attaches the window again, and `_detachWindow` disconnects only the
    last observer, so the rest keep rounding browsers after letterboxing is
    off.
- **Evidence**: `browser_sval_letterboxing.js`.
- **Upstream**: file two bugs, one per defect, with the patch split in two.
  Not submitted.

### Subprocess's kill() rejects for a process that has just exited

- **Patch**: `patches/subprocess-kill-after-exit.patch`
- **Mozilla bug**: none filed. mozilla-central's `kill()` is unchanged.
- **Defect**: `BaseProcess.kill()` checks `exitCode`, then sends the worker a
  kill and does not handle the reply. The worker forgets a process once it
  has reaped it, a moment before the main thread hears of the exit, so a kill
  in that window rejects with "Invalid process ID" and nothing can catch it.
- **Evidence**: none recorded here.
- **Upstream**: file a bug with an xpcshell test that kills right after exit.
  Not submitted.

### The domain policy fails closed for hostless URIs, trailing dots and ports

- **Patch**: `patches/domain-policy-hostless-uris.patch`
- **Mozilla bug**: none filed.
- **Defect**: once an `nsIDomainPolicy` is active, `DomainSet` fails for a
  URI with no host (`GetCanonicalClone`'s `SetUserPass` fails), and
  `xpc::Scriptability` treats the failure as "block script". So every
  sandboxed frame and data: document loses script with no rule set at all. A
  host with a trailing dot is chopped to an empty host, and a page on a
  non-default port never matches its site's entry.
- **Upstream**: the fixes for the three failures are generic and could go
  upstream. Giving a null principal its precursor's answer is Sval's policy;
  offer it as a separate, optional change. Not submitted.

### Service workers ignore the script policy

- **Patch**: `patches/service-worker-script-policy.patch`
- **Mozilla bug**: none filed.
- **Defect**: `javascript.enabled` and the domain policy are read only when a
  window global is made. Nothing in `dom/serviceworkers` reads them, so a site
  with JavaScript off still has its service worker intercept navigations and
  run on push, sync and messages. An update or registration of such an
  origin never finishes: its script comparison reads the cache through a
  sandbox of the origin's principal, a realm the policy blocks runs none of
  its promise jobs (`CanRunJSCallback`), and the stuck job holds every later
  job for the scope, an unregister included.
- **Upstream**: file a bug. Firefox exposes per-site JavaScript only through
  the domain policy, so Mozilla may treat this as low priority. Not submitted.

### Content classifier matches the registrable domain, not the host

- **Patch**: `patches/content-classifier-full-hosts.patch`
- **Mozilla bug**: none filed.
- **Defect**: `ContentClassifierRequest` hands adblock-rust the registrable
  domain in place of the full request and source hosts. `||sub.example.com^`
  rules and `$domain=` suffix matching never fire, which covers a large share
  of EasyList and EasyPrivacy.
- **Evidence**: `browser_sval_blocking_url_classifier.js` (rule
  `||consent-manager.example.org^`).
- **Upstream**: small. Pass `GetAsciiHost` of the URI and of the loading
  principal. Not submitted.

### A content classifier rebuild that settles late never goes live

- **Patch**: `patches/content-classifier-pref-lists.patch`, its rebuild-race
  part only. Its pref-driven list ids and allowed-domains feature are Sval's.
- **Mozilla bug**: none filed.
- **Defect**: a rebuild whose fetches settle after a newer rebuild's installs
  its engine but never makes it active, because only the newest call fills
  the active lists.
- **Evidence**: none recorded here.
- **Upstream**: split the race fix out of Sval's patch. Not submitted.

### A content classifier feature turned off and back on keeps a stale engine

- **Patch**: `patches/content-classifier-off-features-go-stale.patch`.
- **Mozilla bug**: none filed.
- **Defect**: `ContentClassifierService::ProcessListChanges` skips a feature
  the engines prefs leave out, so a list that changes while it is off marks
  nothing stale, and turning it back on before `PruneInactiveEngines` has run
  keeps the engine it had. `PruneInactiveEngines` also erases the feature's
  entry in `mFeatureVersions`, so its next version restarts at one and a build
  scheduled before it went off counts as current and installs.
- **Evidence**: `browser_sval_blocking_off_and_on.js` fails
  without the patch.
- **Upstream**: needs a Bugzilla bug and a gtest that turns a feature off and
  on while a build for it is under way. Not submitted.

### Writing both engines prefs builds a feature's engine twice

- **Patch**: `patches/content-classifier-pref-lists.patch`, its
  `ProcessListChangesSoon` part.
- **Mozilla bug**: none filed.
- **Defect**: `ContentClassifierService::OnPrefChange` runs
  `ProcessListChanges` for each engines pref that changes. Turning a
  feature on writes the normal and the private windows' prefs one after the
  other, and the second pass finds the feature still without an engine, its
  first build running, so it fetches and parses every list again. The fix
  runs one pass after the turn's writes.
- **Evidence**: `browser_sval_blocking_engine.js`
  `turning_blocking_on_reads_each_list_once` reads each list twice without
  it.
- **Upstream**: split it out of Sval's patch with an xpcshell test that writes
  both prefs. Not submitted.

### Fingerprinting overrides go stale for sites with a granular entry

- **Patch**: `patches/fp-overrides-follow-global.patch`
- **Mozilla bug**: none filed.
- **Defect**: `nsRFPService::SetFingerprintingOverrides` resolves granular
  entries against the global sets only at load, and `PrefChanged` refreshes
  only the global sets. A change to
  `privacy.fingerprintingProtection.overrides` leaves every site with a
  granular entry on the old set until restart, Mozilla's own webcompat
  entries included.
- **Evidence**: none recorded here.
- **Upstream**: re-populate in `FingerprintingWebCompatService` when either
  global pref changes. Not submitted.

### A removed tab-scoped DENY stays in processes showing another origin of its site

- **Patch**: `patches/tab-permission-removal-site-key.patch`
- **Mozilla bug**: none filed. Bug 2064718 fixed the rest of the removal's
  reach and left this case.
- **Defect**: `PermissionManager::ForwardBrowserPermissionToChild` sends a
  tab-scoped removal to the processes that `NeedsPermissionsUpdate` for the
  permission's origin key. A DENY is stored for the whole site, and
  `TransmitBrowserPermissionsForPrincipal` hands it to a process showing any
  origin of the site, which holds the site's key but not that origin's, so
  its copy of the DENY outlives the removal and applies again on Back.
- **Evidence**: `browser_sval_media_gate_tab.js`
  covers a removed grant, which is origin-scoped; no test drives a removed
  DENY across two origins of a site.
- **Upstream**: also select the processes that `NeedsPermissionsUpdate` for
  the site key. Not submitted.

### A tab's scoped permissions go when one of its frames goes

- **Patch**: `patches/tab-permissions-survive-subframe-discard.patch`
- **Mozilla bug**: none filed. The cleanup came with Bug 2023237, and
  mozilla-central still has it.
- **Defect**: `PermissionManager::Observe` calls `RemoveAllForBrowser` on
  "browsing-context-discarded" for any browsing context with the tab's
  `BrowserId`. A subframe carries its tab's `BrowserId`, so removing an
  iframe, or reloading a page that has one, clears every permission scoped
  to the tab, every `SitePermissions.SCOPE_TEMPORARY` grant and block
  included.
  The fix clears them only when the top-level context goes.
- **Evidence**: on reddit.com, a reload discards the page's frames and the
  media grant is gone within a second. `browser_sval_media_gate_tab.js`'s
  `a_visits_allowance_outlives_the_pages_frames` fails without the patch.
- **Upstream**: the one-line `IsTop()` check and a test that removes an
  iframe. Not submitted.

### A split view footer put back in its pane stops following it

- **Patch**: `patches/split-view-footer-reconnect.patch`
- **Mozilla bug**: none filed.
- **Defect**: `MozSplitViewFooter.disconnectedCallback` calls `#resetTab`,
  which drops the tab and its listeners, and `connectedCallback` returns at
  once for a footer already initialized, so a footer taken out of the
  document and put back shows the address it last had through every later
  load.
- **Evidence**: `browser_sval_split_row.js`'
  `a_footer_put_back_in_its_pane_still_follows_it` times out without the
  patch. Seen as `about:blank` in every inactive pane's footer of a restored
  split.
- **Upstream**: the patch as it stands. Not submitted.

### Gecko builds adblock-rust without procedural filters

- **Patch**: `patches/adblock-css-validation.patch`
- **Mozilla bug**: none filed.
- **Defect**: without adblock-rust's css-validation feature, a procedural
  filter such as `:has-text(...)` comes back as a plain hiding selector.
- **Evidence**: none recorded here.
- **Upstream**: relevant only if Mozilla adopts cosmetic filtering, which
  Gecko does not do today.

### WebDriver opens a new window only in an app named Firefox

- **Patch**: `patches/webdriver-window-for-firefox-builds.patch`
- **Mozilla bug**: none filed. mozilla-central's `openBrowserWindow` is
  unchanged.
- **Defect**: `WindowManager.openBrowserWindow` switches on `AppInfo.name`
  and handles only `"Firefox"`, where the rest of the remote agent tests
  `AppInfo.isFirefox`, the application ID. A build with Firefox's ID and its
  own name, as every rebranded build has, cannot open a window over
  WebDriver classic or BiDi: "openWindow() not supported in Sval". The fix
  tests `AppInfo.isFirefox`.
- **Evidence**: `browser_sval_webdriver_window.js` and upstream's
  `sessionstore/test/marionette/test_log_files.py` fail without the patch.
- **Upstream**: file a bug with the patch. Not submitted.

### macOS utility processes never start from a path with a symlink in it

- **Patch**: `patches/macos-child-real-path.patch`
- **Mozilla bug**: none filed.
- **Defect**: two, on macOS.
  - `BaseProcessLauncher::GetPathToBinary` launches each child from the GRE
    directory as the parent saw it, so a parent launched through a symlink
    (`/tmp/…/Firefox.app`, mktemp's `/var/folders`, a user's own link)
    launches its children through the link. A sandboxed child resolves the
    paths it derives from its executable, and macOS's sandbox needs
    `file-read-metadata` on each symlink a path passes through.
    `SandboxPolicyUtility` grants none (the content, RDD, GPU and socket
    policies allow `(allow file-read-metadata (subpath "/"))`; the GMP policy
    does not either), so the
    utility processes never connect and no audio decoder starts. The patch
    resolves the GRE directory with `nsIFile::Normalize` before the launch,
    as `nsMacUtilsImpl::GetAppPath` already does for the sandbox's
    `APP_PATH`, and widens no sandbox.
  - Nothing times out the launch: `UtilityProcessHost`'s launch promise stays
    pending until shutdown. A video with an audio track never decodes its
    first frame, `HTMLMediaElement` keeps delaying the load event, and the
    page never fires `load`. Not fixed in Sval: any bound short enough to
    matter could fail a slow but healthy launch.
- **Evidence**: Firefox 158 from
  `/tmp/<dir>/Firefox.app` never reaches `load` on https://www.cnn.com/
  (no utility process; the sandbox log shows `deny file-read-metadata /var`
  from `plugin-container`). From `/private/tmp/<dir>/Firefox.app`, the same
  copy, it loads in about 1 s, and from the symlinked path it loads with
  `MOZ_DISABLE_UTILITY_SANDBOX=1`. `scripts/symlink-launch-test.py`, run by
  the `macos-test` CI job, launches Sval through a symlinked directory and
  fails when `nsIUtilityProcessTest.startProcess()` does not settle; it
  fails without the patch.
- **Upstream**: file a bug with these steps and the patch, and propose a
  timeout on the launch. Not submitted.

### A property list dictionary cannot be iterated

- **Patch**: `patches/plist-dictionaries-iterate.patch`
- **Mozilla bug**: none filed.
- **Defect**: `PropertyListUtils` returns each dictionary as a Proxy over a
  Map. `LazyMapProxyHandler` serves `get`, `has` and `delete` and returns any
  other property unbound from the target, so `keys()`, `values()`,
  `entries()`, `forEach()` and `for...of` throw "called on incompatible
  Proxy". A dictionary whose keys are not known in advance cannot be read.
  The fix binds Map's methods to the target and resolves the pending lazy
  getters first.
- **Evidence**: `test_sval_import_orion.js`'s bookmarks task
  throws without the patch.
- **Upstream**: file a bug against Toolkit with the patch and an xpcshell
  test iterating a binary and an XML dictionary. Not submitted.

### An installed search engine is offered again under another title

- **Patch**: `patches/opensearch-installed-host.patch`
- **Mozilla bug**: none filed.
- **Defect**: `OpenSearchManager.addEngine` hides a page's OpenSearch offer
  only when the `<link>`'s title is an installed engine's name. A site whose
  title differs from the name its description installs under (kagi.com
  offers "Kagi Search" and installs "Kagi") is offered again, and adding it
  fails as a duplicate. The fix also hides an offer served from the site an
  installed engine searches on.
- **Evidence**: `browser_sval_upstream_ui.js`
  `an_installed_engine_is_not_offered_again`.
- **Upstream**: file a bug against Search with a browser test; Mozilla may
  prefer to compare the description's search URL once it is fetched. Not
  submitted.

### Clearing a locked containers pref closes every container tab

- **Patch**: `patches/workspace-identities.patch`
- **Mozilla bug**: none filed.
- **Defect**: `Preferences::ClearUser` notifies observers when it clears a
  locked pref's user value, though the pref's value, its locked default, did
  not change (`SetUserValue` skips the notification for a locked pref).
  `ContextualIdentityService.observe` answers a `privacy.userContext.enabled`
  notification that reads false by closing every tab outside the default jar
  and resetting the identities. An add-on with the `contextualIdentities`
  permission writes the pref at startup, so a locked-off pref still costs
  the user their container tabs. The fix ignores a notification for a locked
  pref.
- **Evidence**: `browser_sval_isolated_workspaces.js`, the add-on step.
- **Upstream**: file a bug against Toolkit: `observe` should act only on a
  real change of the value, or `ClearUser` should not notify for a locked
  pref. Not submitted.

### Removing the selected tab behind a window-modal dialog leaves it selected

- **Patch**: `patches/tabbrowser-blur-past-modal.patch`
- **Mozilla bug**: none filed.
- **Defect**: tabbrowser's `_blurTab` selects the next tab through the
  `selectedTab` setter, which returns without switching while
  `window-modal-open` is set. The removed tab stays `selectedTab` with a null
  `linkedBrowser`, and every later switch throws in `AsyncTabSwitcher`'s
  constructor ("initialBrowser is null"), so no tab can be selected again in
  that window. Any removal of the selected tab while such a dialog is open
  reaches it. The fix selects through `tabbox.selectedTab`, past the
  setter's guards against a user switching tabs under a dialog.
- **Evidence**: `browser_sval_tab_closed_behind_dialog.js` fails
  without the patch with the same exception.
- **Upstream**: file a bug with a test that closes the selected tab while
  `gDialogBox` is open. Not submitted.

### Closing a window mid-restore logs "Given tab is not restoring."

- **Patch**: `patches/sessionstore-abandoned-restore.patch`
- **Mozilla bug**: none filed.
- **Defect**: closing a window runs SessionStore's `onClose`, whose
  `cleanUpRemovedBrowser` resets the restoring state of every tab still
  restoring. The load each of those tabs was waiting for settles afterwards,
  and `_restoreTabContentComplete` still finds the tab in the closed window's
  `gBrowser`, so it resets the tab a second time and
  `_resetLocalTabRestoringState` logs the error. The fix returns when the
  browser has no entry in `TAB_STATE_FOR_BROWSER`.
- **Evidence**: `browser_sval_workspace_windows_leaving.js` fails its console
  check without the patch: closing a torn-off window before its tab has
  loaded logs the error.
- **Upstream**: one bug, with a test that closes a window while one of its
  tabs is restoring. Not submitted.

### A lazy tab given new state keeps reporting its old address

- **Patch**: `patches/sessionstore-lazy-tab-uri.patch`
- **Mozilla bug**: none filed.
- **Defect**: `SessionStore.restoreTab` replaces a lazy tab's
  `TAB_LAZY_STATES` entry, but the lazy browser's `currentURI` getter
  (tabbrowser's `_createLazyBrowser`) returns the URI it cached on its first
  read. `setTabState` on a lazy tab that has been read once leaves
  `currentURI` on the old address until the browser is inserted. tabbrowser's
  `swapBrowsersAndCloseOther` clears the cache itself before its own
  `setTabState`. The fix clears it in `restoreTab`, for every caller.
- **Evidence**: `browser_sval_restore.js`'s
  `a_restored_tab_takes_its_nodes_address_until_loaded` fails without the
  patch.
- **Upstream**: one bug, with a test that calls `setTabState` twice on a lazy
  tab and reads `currentURI` after each. Not submitted.

### The JSON view sniffer throws on a load cancelled before its response

- **Patch**: `patches/jsonview-sniffer-cancelled-load.patch`
- **Mozilla bug**: none filed.
- **Defect**: when a top-level load's response reaches the socket thread
  and the load is then cancelled, as `CanonicalBrowsingContext`'s discard
  does when its tab or window closes, `nsHttpChannel::OnStartRequest` takes
  no response head, yet `CallOnStartRequest` still calls the content
  sniffers. JSON view's `Sniffer.getMIMETypeFromContent` reads
  `contentType`, which throws `NS_ERROR_NOT_AVAILABLE` without a response
  head, and the error is logged. The fix reads the type as `null` when the
  channel has none, as the sniffer already does for the content disposition.
- **Evidence**: `browser_sval_workspace_windows_leaving.js`'s
  `a_window_left_with_no_free_workspace_closes` fails its console check
  without the patch: the window closes while its tab's page is loading.
- **Upstream**: one bug, with the patch. Not calling the sniffers of a
  failed channel in `CallOnStartRequest` is the deeper fix, and needs a
  network peer's review. Not submitted.

### Remote Settings logs requests the shutdown refused as errors

- **Patch**: `patches/remote-settings-quiet-at-shutdown.patch`
- **Mozilla bug**: none filed.
- **Defect**: a fresh profile starts Remote Settings' first downloads at
  startup. When the app quits within seconds, `ServiceRequest.open` in
  `Utils.fetch` throws `NS_ERROR_ILLEGAL_DURING_SHUTDOWN`. Then
  `pullStartupBundle`, `RemoteSettingsClient.get` and the polling loop each
  log the refusal with `console.error`, though `sync` already treats shutdown
  as expected: it warns and reports `SHUTDOWN_ERROR`. The fix adds
  `Utils.reportError`, which logs at debug while `Services.startup.shuttingDown`.
- **Evidence**: the release build's package start check
  (`sval --headless --screenshot` on a fresh profile, in
  `scripts/release-build.sh`) logs one error for the startup bundle and one
  for each collection that has no dump.
- **Upstream**: one bug, with the patch and an xpcshell test that begins
  shutdown while a sync waits on the server. Not submitted.

### A Wayland window stays opaque where its chrome turns translucent

- **Patch**: `patches/gtk-wayland-commit-toplevel-opaque-region.patch`
- **Mozilla bug**: none filed. Bug 2045222 reports the symptom and was
  closed with a userChrome rule that makes `body` translucent from the
  start.
- **Defect**: `nsWindow::UpdateOpaqueRegionInternal` sets the toplevel
  GdkWindow's opaque region as well as the content surface's. GDK sends the
  toplevel's region with that surface's next commit, and GTK commits it only
  when it repaints it, which a window drawing its own titlebar never asks
  for. A region that shrinks after the first paint, as when a theme or
  script makes the chrome translucent, stays opaque on the toplevel, and the
  compositor draws its clear pixels as black under the translucent parts.
  The fix invalidates the toplevel after setting its region, so GTK commits
  it.
- **Evidence**: on GNOME 51, `WAYLAND_DEBUG=1` showed the toplevel's
  `set_opaque_region` covering the whole window, and only the content
  surface's region updated after the root turned translucent. A resize,
  which commits the toplevel, made the translucent chrome show the desktop.
- **Upstream**: one bug, with the patch. Not submitted.

### Remote Settings measures the clock skew up to a minute ahead

- **Patch**: `patches/remote-settings-clock-skew-without-age.patch`
- **Mozilla bug**: none filed.
- **Defect**: `Utils.fetchLatestChanges` adds the response's `Age` to its
  `Date` to get the server's time, on the reasoning that a CDN serves a
  cached `Date`. The CDN in front of `firefox.settings.services.mozilla.com`
  stamps `Date` at delivery and counts `Age` up to its `max-age` of 60
  seconds, so `services.settings.clock_skew_seconds` comes out between 0
  and -60 at random, and changes on each poll. The fix takes the server's
  time from `Date` alone.
- **Evidence**: on 2026-11-13, a cached response from the changes endpoint
  carried `date` equal to the local time, `age: 15`, `x-cache: MISS, HIT`.
  `/v1/` showed the same with `age: 3254`.
- **Upstream**: one bug, with the patch and the changed
  `test_check_clockskew_ignores_age`. Not submitted.

### The hidden window's History menu throws on history changes after a window closes

- **Patch**: `patches/hidden-history-menu-closes.patch`
- **Mozilla bug**: none filed.
- **Defect**: on macOS, `SessionStoreInternal.maybeSaveClosedWindow`
  dispatches a synthetic `popupshowing` on the hidden window's History menu
  when the first window closes, and never a `popuphidden`. `HistoryMenu`
  opens its Places result on `popupshowing` and closes it only on
  `popuphidden`, so the result stays open with no popup. Once history is
  cleared (`invalidateContainer` marks the popup unbuilt), each later visit's
  title change or move throws "No DOM node set for aPlacesNode" from
  `PlacesViewBase._getDOMNodeForPlacesNode`. The fix dispatches the matching
  `popuphidden`.
- **Evidence**: `browser_sval_workspace_windows_leaving.js`'s
  `history_after_a_window_closes_logs_nothing` fails on macOS without the
  patch.
- **Upstream**: file a bug with that sequence as a test. Not submitted.

### An answered extension prompt's hidden buttons keep their access keys

- **Patch**: `patches/extension-popup-hidden-access-keys.patch`
- **Mozilla bug**: none filed.
- **Defect**: `ExtensionControlledPopup` leaves its popupnotification in
  `#extension-notification-panel` once answered, with `hidden` set. Its
  buttons are moz-buttons, whose access key sits on an inner HTML button,
  and `EventStateManager`'s `IsAccessKeyTarget` checks a frame only for XUL
  elements. So off macOS, after the tab-hide prompt is answered, Alt+D
  presses its hidden Disable Extension button (access key D), which throws
  "couldn't find notification" from `PopupNotifications._onButtonEvent`, and
  the address bar's Alt+D does nothing. The fix clears the buttons'
  `accessKey` on `popuphidden` and inherits it back on the next show. The
  root is `IsAccessKeyTarget`; a fix there would need a Gecko compile.
- **Evidence**: Linux and Windows CI hit it.
  `browser_sval_launcher_float.js`'s
  `alt_d_floats_it_after_a_hidden_tabs_prompt` asserts it off macOS; on
  macOS, headless with `ui.key.chromeAccess` set to Alt, every Alt+D pressed
  the hidden button without the patch and none did with it.
- **Upstream**: file a bug with the prompt answered, then Alt+D, as a test.
  Not submitted.

### Undo close tab's key ignores closedTabsFromAllWindows

- **Patch**: `patches/undo-close-tab-key-workspace.patch`, which goes further
  than the defect: it hands the key to a window that shows a Sval workspace.
- **Mozilla bug**: none filed. Bugzilla has 2075121 and 2081861 on the
  pref's other paths, neither on the key.
- **Defect**: with `browser.sessionstore.closedTabsFromAllWindows` false,
  History's Recently Closed list and Firefox View offer only the current
  window's closed tabs, but Ctrl+Shift+T
  (`SessionWindowUI.restoreLastClosedTabOrWindowOrSession`) takes the last
  close from SessionStore's global `_lastClosedActions` stack and reopens a
  tab another window closed into this one.
- **Evidence**: `browser_sval_undo_close_window.js`'s
  `the_undo_key_reopens_only_this_windows_closed_tabs` fails without the
  patch.
- **Upstream**: the fix Mozilla needs is smaller than Sval's patch: with the
  pref false, pass no source window to `undoCloseTab`, so the key reopens
  this window's own last closed tab. File a bug with the pref false, a tab
  closed in a second window, then the key in the first, as a test. Not
  submitted.

### A server socket on Windows can be taken by another account

- **Patch**: `patches/server-socket-exclusive-address.patch`, which adds an
  opt-in flag: `nsIServerSocket.ExclusiveAddress`.
- **Mozilla bug**: none filed for the cross-account bind.
  [489488](https://bugzilla.mozilla.org/show_bug.cgi?id=489488) (NSPR, NEW)
  reports the Windows `SO_REUSEADDR` double bind as a test inconsistency.
- **Defect**: `nsServerSocket` binds with `SO_REUSEADDR`, with which Windows
  lets a socket of another OS account bind the same address and port, and
  Windows then hands each connection to either socket. Every Gecko server
  socket on Windows is exposed, Marionette's and the remote agent's among
  them, though stock Firefox opens none unless asked.
- **Evidence**: `SvalAgents.sys.mjs`'s agent listener passes
  `ExclusiveAddress`. No test binds from a second account.
- **Upstream**: binding with `SO_EXCLUSIVEADDRUSE` on Windows by default would
  need Mozilla to check that no caller relies on rebinding a port in
  `TIME_WAIT`. File a bug with the cross-account bind as the reproduction.
  Not submitted.

### Firefox's own chrome logs deprecation warnings to the user's console

- **Patch**: `patches/chrome-deprecations-not-warned.patch`
- **Mozilla bug**: none filed.
- **Defect**: a deprecated WebIDL member warns once per document that uses
  it, and Firefox's browser chrome reads `Window.fullScreen` across its own
  scripts, so every browser window logs "Window.fullScreen attribute is
  deprecated". The warning is meant for web page authors.
- **Evidence**: `browser_sval_chrome_deprecations.js` fails without the
  patch.
- **Upstream**: the patch skips the warning for system-principal documents
  in `BindingUtils.cpp`. Mozilla may prefer to move its chrome off
  `Window.fullScreen`. Not submitted.

### browser_permission_delegate_geo.js reads one request's answer as the next's

- **Patch**: `patches/geo-delegate-test-awaits-each-answer.patch`
- **Mozilla bug**: [1775949](https://bugzilla.mozilla.org/show_bug.cgi?id=1775949),
  closed INCOMPLETE as an unfixed intermittent, with
  [1684444](https://bugzilla.mozilla.org/show_bug.cgi?id=1684444) as its
  duplicate: `"deny" == "allow"`.
- **Defect**: `permissions.html` posts an answer for every geolocation
  request, a denied prompt's included, and `checkGeolocation` listens only
  where no prompt shows. The denied prompt's late "deny" reaches the DENY
  check's listener, and the DENY check's own "deny" then reaches the ALLOW
  check's.
- **Evidence**: delaying the frame's error answer by a second
  in `permissions.html` fails the unpatched test with `"deny" == "allow"`
  every time, and the patched test passes.
- **Upstream**: attach the patch to a new bug, since 1775949 is closed. Not
  submitted.

### Ctrl+Shift+Tab does nothing in recently used order without the all-tabs button

- **Patch**: `patches/ctrl-tab-recent-order.patch`
- **Mozilla bug**: none filed.
- **Defect**: with `browser.ctrlTab.sortByRecentlyUsed` on, `ctrlTab.onKeyDown`
  takes Ctrl+Shift+Tab to `gTabsPanel.showAllTabsPanel`, which returns
  without opening anything when `gTabsPanel.canOpen` is false. The tabbox's
  own Ctrl+Shift+Tab is off in that mode (`handleCtrlTab`), so the key does
  nothing.
- **Evidence**: `browser_sval_ctrl_tab.js`'s
  `ctrl_shift_tab_goes_to_the_previous_tab` fails without the patch.
- **Upstream**: check whether stock Firefox can reach `canOpen` false (a
  hidden tab strip, or vertical tabs), then file with the patch.

### Ctrl+Shift+Plus misses a '+' shortcut where Shift+'+' types another character

- **Patch**: `patches/widget-shifted-plus-shortcut.patch`
- **Mozilla bug**: none filed.
- **Defect**: on a layout that types '+' without Shift (German, Swedish,
  Norwegian, Danish, Finnish), Shift with that key types another character,
  and the shortcut candidates for a Shift event hold only shifted characters
  (`WidgetKeyboardEvent::GetShortcutKeyCandidates`). A `<key key="+"
  modifiers="control,shift">` then never runs there, though Windows'
  `NativeKey::WillDispatchKeyboardEvent` already treats `VK_OEM_PLUS` as '+'
  with Ctrl on layouts that type '+' elsewhere. The patch adds '+' as the
  shifted alternative on Windows and GTK.
- **Evidence**: `browser_sval_keyboard_layouts.js` fails on Windows under
  `KEYBOARD_LAYOUT_GERMAN` without it.
- **Upstream**: needs a Bugzilla bug and a widget test. macOS is not
  covered, because Sval binds Control+Plus there without Shift.

### OSKeyStore on Linux never reconnects to a restarted Secret Service

- **Patch**: `patches/libsecret-reconnects.patch`
- **Mozilla bug**: none filed. Bugzilla has no bug on `LibSecret.cpp`
  reconnecting, and mozilla-central's `LibSecret.cpp` never calls
  `secret_service_disconnect`.
- **Defect**: libsecret keeps one connection to the Secret Service per
  process, bound to the daemon that answered first. `LibSecret.cpp` calls
  `secret_password_*_sync` on it and never drops it, so once the keyring
  daemon restarts every OSKeyStore call fails until the browser restarts.
  The patch calls `secret_service_disconnect()` after a failed call, so the
  next call connects to whichever daemon answers then.
- **Evidence**: `test_sval_os_keystore_unreadable.js` and
  `test_sval_os_keystore_earlier_refusal.js` fail on Linux without the fix,
  in the daily OS key-store suite, which stops and restarts gnome-keyring.
- **Upstream**: file a bug with the patch. A test needs a Secret Service it
  can restart, which Mozilla's Linux test image does not run. Not submitted.

### Closing a tab that plays sound throws in AudioPlaybackParent

- **Patch**: `patches/audio-playback-gone-browser.patch`
- **Mozilla bug**: none filed.
- **Defect**: `AudioPlaybackParent.receiveMessage` calls
  `audioPlaybackStopped` on `browsingContext.top.embedderElement` without
  checking it, and the `AudioPlayback:Stop` a playing tab's child sends as it
  closes arrives once that is null. Each such close logs a `TypeError`.
  `didDestroy` in the same actor already checks the browser.
  `AudioPlaybackChild` sends that message from its "audio-playback"
  observer, which can run once its window global can no longer send, and
  `sendAsyncMessage` throws `InvalidStateError`.
- **Evidence**: `browser_sval_media_button.js` fails Sval's console check
  without the patch, as each task's playing tab closes.
- **Upstream**: a one-line guard with a browser-chrome test that closes a
  tab while it plays. Not submitted.

### A video back from Picture-in-Picture gets the small toggle

- **Patch**: `patches/videocontrols-measure-on-init.patch`
- **Mozilla bug**: none filed.
- **Defect**: a `<video>` without controls gets a new
  `NoControlsPictureInPictureImpl` widget when it comes back from
  Picture-in-Picture. Its `init` sizes the toggle (`setupToggle`) from the
  default `reflowedDimensions`, 300 by 150, and `resizevideocontrols`, which
  would correct them, comes only when the video's size changes. So a large
  call tile's toggle stays marked `small-video` after one round trip. The
  fix measures the video (`updateReflowedDimensions`) in `init` before
  sizing the toggle.
- **Evidence**: `browser_sval_pip_toggle_size.js` fails without the patch.
- **Upstream**: file a bug against Toolkit :: Picture-in-Picture with the
  patch, the test as a toolkit/components/pictureinpicture test. Not
  submitted.

### A server's TLS alert says the data could not be verified

- **Patch**: `patches/server-alert-error-pages.patch`, with the entries in
  `chrome/browser/components/sval/errors/server-alert-errors.mjs`.
- **Mozilla bug**: none filed.
- **Defect**: the error registry has no entry for most alerts a server
  sends to end the handshake, so `resolveErrorID` falls back to
  `nssFailure2`. That page says the authenticity of the received data could
  not be verified, though no certificate arrived and nothing can be
  overridden. A site whose server answers with internal_error reads as a
  certificate failure.
- **Evidence**: `browser_sval_tls_alert_error.js` fails without the patch.
- **Upstream**: add the entries to `ssl-errors.mjs` and file a bug against
  Firefox :: Security, with the test as a toolkit error-page test.
  `browser_error_registry.js` counts the registered errors and would take
  the new total. Not submitted.

### A background tab's refresh driver stops for good with work pending

- **Patch**: `patches/refresh-driver-inactive-timer-cap.patch`
- **Mozilla bug**: [2087125](https://bugzilla.mozilla.org/show_bug.cgi?id=2087125)
  (ASSIGNED), the out-of-memory crash in
  `AnimationEventDispatcher::QueueEvent` this causes. Its patch,
  [D339714](https://phabricator.services.mozilla.com/D339714), dispatches a
  hidden document's animation events in a task; review asked for changes
  because that departs from the HTML spec and other engines.
- **Defect**: `InactiveRefreshDriverTimer` doubles its interval and, once
  past 10 minutes, stops scheduling until another driver joins it. A driver
  that still has work stays attached, and `EnsureTimerStarted` returns early
  for a driver with a timer, so it never ticks again. A background page's
  animation events are then never dispatched, and a page that keeps
  cancelling Web Animations queues them without bound, each holding its
  animation, target element and listeners.
- **Evidence**: an 8-hour memory soak on macOS, Windows and Linux. A
  background YouTube live stream tab grew about 55 MB an hour on each, and
  its final cycle-collector log held 6,389 animations, all reachable only
  from `AnimationEventDispatcher.mPendingEvents`. Two 3-hour Linux soaks
  side by side, with `nsRefreshDriver` logging: without the patch the live
  tab's inactive timer last ticked about 34 minutes in and never again, and
  its live chat frame held 162, 347 and 419 animations at the 40, 80 and 100
  minute marks; with it the timer ticked every 600 seconds and the frame
  held 2 and 14 at 40 and 60 minutes. No automated test: the timer takes about
  17 minutes to stop, with no pref to shorten it.
- **Upstream**: comment on bug 2087125 that the queued events never fire
  because the throttled timer stops, and offer this patch as the fix review
  asked for there. Not submitted.

### A part of a restrict keyword and a space leaves the address bar empty

- **Patch**: `patches/urlbar-restrict-keyword-whole.patch`
- **Mozilla bug**: none filed.
- **Defect**: `UrlbarProviderRestrictKeywordsAutofill.isActive` returns
  true for any query that begins a restrict keyword, such as "@b " for
  "@bookmarks", though `startQuery` adds a result only for the whole
  keyword and a space. An active heuristic provider of priority 1 keeps
  the priority-0 ones out (`UrlbarProvidersManager`), so the query gets no
  heuristic result: "@b " lists nothing and enters no engine's search mode
  until another key is typed.
- **Evidence**: `browser_sval_search_keywords.js` types "@b" and Space and
  expects Bing's search mode, which never comes without the patch.
- **Upstream**: the patch, with a test in `browser_tokenAlias.js` for an
  engine alias that begins a restrict keyword. Not submitted.

### The other-copy update notice never clears

- **Patch**: `patches/update-other-instance-recheck.patch`
- **Mozilla bug**: none filed.
- **Defect**: `UpdateListener.showRestartNotification` picks the "Other
  Instance" notification while another copy runs, and nothing looks again.
  After the other copy quits, the notice still asks for it to be closed until
  the browser restarts. The fix polls at
  `app.update.checkOnlyInstance.interval` and shows the restart notification
  once no other copy runs.
- **Evidence**: seen on a Mac with two copies of Sval open.
  `browser_sval_app_notices.js` covers the swap.
- **Upstream**: a small patch with a test in `toolkit/mozapps/update/tests`.
  Not submitted.

### Deleting a container keeps the client certificates chosen in it

- **Patch**: `patches/client-auth-choice-cleared-with-jar.patch`
- **Mozilla bug**: none found in a search of Bugzilla.
- **Defect**: `ClientAuthRememberCleaner` in `ClearDataService.sys.mjs` has no
  `deleteByOriginAttributes`, so `deleteDataFromOriginAttributesPattern`
  skips it. `ContextualIdentityService.remove` clears a container that way,
  and the remembered choices keyed by its `userContextId` stay in
  `ClientAuthRememberList` after the container is gone.
- **Evidence**: read in the code. `test_sval_client_auth_jar.js` fails without
  the patch.
- **Upstream**: the patch, with a test beside
  `toolkit/components/cleardata/tests/unit`. Not submitted.

### The crash reporter client names a file by the id the server sends

- **Patch**: `patches/crash-client-checks-crash-id.patch`
- **Mozilla bug**: none filed.
- **Defect**: `Response::parse` in the client's `net/report.rs` takes
  `CrashID` as it came, and `handle_crash_report_response` in `logic.rs`
  writes `submitted/<CrashID>.txt`. An id holding a path separator writes
  the file outside that directory. `CrashSubmit.sys.mjs` checks the same id
  against `SUBMISSION_REGEX`.
- **Evidence**: read in the code. No test: Sval's CI does not run the
  client's Rust tests.
- **Upstream**: the patch, with a case in `report_response` in the same
  file. Not submitted.

### The topsites module's list goes stale while the browser runs

- **Patch**: `patches/topsites-refresh-on-rank-change.patch`
- **Mozilla bug**: none filed.
- **Defect**: with `browser.topsites.component.enabled`, the address bar
  reads `TopSites.getSites()`, which returns the list `TopSites.refresh`
  last built. `refresh` runs on bookmark, history-removal, search and pref
  events only. The new tab add-on's `TopSitesFeed` also refreshes on
  `SYSTEM_TICK`, which the module has no counterpart for. A page the user
  makes frequent after the list was first read stays out of it until one
  of those events or a restart. The fix refreshes on Places'
  `pages-rank-changed`, which every visit and frecency recalculation fires.
- **Evidence**: `browser_sval_launcher_top_sites.js`'s
  `a_site_made_frequent_later_joins_the_launcher` visits a page fifteen
  times after the list was read. Without the patch the list never
  refreshes and the page is missing.
- **Upstream**: file a bug in Firefox :: Address Bar with the patch and an
  xpcshell case in `browser/components/topsites/test/unit/test_top_sites.js`.
  Not submitted.

## Worked around in Sval's code, Mozilla's code unchanged

### A page asking to stay is discarded when it answers late

- **Patch**: none. `SvalFirefox.pageAllowsUnload` asks the page itself, with
  no timeout of the window global's own, and keeps a page that has not
  answered before its idle unload discards it.
- **Mozilla bug**: none filed.
- **Defect**: `MozBrowser.permitUnload`, which `_mayDiscardBrowser` asks
  before `discardBrowser` unloads a tab, passes `dom.beforeunload_timeout_ms`
  (1000 ms) to `WindowGlobalParent::PermitUnload`, and a request that times
  out resolves as permitted. A background tab's content process can take
  longer than that to run the page's `beforeunload`, so `discardBrowser` and
  `TabUnloader` discard a page whose handler asks to stay, with the text the
  user typed into it.
- **Evidence**: before the workaround, `browser_sval_switcher_unsaved_work.js`'s
  rich editor task lost its draft in some runs, its release taking the full
  second of the timeout.
- **Upstream**: a discard is not something the user asked for, so a timeout
  there should keep the page. File a bug with a test that delays the
  content process's `beforeunload`. Not submitted.

### A top-level progress listener sees a stop with no start

- **Patch**: none. `SvalAgentTabs.navigate` works around it (`endLoadInFlight`).
- **Mozilla bug**: none filed.
- **Defect**: `BrowsingContextWebProgress::OnStateChange` drops a
  `STATE_START` that arrives while the old document still counts as loading.
  A parent-initiated load (`CanonicalBrowsingContext::AttemptSpeculativeLoadInParent`)
  can start before the old `STATE_STOP` reaches the parent. When the load also
  replaces the browsing context (bfcache, `mReplaceBrowsingContext`),
  `BrowserParent::ReceiveProgressListenerData` drops the old context's late
  `STATE_STOP`. A top-level progress listener then sees a stop with no start.
- **Evidence**: a deterministic probe, not kept in the tree.
- **Upstream**: file a bug with the probe as a browser-chrome test. Not
  submitted.

### A menu item's keycode shortcut is not exposed to assistive technology

- **Patch**: none. Sval's menu items that name a keycode key carry
  `aria-keyshortcuts` too (`SvalShortcuts.ariaShortcut`).
- **Mozilla bug**: none filed.
- **Defect**: `XULMenuitemAccessible::KeyboardShortcut` reads a `<key>`
  with no `key` attribute by parsing the empty `key` string rather than the
  `keycode` it has just read, so a menu item whose key is F2, Delete or an
  arrow exposes no shortcut. Firefox's own items with keycode keys (Reload
  F5, Find Again F3) lose theirs the same way.
- **Evidence**: `browser_sval_panel_context_menu.js`'s
  `the_menu_names_the_keys_that_do_the_same` finds `keyboardShortcut` empty
  for F2 and Delete.
- **Upstream**: map the keycode through `KeyboardEvent` key codes and report
  it, with an accessible test. Not submitted.

### A custom widget's `overflows: false` is ignored

- **Patch**: none. Sval's custom header widgets set `overflows="false"` on
  the node their `onBuild` returns (`SvalHeader`).
- **Mozilla bug**: none filed.
- **Defect**: `CustomizableUI.createWidget` documents `overflows` for every
  widget, but `CustomizableUIInternal.buildWidgetNode` writes the
  `overflows` attribute only for a button-type widget, and
  `OverflowableToolbar.#onOverflow` reads only the attribute. A `custom`
  widget created with `overflows: false` overflows.
- **Evidence**: before Sval's builders set the attribute, a 500px window put
  the live devices, the reader button, history and the private badge,
  all created with `overflows: false`, in the overflow panel.
  `browser_sval_header_overflow.js` checks the row at every width.
- **Upstream**: set the attribute for a custom widget's node too, with a
  test in `browser_914138_widget_API_overflowable_toolbar.js`. Not
  submitted.

### A toolbar item that appears or grows does not overflow

- **Patch**: `header-overflow.patch` gives `OverflowableToolbar` a
  `ResizeObserver` on the customization target's items, which checks for
  overflow after its notifications are delivered.
- **Mozilla bug**: none filed.
- **Defect**: `OverflowableToolbar` checks for overflow on the window's
  `resize` and on a widget's DOM change through `CustomizableUI`
  (`#onResize`, `onWidgetAfterDOMChange`). An item that is shown, or that
  grows, resizes no window, so with the address bar at its minimum the
  row's items run past the target (`min-width: 0`) until the next resize.
- **Evidence**: `browser_sval_header_overflow.js` shows the reader button
  in a row with no room left for it, with no window resize, and checks that
  it overflows.
- **Upstream**: observe the target's items as the patch does, with a test
  in `browser_914138_widget_API_overflowable_toolbar.js`. Not submitted.

## Diagnosed, not fixed

### AsyncTabSwitcher throws while the selected browser is between processes

- **Patch**: none.
- **Mozilla bug**: none filed.
- **Defect**: `AsyncTabSwitcher.handleEvent` handles a `visibilitychange` that
  arrives while the selected tab's browser has no `webNavigation`, because it
  is switching process, and throws `requestedBrowser.currentURI is null`.
  `onLayersCleared` also trips the assertion at `AsyncTabSwitcher`'s `assert`
  when a tab opens after a discard.
- **Evidence**: it appears on every local run of
  `browser_sval_agent_tabs.js` and fails no test.
- **Upstream**: file a bug with steps to reproduce it. Not submitted.

### An AudioContext's resume() waits forever when audioipc callbacks never arrive

- **Patch**: none.
- **Mozilla bug**: none filed.
- **Defect**: now and then on macOS, the parent's audioipc server starts a
  content process's output stream (`Cubeb stream … started successfully`,
  which is where cubeb-coreaudio's `start` sends `State::Started`), but the
  content process's `AudioIPC Client Callback` thread never receives that
  state or any data callback. The `AudioCallbackDriver` stays in `Starting`
  on its fallback driver. Nothing retries it, and
  `MediaTrackGraphImpl::CheckDriver` applies a pending Resume only off the
  fallback, so `AudioContext.resume()` never settles and the context stays
  "suspended".
- **Evidence**: `MOZ_LOG` output from both processes, not kept in the tree.
  `browser_sval_media_gate.js` failed in 1 of 10 local runs on a Mac with real
  audio output.
- **Upstream**: find whether audioipc2 drops the callback or the client
  thread never services it. Then file a bug with the logs, asking for a
  watchdog that re-inits a stream that started but never calls back. Not
  submitted.

### LoginManagerChild touches a dead document after it is replaced

- **Patch**: none.
- **Mozilla bug**: none filed.
- **Defect**: `LoginManagerChild`'s `waitForVisible` throws "can't access dead
  object" when the document is replaced while it waits. It is log noise only.
- **Evidence**: seen in a CI log.
- **Upstream**: low value; file only alongside other LoginManager work.

### Settings scrolls 1px sideways in a narrow window

- **Patch**: none. Sval's `settings.css` narrows `.pane-container` by the
  margin.
- **Mozilla bug**: none filed.
- **Defect**: in `preferences.css`, `.pane-container` is
  `width: min(100%, 600px)` with `margin-inline-start: 1px`. When
  `.main-content` has less than 601px of room, the container is 1px wider
  than it, so every category scrolls sideways by 1px.
- **Evidence**: `every_category_fits_at_twice_the_text_size` in
  `browser_sval_preferences_layout.js` fails on Linux CI's 694px content area
  without the override.
- **Upstream**: use `width: min(100% - 1px, 600px)`, or move the 1px into
  padding. Not submitted.

### A message missing from a window's first translation stops its later ones

- **Patch**: `patches/launcher-float.patch` works around it: the address
  bar writes Sval's placeholder only once the window has Sval's strings.
- **Mozilla bug**: none filed.
- **Defect**: when an element of `browser.xhtml` names a Fluent message the
  window's resources do not hold at its first translation, the translation
  rejects ("uncaught exception: undefined", three times), and no element
  given an id afterwards is translated in that window: an `<input>` given
  `urlbar-placeholder` by `document.l10n.setAttributes` a second later gets
  no `placeholder`. A missing message should only be reported. The cause in
  `DocumentL10n` and `L10nMutations` is not traced.
- **Evidence**: a probe browser test, with the address bar's first
  placeholder set to a missing id (`sval-no-such-message`), saw the later
  element untranslated; with Firefox's own `urlbar-placeholder` first, it
  was translated. Without the workaround, `browser_sval_launcher_commands.js`
  fails ("the field asks for a workspace" times out).
- **Upstream**: reduce to a test with a chrome document naming a missing
  id, find where the first translation's failure stops the mutations, and
  file it. Not submitted.

### A closed window keeps the Windows App SDK's title bar objects

- **Patch**: `patches/windows-titlebar-reset-on-destroy.patch`
- **Mozilla bug**: none filed. [Bug 2057394](https://bugzilla.mozilla.org/show_bug.cgi?id=2057394)
  has the crash signature this leak ends in, from another cause.
- **Defect**: on Windows 11, `nsWindow::SetCustomTitlebar` has the Windows App
  SDK collapse the title bar (`WindowsUIUtils::SetIsTitlebarCollapsed`, setting
  `ExtendsContentIntoTitleBar`), and `nsWindow::Destroy` destroys the window
  without restoring it. The SDK keeps the title bar's GDI objects, about twenty
  per window, in Firefox ESR 153.5.1, Release 158.0.1 and Nightly 160.0a1
  alike. A process that opens and closes a few hundred windows reaches
  Windows' limit of 10,000: `RemoteBackbuffer`'s `CreateDIBSection` fails, then
  the next window's title bar fails inside the SDK, which fail-fasts
  (`e0464645`, `Cn::FailFast` in `Microsoft.UI.Windowing.Core.dll`). The fix
  restores the default title bar before `DestroyWindow`.
- **Evidence**: opening and closing 100 windows in one process
  takes the parent from about 60 GDI objects to 2,150 without the fix, and to
  70 with it; skipping the title bar call instead leaves 26.
  `browser_sval_windows_gdi.js` fails without the patch.
- **Upstream**: file a bug in Core :: Widget: Win32 with the measurement and
  the patch. Not submitted.

### about:support logs "WebGL context was lost." twice

- **Patch**: `patches/webgl-manual-loss-not-warned.patch`
- **Mozilla bug**: none filed.
- **Defect**: `ClientWebGLContext::OnContextLoss` warns on every loss,
  including one asked for through `WEBGL_lose_context.loseContext()`.
  `Troubleshoot.sys.mjs`'s graphics provider makes a WebGL 1 and a WebGL 2
  context to read the renderer and loses each to free it, so every
  `Troubleshoot.snapshot()` (about:support, Report Broken Site) puts two
  warnings in the Browser Console that point at Troubleshoot's own code. The
  fix skips the warning for a manual loss whose caller is chrome
  (`nsContentUtils::ThreadsafeIsCallerChrome`). The document's principal
  cannot tell them apart: `DOMParser::Constructor` gives a system caller's
  documents a null principal.
- **Evidence**: seen in the Browser Console of a Sval release candidate.
  `browser_sval_webgl_manual_loss.js` fails without the patch.
- **Upstream**: file in Core :: Canvas: WebGL with the patch and the test.
  Not submitted.

### Site data reads as empty when the storage folder cannot be listed

- **Patch**: none.
- **Mozilla bug**: none filed.
- **Defect**: `SiteDataManager._getQuotaUsage` reads only a usage request
  whose `resultCode` is `NS_OK` and resolves on any other result, so a failed
  read looks the same as a profile with no stored data. When the disk refuses
  to list `storage/default`, the quota clear fails (`QuotaCleaner.deleteBySite`
  reports `CLEAR_DOM_QUOTA` in `failedFlags`) and the next read reports the
  site's jar as empty while its data is still on disk. Settings and the site
  page then show nothing left to clear.
- **Evidence**: found by denying the listing of
  `storage/default` after storing data in a jar; no test asserts it.
- **Upstream**: file in Toolkit :: Data Sanitization with the steps, asking
  that a failed usage read reject or report its failure. Not submitted.

### A private origin's storage metadata names its site

- **Patch**: `patches/quota-private-metadata-no-site.patch`
- **Mozilla bug**: none filed.
- **Defect**: `QuotaManager::CreateDirectoryMetadata2` writes an origin's
  suffix and group into `.metadata-v2` as legacy fields
  `LoadFullOriginMetadata` discards. For a private origin the folder is named
  by a random storage origin, and the two fields still hold the site the
  origin is partitioned under and the origin's own site. `storage/private`
  is removed when private browsing ends, so a killed process leaves every
  private site that used storage readable on disk until the next launch.
- **Evidence**: `test_sval_private_storage_metadata.js` reads the file of a
  partitioned private origin. Without the patch it holds both sites.
- **Upstream**: file in Core :: Storage: Quota Manager with the patch and
  the test as an xpcshell test. Not submitted.

### A string copied from a private window is not private data

- **Patch**: `patches/clipboard-private-window-copy.patch`
- **Mozilla bug**: none filed.
- **Defect**: `nsClipboardHelper::CopyStringToClipboard` marks its
  transferable private only when the caller passes `Sensitive`. The context
  menu's Copy Link, Copy Email Address, Copy Phone Number and Copy Media
  Location pass the page's window context and no flag, and the address bar's
  Copy Without Site Tracking passes neither, so a private window's copies
  reach Windows' clipboard history and cloud clipboard and KDE's history.
  The fix reads private browsing from the window context the helper is
  given.
- **Evidence**: read in the code. No test: `nsITransferable.isPrivateData`
  is not scriptable, and a headless run has no system clipboard.
- **Upstream**: file in Core :: Widget with the patch and a gtest of the
  helper. Not submitted.

### Web Audio names its OS audio stream after a private page's title

- **Patch**: `patches/audio-stream-private-no-title.patch`
- **Mozilla bug**: none filed.
- **Defect**: `GetDocumentTitle` in `MediaTrackGraph.cpp` gives the graph's
  audio driver the document's title as its stream name, at start and on each
  `document-title-changed`, with no private browsing check. The name goes
  to the system's audio server.
- **Evidence**: read in the code. No test: the name reaches only the audio
  backend.
- **Upstream**: file in Core :: Audio/Video: MediaStreamGraph with the
  patch. Not submitted.

### A private window's print job is named after its page

- **Patch**: `patches/print-job-private-name.patch`
- **Mozilla bug**: none filed.
- **Defect**: `nsPrintJob::SetupToPrintContent` passes the page's title, or its
  address when it has none, to `nsDeviceContext::BeginDocument` as the job's
  name for a private document as for any other. The system's print queue
  and its job history keep the name.
- **Evidence**: `browser_sval_private_print_job.js` prints a private page to
  a PDF file, whose title is the job's name. Without the patch it is the
  page's title.
- **Upstream**: file in Core :: Printing: Setup with the patch, using the
  brand's short name. Not submitted.

### The OS media controls get a private tab's duration and position

- **Patch**: `patches/media-controls-private-no-position.patch`
- **Mozilla bug**: none filed.
- **Defect**: `MediaStatusManager` gives the system's media controls default
  metadata for a private tab (`GetCurrentMediaMetadata`), and
  `GetCurrentPositionState` and `UpdatePositionState` still hand them the
  media's duration and position.
- **Evidence**: `browser_sval_private_media_position.js` counts a private
  tab's `positionstatechange` events. Without the patch the tab reports the
  position its page declares.
- **Upstream**: file in Core :: Audio/Video: Playback with the patch and
  the test. Not submitted.

### A private window's HWND does not carry IS_PRIVATE when TSF is available

- **Patch**: `patches/windows-private-window-input-scope.patch`
- **Mozilla bug**: none filed.
- **Defect**: Microsoft's Recall guidance for browsers asks for
  `SetInputScope(hwnd, IS_PRIVATE)` on a private window. `IMEHandler` calls
  `SetInputScopes` on the window only when TSF is unavailable
  (`SetInputScopeForIMM32`), and then with the focused editor's state. With
  TSF, `TSFTextStoreBase::SetInputScope` adds `IS_PRIVATE` to the focused
  editor's text store alone.
- **Evidence**: read in the code and in Microsoft's Recall guidance for
  web browsers. Not run: it needs a Recall PC.
- **Upstream**: file in Core :: Widget: Win32 with the patch, once it is
  checked on a Recall PC. Not submitted.

### An HTTPS-Only exception made in a private window holds in every window

- **Patch**: `patches/https-only-private-exception.patch`
- **Mozilla bug**: none filed.
- **Defect**: `https-only-load-insecure` is in `kStripOAPermissions`, so
  the session exception `WindowGlobalParent::RecvReloadWithHttpsOnlyException`
  and `nsHTTPSOnlyUtils::AddHTTPSFirstException` add for a private principal
  is stored with no origin attributes. It holds in normal windows and other
  private windows until the browser quits. The fix keeps a private
  principal's exception under a type of its own that is not stripped.
- **Evidence**: `test_sval_private_https_only_exception.js` adds the
  exception for a private principal. Without the patch a normal principal
  reads it.
- **Upstream**: file in Core :: DOM: Security. Mozilla would want the
  exception keyed by private browsing alone, since Sval's one session per
  private window is its own. Not submitted.

## Mozilla's fixes Sval needs landed

### Back is disabled after a load from the address bar while the page is busy

- **Patch**: `patches/backport-bug-2058297-user-interaction-in-parent.patch`
  (D314488 diff 2, unlanded).
- **Mozilla bug**: [2058297](https://bugzilla.mozilla.org/show_bug.cgi?id=2058297),
  [D314488](https://phabricator.services.mozilla.com/D314488) (r+ from
  smaug, unlanded since 2026-08-21).
- **Defect**: the user-interaction flag on the old session history entry is
  set in the content process, which misses it when the page is running a
  script at Enter, so Back skips the page.
- **Evidence**: `browser_sval_back_after_address_bar_load.js` fails 50/50 without the patch.
  Sval found that the same-site case fails too, which comment 0 assumes is safe,
  and that D314488 fixes both.
- **Upstream**: post the comment below on Bug 2058297. Not submitted: it goes
  out with Sval's other contributions, once the way Sval contributes to Firefox
  is settled.

  ```text
  A user-facing STR (Firefox ESR 153.5 base, Fission and session history in
  parent on, browser.navigation.requireUserInteraction=true). The steps mirror
  an automated test that fails every time on Linux, macOS and Windows; they
  have not been run by hand:

  1. Open a new tab and load a page that runs a long script a moment after
     load, without touching the page, e.g.
     data:text/html,<script>setTimeout(()=>{let e=Date.now()+3000;while(Date.now()<e);},1500)</script>
     (an https page on a site works the same way)
  2. While the script runs, type a URL on another site in the address bar and
     press Enter.
  3. When it has loaded, look at the Back button.

  Expected: Back is enabled and returns to the page from step 1.
  Actual: Back is disabled. Session history has the entry for step 1 with
  hasUserInteraction=false, and the new entry also false.

  In an automated browser-chrome test (URL bar Enter, then
  BrowserCommands.back()), it fails 50/50 when the old page is busy and 0/200
  when it is idle. When the target is cross-site, the new entry commits in its
  own process about 30 ms after Enter, while the old process is still running
  the script. ContentChild::RecvLoadURI then finds the BrowsingContext no
  longer in process and returns, so nsDocShell::LoadURI never sets
  SHEntryHasUserInteraction at all.

  It also fails 50/50 when the target is same-site, with no process switch.
  nsDocShell::LoadURI does run in that case (nsDocShellLeak log), yet the old
  entry is never marked. So the same-process path is not as safe as comment 0
  assumes. A busy old page is enough to lose the flag.

  Setting the flag in the process that triggers the load (D314488) marks the
  entry before the content process is involved. Sval carries D314488 diff 2 as
  patches/backport-bug-2058297-user-interaction-in-parent.patch, and with it
  the same test passes in both the cross-site and the same-site case.
  ```

### The HSTS cleaner cannot clear one jar's entries

- **Patch**: `patches/hsts-private-jar.patch`, which also keys HSTS by
  `userContextId`. That half is Sval's own choice: Mozilla shares HSTS
  across containers on purpose
  ([1253006](https://bugzilla.mozilla.org/show_bug.cgi?id=1253006)).
- **Mozilla bug**: [1926599](https://bugzilla.mozilla.org/show_bug.cgi?id=1926599)
  (NEW, no patch).
- **Defect**: the HSTS cleaner in `ClearDataService` has no
  `deleteByOriginAttributes`, and its `deleteBySite` ignores the pattern, so
  clearing one jar's data clears the site's HSTS in every jar or none.
- **Evidence**: `browser_sval_isolated_workspaces.js`
  `a_workspaces_hsts_and_exceptions_stay_in_its_jar` fails without the patch.
- **Upstream**: offer the cleaner's per-attributes delete on Bug 1926599.
  Not submitted.

### Forget About This Site leaves a private window's certificate exceptions

- **Patch**: `patches/cert-overrides-per-jar.patch` (the `CertCleaner` hunk).
- **Mozilla bug**: none filed.
- **Defect**: `CertCleaner.deleteBySite` in `ClearDataService.sys.mjs` clears
  each matching override with empty origin attributes, but
  `nsCertOverrideService::GetKeyString` keeps `privateBrowsingId` in the key,
  so an exception accepted in a private window survives Forget About This
  Site until the last private window closes.
- **Evidence**: `browser_sval_isolated_workspaces.js`
  `forget_this_site_takes_it_from_every_jar` fails without the hunk. That
  test fails on a workspace's `userContextId`, which only Sval's patched key
  keeps; upstream the same mismatch hits `privateBrowsingId` alone.
- **Upstream**: pass each override's own `originAttributes` to
  `clearValidityOverride`, as the patch does. Not submitted.

### The address bar offers a refresh that does nothing

- **Patch**: `patches/refresh-tip-needs-reset-support.patch`
- **Mozilla bug**: none filed.
- **Defect**: `UrlbarProviderInterventions` shows its refresh tip whenever
  the `profileRefresh` policy allows it, and its up-to-date tip offers a
  refresh with no check at all. Picking either calls `resetBrowser`, which
  returns without doing anything when `ResetProfile.resetSupported()` is
  false: a profile the profile service does not know, a build without the
  self-migrator, or `DisableProfileRefresh` for the up-to-date tip. The fix
  asks `resetSupported()`, which checks the policy too.
- **Evidence**: `browser_sval_no_profile_reset.js`
  (`the_address_bar_offers_no_refresh`).
- **Upstream**: file a bug with a browser test that makes `resetSupported()`
  false and types "refresh firefox". Not submitted.

### The Troubleshoot Mode dialog names a string that does not exist

- **Patch**: `patches/safe-mode-refresh-string.patch`
- **Mozilla bug**: none filed.
- **Defect**: `safeMode.xhtml`'s `#resetProfile` box carries
  `data-l10n-id="refresh-profile-instead"`, which `browser/safeMode.ftl` in
  ESR 153 does not define, so Fluent rejects with "Missing message" when the
  dialog is translated, and after repeated startup crashes the box would show
  no text. The fix names `skip-troubleshoot-refresh-profile`, the string the
  dialog's `#resetProfileInstead` label uses.
- **Evidence**: `browser_sval_no_profile_reset.js`, which opens the dialog,
  reported the rejection on macOS without the patch.
- **Upstream**: file a bug with the one-line fix. Not submitted.

### Clearing a site for one jar clears it in every jar

- **Patch**: `patches/clear-data-pattern-per-cleaner.patch`, which gives
  each cleaner its own copy of the pattern in `deleteDataFromSite`.
- **Mozilla bug**: none filed.
- **Defect**: `ClearDataService.deleteDataFromSite` runs every cleaner at
  once with the caller's pattern object, and `StorageAccessCleaner`,
  `ShutdownExceptionsCleaner`, `PermissionsCleaner` and
  `StoragePermissionsCleaner` delete its `userContextId` while
  `permissions.isolateBy.userContext` is false, its default.
  `QuotaCleaner.deleteBySite` filters origins after an await, so it reads
  the stripped pattern and clears the site's storage in every jar, and the
  caller's object comes back changed.
- **Evidence**: `browser_sval_site_data_clear_scope.js`,
  `test_sval_clear_site_per_jar.js`.
- **Upstream**: offer the patch, with the xpcshell test. Not submitted.

### A private jar's cookies and localStorage survive a clear by site

- **Patch**: none. `SvalSiteData.clearJarOf` removes a private jar's cookies
  by pattern and clears its open origins' storage by principal.
- **Mozilla bug**: [1751045](https://bugzilla.mozilla.org/show_bug.cgi?id=1751045)
  (NEW). Mozilla hides site clearing in private windows instead
  ([1754172](https://bugzilla.mozilla.org/show_bug.cgi?id=1754172)).
- **Defect**: `CookieCleaner.deleteBySite` lists cookies through
  `Services.cookies.cookies`, which holds the persistent store alone
  (`CookieService::GetCookies`), and `QuotaCleaner.deleteBySite` clears the
  origins `Services.qms.listOrigins` returns, which leaves out private
  localStorage, held in memory (`gPrivateDatastores`). A clear by site with
  a private pattern leaves both.
- **Evidence**: `browser_sval_site_data_clear_scope.js`.
- **Upstream**: read the private store in `CookieCleaner`, and clear private
  datastores by site in `QuotaCleaner`, on Bug 1751045. Not submitted.

### Closing a window throws for a tab no extension was given

- **Patch**: `patches/ext-tab-tracker-closed-window.patch`
- **Mozilla bug**: none filed.
- **Defect**: `TabTracker._handleWindowClose` in
  `browser/components/extensions/parent/ext-browser.js` reports every tab of
  the closing window as removed. `getId` gives a tab with no id one through
  `setId`, which throws "Cannot attach ID to a tab in a closed window." A
  tab has no id when its window opened before the tracker's first `getId`
  initialized it. The fix reports only the tabs the tracker gave an id,
  which are the only ones an extension can know.
- **Evidence**: `browser_sval_workspace_windows_leaving.js` fails its console
  check without the patch: its
  `a_window_closing_while_taking_kept_tabs_takes_none` closes a window whose
  tab the tracker never gave an id.
- **Upstream**: one bug, with a test that initializes the tracker after a
  window opens and then closes that window. Not submitted.

### The address bar builds its one-offs while they are turned off

- **Patch**: `patches/remove-unused-firefox-chrome.patch` (the `UrlbarView`
  and `UrlbarValueFormatter` hunks)
- **Mozilla bug**: none filed.
- **Defect**: `UrlbarView.oneOffSearchButtons` constructs `UrlbarSearchOneOffs`
  on first read even while `scotchBonnet.disableOneOffs` holds, which
  `scotchBonnet.enableOverride` makes the default. The object registers a
  prefs observer and a controller listener, and `enable` then hides it on
  every query. The getter could answer null while the one-offs are off, as
  it already does for the search bar; `UrlbarValueFormatter.#formatSearchAlias`
  is the one reader that would need `?.`.
- **Evidence**: none beyond reading the code. The one-offs' markup is gone
  from Sval's address bar and nothing reads the null.
- **Upstream**: one bug. A pref flipped at runtime would need the getter to
  build them then, as it does now on first read. Not submitted.

### Voice stream priming raises macOS's microphone dialog before the browser's prompt

- **Patch**: none. Sval sets
  `media.getusermedia.microphone.voice_stream_priming.enabled` false in
  `branding/sval/pref/app-sval-prefs.js`.
- **Mozilla bug**: none filed. [1914134](https://bugzilla.mozilla.org/show_bug.cgi?id=1914134)
  fixed the same dialog for a request with no microphone.
- **Defect**: on a request that includes the microphone, `MediaManager`
  primes a voice input stream (`PrimeVoiceProcessing`) before the page's
  permission prompt is answered. On a first run, opening it makes macOS ask
  for microphone access at once, so the system dialog comes up over the
  browser's prompt, and the camera's dialog only after Allow. Priming could
  wait until macOS has granted the microphone, which only the parent process
  can read (`nsIOSPermissionRequest`).
- **Evidence**: reproduced by hand on Google Meet with macOS's camera and
  microphone access reset (`tccutil reset`): with priming on, the microphone
  dialog appears when the page asks; with it off, both dialogs follow Allow.
- **Upstream**: file a bug against WebRTC: Audio/Video. Not filed.

### A cancelled font load is logged as a failed download

- **Patch**: `patches/font-load-cancel-is-no-error.patch`
- **Mozilla bug**: none filed.
- **Defect**: `gfxUserFontEntry::FontDataDownloadComplete`
  (`gfx/thebes/gfxUserFontSet.cpp`) logs every unsuccessful status as
  `downloadable font: download failed` with `errorFlag`. That includes
  `NS_BINDING_ABORTED`, which a document's loads get when it navigates away
  or closes while one of its fonts is still loading. Nothing failed, but the
  console shows an error.
- **Evidence**: a CI run of `browser_sval_search_opens_alike.js` logged two
  such errors, status 2152398850 (`NS_BINDING_ABORTED`), for a home tab's
  font, when a pick navigated the tab before the font had loaded.
- **Upstream**: one bug against Layout: Text and Fonts. Not filed.

### A Visual Studio package that fails to download hangs configure

- **Patch**: `patches/vsdownload-fails-not-hangs.patch`
- **Mozilla bug**: none filed.
- **Defect**: `downloadPackages` in `third_party/python/vsdownload/vsdownload.py`
  downloads in a `multiprocessing.Pool`, and `_downloadPayload` re-raises its
  last attempt's exception. The pool returns it to the parent by pickling, and
  urllib's `ContentTooShortError` does not unpickle (`__init__` needs a
  `content` argument its `args` lack). The pool's result thread dies with
  `TypeError`, and `task.get()` waits forever, so configure hangs. The five
  attempts also run back to back, so a host that cuts downloads short for a
  second fails all five.
- **Evidence**: the v0.1.0-rc.5 release build's Windows configure: five
  attempts at one package within 0.7 s, each cut at 2 MiB of 33 MB, then no
  output until the job was cancelled two hours later. A Pool whose worker
  raises `ContentTooShortError` reproduces it.
- **Upstream**: vsdownload is vendored from mstorsjo/msvc-wine; the fix goes
  there first, then to Mozilla's vendored copy (Firefox Build System). Not
  filed. CPython's unpicklable `ContentTooShortError` is a bug of its own.

### The accessibility checks reject a gridcell in an ARIA rowgroup

- **Patch**: `patches/a11y-checks-aria-rowgroup.patch`
- **Mozilla bug**: none filed.
- **Defect**: `isAccessibleGridcell` in
  `testing/mochitest/tests/SimpleTest/AccessibilityUtils.js` exempts a grid
  cell from the interactive-role check only when its row is directly in the
  grid or in a `<tbody>` grouping (ROLE_GROUPING). WAI-ARIA's grid lets rows
  sit in a `rowgroup`, which Gecko maps to ROLE_ROWGROUP, so a click on a cell
  of a valid grid fails as "Node is not accessible via accessibility API".
- **Evidence**: `browser_sval_appearance.js` with
  `--enable-a11y-checks` fails six tasks on the emoji picker's choices
  without the patch.
- **Upstream**: a two-line change to the check with a mochitest of a
  rowgroup grid; not submitted.

### The accessibility checks reject a treeitem of a roving-tabindex tree

- **Patch**: `patches/a11y-checks-roving-treeitem.patch`
- **Mozilla bug**: none filed.
- **Defect**: `isKeyboardFocusable` in
  `testing/mochitest/tests/SimpleTest/AccessibilityUtils.js` fails a click on
  an element with a negative tabindex unless it belongs to one of the roving
  widgets the function names (toolbars, `moz-radio`, `moz-visual-picker`).
  WAI-ARIA's tree view pattern keeps one treeitem at tabindex 0 and reaches
  the rest with the arrow keys, so a click on any other treeitem fails as
  "Node is not focusable via the accessibility API".
- **Evidence**: `browser_sval_archive.js`
  `a_tab_the_user_goes_to_is_marked_used` with `--enable-a11y-checks` fails
  on a click on a panel row that is not the tree's tab stop.
- **Upstream**: a few lines in the check with a mochitest of a roving tree;
  not submitted.

### A load the parent starts can keep the page it leaves out of the back-forward cache

- **Patch**: none.
- **Mozilla bug**: none filed.
- **Defect**: a load started from the parent
  (`CanonicalBrowsingContext::AttemptSpeculativeLoadInParent`) has no
  channel id until the content process claims it
  (`DocumentLoadListener::ClaimParentLoad`). That process first adds the
  load's `DocumentChannelChild` to the old page's load group, and the old
  page reports it to the parent as its one request
  (`nsDocShell::RecordSingleChannelId`). When the response arrives in
  between, `CanonicalBrowsingContext::AllowedInBFCache` compares the request
  against a missing channel id and blocks the old page for "requests in the
  loadgroup". Whether the page left is cached then depends on timing. A load
  the page starts carries its channel id from its open and never hits this.
- **Evidence**: `browser_sval_agent_site_gate.js`'s
  `a_back_to_a_site_blocked_since_is_refused`, with the agent's
  `navigate_tab` leaving the page, found it uncached in 13 of 90 runs on
  Windows CI. The `SHIPBFCache` log names the request as the
  blocker. The test has the page navigate itself.
- **Upstream**: file a bug with the `SHIPBFCache` log. Not submitted.

### Copy in about:preferences copies the search box, not the selection

- **Patch**: none. Sval's `settings.css` gives the page's HTML
  `-moz-user-focus: normal`.
- **Mozilla bug**: none filed.
- **Defect**: `toolkit/content/xul.css` gives every XUL element
  `-moz-user-focus: ignore`, and the property inherits, so the HTML inside
  about:preferences' XUL boxes is `ignore` too. A click on that text selects
  it, but `EventStateManager::PostHandleEvent` sees `ignore` and leaves the
  focus where it was. The page focuses its search box when it opens, so
  Edit › Copy and ⌘C copy from the empty search box.
- **Evidence**: `copy_copies_the_text_you_select` in
  `browser_sval_preferences_in_firefox_categories.js` fails without the rule.
  Checked on Sval's build only.
- **Upstream**: confirm on a Mozilla build, then file it against
  Firefox › Settings UI with the same rule in `preferences.css`. Not
  submitted.

### A double click outside a popup that opened between its clicks leaves it open on Windows

- **Patch**: none. `browser_sval_header_popovers.js` clicks each popover at
  its own point outside it.
- **Mozilla bug**: none filed.
- **Defect**: browser windows are registered with `CS_DBLCLKS`, so Windows
  sends the second press of a double click as `WM_LBUTTONDBLCLK`.
  `nsWindow::DealWithPopups` rolls a popup up only on `WM_LBUTTONDOWN`,
  `WM_RBUTTONDOWN`, `WM_MBUTTONDOWN` and their non-client forms, so a popup
  that opened after the first press stays open when the second lands outside
  it. A person hits this only by opening a popup from the keyboard between
  the two clicks.
- **Evidence**: `a_click_outside_a_popover_closes_it` in
  `browser_sval_header_popovers.js`, clicking two popovers at one point
  300 ms apart, left the downloads panel open on Windows.
- **Upstream**: handle the `*BUTTONDBLCLK` messages beside the button-down
  ones in `DealWithPopups`, with a widget test. Not submitted.

### GTK counts a popup's right and bottom shadow margins as inside it

- **Patch**: none.
- **Mozilla bug**: none filed.
- **Defect**: `is_mouse_in_window` in `widget/gtk/nsWindow.cpp` moves the
  popup's origin in by its input-region margin
  (`GetInputRegionMarginInGdkCoords`) but takes the margin off its width and
  height once, so its right edge and foot stay where the window's are. A
  press in a popup's left or top shadow margin rolls it up
  (`nsWindow::CheckForRollup`), and one in its right or bottom margin does
  not, and reaches the popup instead.
- **Evidence**: read from source while fixing `browser_sval_header_popovers.js`
  Not run.
- **Upstream**: take the margin off twice, with a widget test. Not
  submitted.

### A page restored from the back-forward cache before its process hid it is never shown

- **Patch**: none.
- **Mozilla bug**: none filed.
- **Defect**: the parent stores the page a tab leaves in the back-forward
  cache (`nsFrameLoaderOwner::ChangeRemotenessCommon`) before the page's own
  process runs its `pagehide`. A back that restores the page in that window
  (`nsFrameLoaderOwner::RestoreFrameLoaderFromBFCache`) leaves it with the
  late `pagehide` and no `pageshow`, and the tab waits on a page that never
  shows.
- **Evidence**: `browser_sval_media_gate_tab.js`'s
  `a_removed_tab_grant_reaches_the_process_the_tab_left`, going back as soon
  as the next page loaded, failed this way in 2 of 90 runs on Windows
  CI. The `SHIPBFCache` log shows the restore before the page's
  `pagehide`, and no `pageshow` after it. The test waits for the page it
  leaves to be hidden before it goes back or forward.
- **Upstream**: file a bug with the `SHIPBFCache` log. Not submitted.

### Accessibility re-checks a shadow host's children for every node of its shadow tree

- **Patch**: `patches/a11y-shadow-host-prune.patch`
- **Mozilla bug**: none filed. mozilla-central's `DocAccessible.cpp` still
  has the loop.
- **Defect**: `DocAccessible::PruneOrInsertSubtree` takes the containing
  shadow host and calls `ContentRemoved` on each of its frameless explicit
  children on every call, and the function recurses through the whole
  flattened subtree. Framing a shadow subtree again therefore costs (nodes
  walked) × (host's children): 401 walks over a host with 2,000 unslotted
  children make 802,000 `ContentRemoved` calls. Chrome's popups and panels
  are shadow hosts whose children have no frame while closed, so with an
  accessibility client on, a long-lived window's chrome updates take seconds.
  The fix checks a host's children at the host or at the insert root, once
  per walk.
- **Evidence**: `browser_sval_a11y_shadow_insertion.js` counts the calls through Gecko's
  PerfStats and fails without the patch.
- **Upstream**: file a bug against Core :: Disability Access APIs with the
  patch and the test, as an accessible/tests/browser test. Not submitted.

### Accessibility keeps a closed dialog's document in its parent's child list

- **Patch**: `patches/a11y-hanging-child-document.patch`
- **Mozilla bug**: none filed. mozilla-central's `OuterDocAccessible.cpp`
  and `NotificationController.cpp` have the same code.
- **Defect**: `OuterDocAccessible::Shutdown` detaches its child document and
  queues it to be bound again (`BindChildDocument`), leaving it in the
  parent's `mChildDocuments`. Binding it again appends it a second time, and
  failing to bind shuts it down, which removes it from the list only when it
  has a parent (`DocAccessible::Shutdown`). A window-modal dialog's frame goes
  this way when the dialog closes, so with accessibility on a window's
  document lists dead documents. When accessibility starts while such a
  dialog is up, the window's document waits for that never-loaded child: it
  stays busy, and its notification controller observes every refresh, so the
  window ticks at the display's rate until accessibility shuts down. Reading
  the dead child's state through XPCOM crashes. The fix takes each hanging
  document off the list before it is bound or shut down.
- **Evidence**: Linux CI's accessibility checks start accessibility on the
  click that answers an agent's pairing dialog, and Mozilla's
  `ensureVsyncDisabled` then fails.
  `browser_sval_dialog_accessible_tree.js` fails without the patch.
- **Upstream**: file a bug against Core :: Disability Access APIs with the
  patch and the test, as an accessible/tests/browser test. Not submitted.

### Each tab close counts every visible tab, whatever the window

- **Patch**: `patches/tab-bar-visibility-count.patch`
- **Mozilla bug**: none filed.
- **Defect**: `TabBarVisibility.update` runs on every tab close and reads
  `gBrowser.visibleTabs.length`, a filter over every tab once the close has
  dropped tabbrowser's cached list. Only a popup or taskbar-tab window uses
  the count, so closing many tabs in an ordinary window walks the strip once
  per close.
- **Evidence**: switching a window away from a 1,000-tab Workspace closes its
  unloaded tabs one by one. Under the profiler, `update` took about 1.2 s of
  that switch, nearly all of it in `visibleTabs`. `scripts/perf-panel.sh`
  measures the switch. No test fails without the fix, since it changes only
  the time.
- **Upstream**: the patch is one condition. Not yet checked against
  mozilla-central.

### An overflowed item keeps its hidden mark after it returns to the row

- **Patch**: `patches/overflow-hidden-node-returns.patch`
- **Mozilla bug**: none filed.
- **Defect**: `OverflowableToolbar.#onOverflow` adds an item with no width
  to `#hiddenOverflowedNodes`, and `#moveItemsBackToTheirOrigin` drops the
  toolbar's `overflowing` attribute when every item left in the panel is in
  that set. Nothing removes an item from the set, so one that overflowed
  while hidden still counts as hidden after it returns, shows, and
  overflows again. The overflow button then disappears with the item still
  in the panel, out of reach.
- **Evidence**: `browser_sval_header_overflow.js`'s split task, once the
  split button has overflowed hidden in an earlier task: at a width where
  the history button returns before the split button, the overflow button
  goes while the split button stays in the panel.
- **Upstream**: the patch is one line. Not yet checked against
  mozilla-central.

### An artifact build keeps every symbols tree it ever installed

- **Patch**: `patches/artifact-symbols-replace.patch`
- **Mozilla bug**: none filed.
- **Defect**: with `--enable-artifact-build-symbols`,
  `Artifacts.install_from_file` writes the symbols archive into
  `dist/crashreporter-symbols` and removes nothing. Each binary's files sit
  under a directory named for its build id, so every new Gecko adds a full
  tree beside the previous ones.
- **Evidence**: each Windows CI runner keeps its objdir on a persistent disk.
  After nine days its `dist/crashreporter-symbols` held 33 to 39 trees of
  `xul.pdb`, about 35 GB of a 64 GB disk, and the next artifact install
  failed with `No space left on device`.
- **Upstream**: mozilla-central's `artifacts.py` still installs without
  removing old trees. The patch removes the directory before a symbols
  archive goes in.

### mach keeps every build and test profile it writes

- **Patch**: `patches/mach-logs-capped.patch`
- **Mozilla bug**: none filed.
- **Defect**: `ResourceHandler` writes a resource profile of every test run
  to the state directory's `logs/test`, and `BuildDriver.build` writes a
  warnings file and a profile of every build to `logs/build`. Nothing removes
  them. `_cleanup_old_logs` trims mach's per-command logs to the newest five,
  but only for a command run from a terminal.
- **Evidence**: a Windows CI runner whose objdir persists held 497 test
  profiles, 4.7 GB, after 17 days, the largest 38 MB.
- **Upstream**: the patch calls `_cleanup_old_logs` from both writers.
  mozilla-central's `resourcehandler.py` has the same code.

### about:support never fills in when the free disk space cannot be read

- **Patch**: `patches/troubleshoot-disk-space-unreadable.patch`
- **Mozilla bug**: none filed.
- **Defect**: `Troubleshoot.snapshot` catches a provider's synchronous throw,
  but the `application` provider is async. When `nsIFile.diskSpaceAvailable`
  throws, which it does when `statfs` on the profile's path fails
  (`nsLocalFile::GetDiskInfo`), the rejection goes unhandled, the provider
  never calls back and the snapshot never resolves. about:support, Report
  Broken Site and anything else that awaits the snapshot wait forever.
- **Evidence**: a local run of `browser_sval_removed_pages.js` failed on an
  uncaught `NS_ERROR_FAILURE [nsIFile.diskSpaceAvailable]` from
  `Troubleshoot.sys.mjs` as it opened about:support. The patch reads the
  free space in a try of its own, as the provider reads its other optional
  fields. No test forces `statfs` to fail.
- **Upstream**: the same patch, or a `snapshot` that also catches an async
  provider's rejection. Not submitted.

### A tab moved in from another window and selected can stay blank

- **Patch**: `patches/adopt-tab-selects-before-swap.patch`
- **Mozilla bug**: none filed.
- **Defect**: `adoptTab` with `selectTab` swaps the page into a new
  background tab and then selects it. With no tab switcher running,
  `_swapBrowserDocShells` sets the page inactive, which stops its layers,
  and the selection starts them again in the same turn. When the stop's
  `MozLayerTreeCleared` lands after the switcher has seen the page's layers,
  the switcher ignores it, since `renderLayers` is true, and the page stays
  blank with `renderLayers` true and `hasLayers` false.
- **Evidence**: `browser_sval_agent_on_peeks_and_quick_peeks.js` timed out
  in CI waiting for the moved page's layers, in that state. Read at the
  swap's `EndSwapDocShells`, the page's `renderLayers` is false without the
  patch, every time.
- **Upstream**: the patch selects the new tab before the swap, so the tab
  switcher carries the page's state across (`onSwapDocShells`). Dropping a
  dragged tab into another window takes the same path.

## Backports carried until the pin reaches them

Mozilla has fixed these upstream. They stay listed only so the patch or pref is
dropped on time.

| Patch | Mozilla bug | Drop at |
|---|---|---|
| `backport-bug-2083680-windows-still-opening.patch` | 2083680 | the ESR that carries 7706138007c8 |
| `backport-bug-2064182-artifact-test-patterns.patch` | 2064182 | Firefox 156 |
| `content-classifier-skips-url-classifier.patch` (the `privacy.trackingprotection.urlclassifier.disable_for_channel_classifier` pref and its check) | 2049982 | the first ESR after Firefox 154; Sval's narrowing and the classifiers' order stay |
| `timer-thread-wakeup-window.patch` | 2074584 | Firefox 159 |
| `backport-bug-1705365-nested-cocoa-loop-wakeup.patch` | 1705365 | Firefox 161 |
| `backport-bug-2078831-classifier-generation-under-lock.patch` | 2078831 | Firefox 161 |
| `backport-bug-2056174-unregister-process-actor-in-shutdown.patch` | 2056174 | Firefox 154 |
| `backport-bug-2064718-tab-permission-removal-every-process.patch` | 2064718 | Firefox 156 |
| `backport-bug-2064716-site-permissions-cleared.patch` | 2064716 | Firefox 156 |
| `backport-bug-2083168-theme-after-window-unload.patch` | 2083168 | Firefox 161 |
| `backport-bug-2080226-classifier-client-after-shutdown.patch` | 2080226 | Firefox 161 |
| `backport-bug-2093687-compositor-animations-cleared.patch` | 2093687 | Firefox 162 |
| `backport-bug-2054792-rfp-window-rounding-tests.patch` (with Bug 1710902's change to its two tests) | 2054792 | Firefox 155 |
| `backport-bug-2063670-xpcshell-blocked-test-thread.patch` | 2063670 | Firefox 156 |
| `backport-bug-1933337-mozprocess-returncode-races.patch` (with Bug 1916979's one line) | 1933337 | Firefox 161 |
| `backport-bug-2065184-stackwalk-stdout-and-stderr.patch` | 2065184 | Firefox 156 |
| `backport-bug-1933057-mozcrash-stdout-and-stderr.patch` | 1933057 | Firefox 155 |
| `backport-bug-2065499-quota-usage-underflow.patch` | 2065499 | Firefox 155 |
| `backport-bug-1955841-playback-rate-drift.patch` | 1955841 | Firefox 157 |
| `backport-bug-2064792-native-set-interface-bound.patch` | 2064792 | Firefox 156 |
| `backport-bug-2045119-shared-memory-size-check.patch` | 2045119 | Firefox 155 |
| `backport-bug-1470011-download-content-encoding.patch` | 1470011 | Firefox 154 |
| `network.http.http3.apple_fast_datapath=false` in `app-sval-prefs.js` | 2065491 | Firefox 156 |
| `media.webrtc.send_mlkem_keyshare=false` in `app-sval-prefs.js` | 2047968 | Firefox 158 |
| `backport-bug-2038325-masked-svg-activity.patch` (with Bug 2087421's fix) | 2038325 | Firefox 161 |
| `backport-bug-2068559-offscreen-canvas-hidden.patch` | 2068559 | Firefox 159 |
| `backport-bug-2068103-offscreen-background-decode.patch` | 2068103 | Firefox 161 |
| `backport-bug-1766397-drop-shadow-blur-grid.patch` | 1766397 | Firefox 158 |
| `backport-bug-2063377-rotated-text-subpixel.patch` (with Bug 2072715's fix) | 2063377 | Firefox 158 |
| `backport-bug-2090212-swapchain-pool-cspace.patch` | 2090212 | Firefox 162 |
| `backport-bug-2093090-remote-texture-gone-owner.patch` | 2093090 | Firefox 162 |
| `backport-bug-2093091-image-bridge-ready-check.patch` | 2093091 | Firefox 162 |
| `backport-bug-2085382-wr-error-after-overlay-failure.patch` | 2085382 | Firefox 161 |
| `dom.event.keypress.key.allow_lone_surrogate=false` in `app-sval-prefs.js` | 1849790 | Firefox 154 |
| `apz.axis_lock.mode=2` in `app-sval-prefs.js` | 2035075, 2046884 | Firefox 154 |
| `security.ssl3.ecdhe_ecdsa_aes_256_sha` in `app-sval-prefs.js` | 2052302 | Firefox 154 |
| `backport-bug-1992340-ffdhe-groups-off.patch` | 1992340 | Firefox 156 |
