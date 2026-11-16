# Sval's tests: rules for contributors

Run every test through
`scripts/test.sh`, never `./mach test`. Sval's ESLint plugin
(`chrome/tools/lint/eslint/eslint-plugin-sval`, run by `lint.sh`) enforces
the rules that name one of its rules; its `lib/baseline.mjs` lists
unmigrated files and only shrinks.

## Running

- **One test run at a time across every worktree**, enforced by a lock in the
  shared git directory. Under contention the browser does not go idle in time
  for the harness's `ensureVsyncDisabled`, and runs fail spuriously.
- **To stop a run, signal the script's own PID**; it stops everything the run
  started. Never use `pkill -f`: it also matches other test runs.
  `scripts/test-runner-test.sh`, run by `lint.sh`, checks that a stopped run
  leaves nothing behind. The script warns while a `run.sh` browser is up.
- **Each run has its own temporary directory.** `scripts/test.sh` points
  TMPDIR (TMP and TEMP on Windows, `DIRHELPER_USER_DIR_SUFFIX` on macOS) at a
  fresh directory and removes it when the run ends, however it ends. Tests
  need not remove what they make there; `SvalTestTemp.sys.mjs` gives unique
  paths in it.
- **On macOS the suites run headless.** A headed run raises its window before
  every test (`Tester.nextTest` in `testing/mochitest/browser-test.js`) and
  takes the keyboard; headless Gecko simulates focus
  (`HeadlessWidget::RaiseWindow`). `SvalHeadless.sys.mjs` keeps native menus,
  pickers and notifications off the desktop. `SVAL_TEST_HEADED=1` shows the
  browser; leave the machine alone then, because a background app gets no
  focus and the run stalls.
- **`SVAL_TEST_COVERAGE=<dir>`** leaves the run's JavaScript line coverage in
  `<dir>` as LCOV, one `.info` file per JS runtime, files named by URL or path.
- **A test fails when it stalls, never because it ran long.** The harness
  fails a browser-chrome file that has logged nothing for half its 45 s limit
  when the limit comes round, and lets one that keeps logging run on
  (`mochitest-long-test-not-failed.patch`). Split a test file that is slow
  for its own work, naming each file for what its tasks cover, never `_2`
  (`sval/numbered-name`). `scripts/test.sh` marks a file over 75% of its
  limit as slow, and the daily run files an issue for one slow three runs
  running.

## Waiting and teardown

- **Await every teardown through `head.js`'s helper**
  `stopFixture({ observer, engine })`. Never
  drop `detach()`'s promise or call an engine's `terminate()`
  (`sval/unawaited-detach`, `sval/bare-terminate`).
- **Bound every event wait with `within(promise, ms, what)`**
  (`SvalTestWait.sys.mjs`; head.js binds it for browser tests, an xpcshell
  file imports it). Wait for the thing itself, never for time
  (`sval/unbounded-wait`, `sval/timer-wait`, `sval/frame-wait`,
  `sval/tick-loop`).
- **A cleanup bounds its waits too.** The harness runs a file's
  `registerCleanupFunction` functions after its time limit has stopped
  (`test_finish` in `testing/mochitest/browser-test.js`), so a cleanup that
  never ends is caught only by the run's no-output timeout, minutes later,
  with nothing named (`sval/cleanup-wait`). Undo state through a chrome API
  where one exists, as `ServiceWorkerCleanUp` removes a site's service
  workers, rather than through a page of the site.
- **Wait for the step after an asynchronous one through head.js.** Gecko
  finishes some steps on a later turn, and a check made straight after reads
  the state before. Select a tab with `selectTab(tab)`, and wait for a switch
  something else started with `switchDone(win)` (`sval/tab-switch`). Read a
  node's accessible with `accessibleOf(node)` (`sval/accessible-read`). Read
  an element Fluent translates after `translated(el)`.
- **Wait for the page itself.** A browser has a load's address from its
  commit, before the new document has a body or has run its deferred
  scripts. A test that reads a page waits with `pageReady(browser, url)`, or
  opens it with `openPage(url)`; one that needs the address alone says so
  with `committed(browser, url)` (`sval/address-wait`). A request that takes
  a page away waits for nothing in that page: its actors go with it, and an
  answer may never come.
- **Click inside a window that is on the screen.** Send a native mouse event
  with head.js's `nativeMouse(options)`, which fails on a point off the
  screen or past the window, after `moveWindowOnScreen(win)`
  (`sval/native-input`). Each platform treats a point the window does not
  cover in its own way: Windows moves one off the screen to the screen's
  edge (`SetCursorPos`), and Windows and GTK pass a press in a popup's shadow
  margin to the window below, where macOS gives the popup its whole rect.
  Assert what the user sees happen rather than which element took the press.
  An agent's window opens behind the user's, and where Windows finds a
  window covered its pages tick on a throttled refresh driver
  (`InactiveRefreshDriverTimer`), so a wait on such a page waits for the
  event itself.

## State

- **A test makes the state it needs; it never assumes it.** Every
  browser-chrome file starts from Known Good state, which the browser tests'
  `head.js` makes before the file's own setup: one window with one tab, the
  profile's startup prefs, `SvalPanel` with its own methods on the profile's
  engine, that engine holding the profile's startup document, and one tab
  observer (`SvalTestSlate.sys.mjs` keeps the recording). The engine's files
  in the profile are put back with its document, and the manifests turn off
  the passes Sval runs on its own (`browser.sval.sync.background.enabled`), so
  the document moves only when a test acts; a task about those passes turns
  the pref on itself. Anything more a file or task relies on, it makes itself
  in its own setup, and it never depends on another file having run or
  cleaned up. The same reset runs again when each file ends, and every
  task's tabs and windows are closed when it ends. After every file,
  Mozilla's included, the harness removes the workspaces it left that no
  window shows (`SvalTestLeftovers.sys.mjs`), since a new window would open
  their tabs, and fails the file if it cannot.
- **A test leaves nothing it did not ask for.** A task fails for each tab or
  window left open that it neither opened through `BrowserTestUtils` nor
  declared with `expectOpened` as what the product opened for it to assert
  on. A file fails, through Mozilla's own end-of-file checks, for a window or
  tab its cleanups left, and for a pref still changed once `pushPrefEnv` is
  undone (`scripts/test.sh` passes `--compare-preferences` to a run of Sval's
  own files; Mozilla's suites run without it, as in Mozilla's CI). Set prefs
  with `SpecialPowers.pushPrefEnv`, or put them back in a cleanup.
- **Assert the state the UI is in, never its wording** (`sval/ui-wording`).
  Wording changes with every copy pass. Assert which element or message
  shows, a state or `data-` attribute, hidden or disabled, a Fluent id. When
  a test needs to tell two messages apart and nothing marks them, add a hook
  in the source, such as a `data-` attribute naming the state. Text the user
  typed or Sval fills in, such as a Workspace's name, a count or a key
  spelled for the platform, is data, and a test may check it.
