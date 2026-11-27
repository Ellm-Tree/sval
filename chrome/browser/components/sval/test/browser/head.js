/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

/* `SvalPanel` is a global of the chrome window, declared by a classic script the
 * window loads rather than by a module this file can import. */
/* import-globals-from ../../sval-panel.js */

/* exported dialogShown, closeDialog, rightClickOpens, chooseMenuItem, AGENT_LABEL, svalKeys, ROOT, PAGE, PAGE2, PAGE2_TITLE, LINKS, ORG_PAGE, NET_PAGE, POST_PATH,
            atTaskEnd,
            countAlerts, alertIn, heldRequests, choose, pair, closeLeftoverDialog,
            openedDialog, clickInDialog,
            agentSetup, agentAccessForTask, agentAccessOff,
            timePassed, tabsOpenedIn, newWindowAfter, strayNodes, refFor,
            closeAndRestore, dialogsSetup, buttonRunning, settledFlag,
            requestsTo, stopped, removeWorkspace, loadPastLayer, makeTempDir,
            tempPath, arcFixture, stopEngine, within, explained,
            stopFixture, expectOpened, expectWorkspaceTabs,
            keepPrefs, panelOnAFolder, openSvalSettings,
            syncFromSettings, closeSvalSettings, contrastRatio, drawnIds,
            favoritesFor, favoritesFixture, withException, showPane, panelIn,
            asPage, videoProbe, canvasProbe, nodes, taggedId, randomBytes,
            failOnConsoleErrors, drawnBehind, paintedOver, switchDone,
            selectTab, accessibleOf, translated, fluentText, committed,
            pageReady, loadState, openPage, moveWindowOnScreen, nativeMouse,
            DOWNLOAD_SJS, agentDownloads, clearPrefBranches, download,
            downloadsSetup, drawnRows, fileTab, filedAt, listedAs, pageRuns,
            restoreFixtureFavorites, rgbaOf, runCommandLine, useUpdateChannel,
            viewingAGroupedTab, writesSetup, chooseNewWorkspace, chooseNewGroup,
            nodeNamed, noOtherBrowsers, keyCopyIn */

const { SvalWindowWorkspace } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs"
);
const { within, explained, waitForCondition } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

/*
 * Every wait in a browser test ends on time (`waitForCondition` in
 * SvalTestWait.sys.mjs), checking every 10 ms. BrowserTestUtils keeps its
 * own reference to Mozilla's (`BrowserTestUtils.waitForCondition` in
 * BrowserTestUtils.sys.mjs), so both names are replaced. Mozilla's own
 * files, which run in the same browser, get Mozilla's back when this file
 * ends.
 */
{
  const realWait = TestUtils.waitForCondition;
  const realBrowserWait = BrowserTestUtils.waitForCondition;
  TestUtils.waitForCondition = waitForCondition;
  BrowserTestUtils.waitForCondition = waitForCondition;
  registerCleanupFunction(() => {
    TestUtils.waitForCondition = realWait;
    BrowserTestUtils.waitForCondition = realBrowserWait;
  });
}

/** The tabs and windows tasks opened through a helper, or declared. */
const taskOpened = new WeakSet();

/**
 * Releases the tabs of every workspace this window has left, as the idle
 * unload does once their time is up (`SvalTabObserver.releaseIdle`).
 *
 * @returns {Promise<void>}
 */
async function releaseHiddenWorkspaces() {
  const observer = window.SvalPanel?.observer;
  if (!observer || observer.detached) {
    return;
  }
  const { HIDDEN_WORKSPACE_UNLOAD_MS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
  );
  const { SvalClock: clock } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalClock.sys.mjs"
  );
  await within(
    observer.releaseIdle(clock.now() + HIDDEN_WORKSPACE_UNLOAD_MS),
    10_000,
    "releasing the workspaces the window left"
  );
}

/**
 * Declares tabs or windows the product opened as the outcome the running
 * task asserts on, so the task's end closes them without failing it. Each
 * tab or window left open that is neither declared nor opened through one
 * of `BrowserTestUtils`'s openers fails the task (see `add_task` below).
 *
 * @param {...(object|Window)} things Tabs, browsers or windows.
 * @returns {object|Window} The first of them.
 */
function expectOpened(...things) {
  for (const thing of things) {
    taskOpened.add(thing);
    const tab = thing?.documentGlobal?.gBrowser?.getTabForBrowser?.(thing);
    if (tab) {
      taskOpened.add(tab);
    }
  }
  return things[0];
}

/** The windows whose workspace tabs tasks expect, see `expectWorkspaceTabs`. */
const workspaceTabWindows = new Set();

/**
 * Declares the tabs Sval opens in `win` for the nodes of the workspaces it
 * shows as what the file's tasks assert on: a switch, or attaching an
 * observer, materialises the workspace's tabs. Each one Sval tagged with its
 * node (`SvalTabs.NODE_ID_KEY`) when a task ends is declared; a tab carrying
 * no node is still one the task did not ask for.
 *
 * @param {Window} [win]
 */
function expectWorkspaceTabs(win = window) {
  workspaceTabWindows.add(win);
}

/*
 * `BrowserTestUtils` as this file's scope sees it, with every opener
 * registering what it opened, or what it waited for the product to open. The
 * harness puts the module's object into each test's scope before loading
 * this file (`Tester_execTest` in browser-test.js), so
 * replacing that property reaches every test and helper loaded into the
 * scope while the module itself, which other code shares, is untouched.
 */
{
  const real = BrowserTestUtils;
  const registers = name => ({
    value(...args) {
      const result = real[name](...args);
      return typeof result?.then === "function"
        ? result.then(expectOpened)
        : expectOpened(result);
    },
  });
  this.BrowserTestUtils = Object.create(
    real,
    Object.fromEntries(
      [
        "addTab",
        "openNewForegroundTab",
        "openNewBrowserWindow",
        "waitForNewTab",
        "waitForNewWindow",
        "domWindowOpened",
        "domWindowOpenedAndLoaded",
      ].map(name => [name, registers(name)])
    )
  );
}

/**
 * Fails the file for every console error logged from now until it ends.
 *
 * Every console error is Sval's to fix, Mozilla's code included, and one that
 * fails no test goes unread. An error reaches the console two ways: a
 * `console.error` call goes to `ConsoleAPIStorage`, and a script error (an
 * uncaught exception, or one a component returns to its native caller) goes
 * to the console service as an `nsIScriptError`; both are read. The check
 * runs among the file's cleanups, after its tasks have closed their windows,
 * so an error a closing window logs is read too; a tick first, because
 * `ConsoleAPIStorage` delivers on the next one.
 */
function failOnConsoleErrors() {
  const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
    Ci.nsIConsoleAPIStorage
  );
  const errors = [];
  const observe = message => {
    if (message.level === "error") {
      errors.push(Array.from(message.arguments ?? [], String).join(" "));
    }
  };
  const scriptErrors = {
    observe(message) {
      if (
        message instanceof Ci.nsIScriptError &&
        !(
          message.flags &
          (Ci.nsIScriptError.warningFlag | Ci.nsIScriptError.infoFlag)
        )
      ) {
        errors.push(`${message.errorMessage} (${message.sourceName})`);
      }
    },
  };
  storage.addLogEventListener(
    observe,
    Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
  );
  Services.console.registerListener(scriptErrors);
  registerCleanupFunction(async () => {
    await TestUtils.waitForTick();
    storage.removeLogEventListener(observe);
    Services.console.unregisterListener(scriptErrors);
    Assert.deepEqual(errors, [], "nothing logged a console error");
  });
}

/** What the running task set up and must take down before the next starts. */
const taskTeardown = [];

/**
 * Tears `fn` down when the running task ends, last registered first, so no
 * task's gate, windows or listeners are still at work in the next one. It
 * runs before the task's windows and tabs are closed, since a teardown may
 * need them.
 *
 * @param {Function} fn
 */
function atTaskEnd(fn) {
  taskTeardown.push(fn);
}

/**
 * Points the directories where import looks for other browsers at an empty
 * folder until the file ends, so no task reads this machine's own browsers
 * and import finds none. The readers take their roots from `Home`,
 * `AppData` and `LocalAppData` (`SvalImportSources.sys.mjs`'s readers), and
 * an empty folder holds none of them. Firefox's own migration tests replace
 * a directory key the same way (`registerFakePath` in
 * browser/components/migration/tests/unit/head_migration.js).
 *
 * @returns {Promise<string>} the empty folder.
 */
async function noOtherBrowsers() {
  const empty = await makeTempDir("sval-no-browsers");
  const dirsvc = Services.dirsvc.QueryInterface(Ci.nsIProperties);
  for (const key of ["Home", "AppData", "LocalAppData"]) {
    let original = null;
    try {
      original = dirsvc.get(key, Ci.nsIFile);
      dirsvc.undefine(key);
    } catch {
      // A key this platform does not define has nothing to put back.
    }
    const fake = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    fake.initWithPath(empty);
    dirsvc.set(key, fake);
    registerCleanupFunction(() => {
      dirsvc.undefine(key);
      if (original) {
        dirsvc.set(key, original);
      }
    });
  }
  return empty;
}

/**
 * Every task in this directory ends with no shared-folder helper alive.
 *
 * At most one helper runs at a time, and a request made while one is alive
 * waits its turn (local-copy spec §4.2). A task that ends as soon as a file
 * is gone from the folder can leave the helper that removed it still exiting,
 * and the next task's first request would spend its own allowance waiting.
 * So each task is followed by a wait for the helper to exit. A helper still
 * alive after one shared step's allowance is a leak: it is killed, and the
 * task that left it fails, as `shared_folder_head.js` does for xpcshell.
 *
 * Every task also ends with the windows and the main window's tabs it began
 * with, so no task tests against what an earlier one opened, and a task
 * need not close what it opened. A window or tab a task opened is closed
 * after the task's own teardown (its `atTaskEnd` calls), which may need it.
 * The main window keeps one tab if the task closed all of those it found,
 * since Firefox replaced the last of them.
 *
 * A stray tab or window is a product bug, and closing it quietly would let
 * the bug pass. So the task fails for each one it did not open through a
 * helper that registers it (`BrowserTestUtils`'s openers, wrapped below) or
 * declared with `expectOpened` as what the product opened for the task to
 * assert on.
 *
 * The harness loads this file into every test's scope before the test itself
 * (`testing/mochitest/browser-test.js`, "Import head.js script if it
 * exists"), so wrapping `add_task` here covers every task.
 */

{
  const { SvalSharedFolder, SHARED_STEP_TIMEOUT_MS } =
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
    );

  /**
   * Resolves once no helper is alive, or with false after `ms`.
   *
   * @param {number} ms How long to wait.
   * @returns {Promise<boolean>} whether the helper slot is free.
   */
  const idleWithin = ms =>
    within(SvalSharedFolder._whenIdle(), ms, "the helper's exit").then(
      () => true,
      () => false
    );

  const settleHelper = async name => {
    if (await idleWithin(SHARED_STEP_TIMEOUT_MS)) {
      return;
    }
    SvalSharedFolder.killLive();
    await idleWithin(5000);
    Assert.ok(
      false,
      `${name} left a shared-folder helper alive for ` +
        `${SHARED_STEP_TIMEOUT_MS} ms after it ended`
    );
  };

  // The windows Mozilla's own end-of-file check looks at
  // (`Tester_checkWindowsState`): every window but the harness's own and the
  // console.
  const windowsNow = () =>
    new Set(
      Array.from(Services.wm.getEnumerator(null)).filter(
        win =>
          !win.closed &&
          win.document.documentElement.id !== "browserTestHarness" &&
          win.document.documentElement.getAttribute("windowtype") !==
            "devtools:webconsole"
      )
    );

  const closeWhatTheTaskOpened = async (name, windows, tabs) => {
    for (const win of workspaceTabWindows) {
      for (const tab of win.closed ? [] : win.gBrowser.tabs) {
        if (taggedId(tab)) {
          taskOpened.add(tab);
        }
      }
    }
    const unasked = (thing, what) => {
      if (!taskOpened.has(thing)) {
        Assert.ok(false, `${name} left ${what} open that it did not open`);
      }
    };
    for (const win of windowsNow()) {
      if (windows.has(win) || win.closed) {
        continue;
      }
      unasked(win, `a window (${win.document.documentURI})`);
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "closing a window the task opened"
      );
    }
    // A workspace switch leaves the tabs of the workspace it left hidden and
    // loaded; they go as the idle unload takes them, keeping their nodes.
    await releaseHiddenWorkspaces();
    // Firefox closes a window whose last visible tab goes
    // (`#isLastTabInWindow`), so the tab kept is a visible one.
    const visible = gBrowser.visibleTabs;
    const keep = visible.some(t => tabs.has(t)) ? null : visible[0];
    for (const tab of Array.from(gBrowser.tabs)) {
      if (!tabs.has(tab) && tab !== keep) {
        unasked(tab, `a tab (${tab.linkedBrowser?.currentURI?.spec})`);
        gBrowser.removeTab(tab, { animate: false, skipSessionStore: true });
      }
    }
  };

  const addTask = add_task.bind(this);
  this.add_task = (properties, func = properties) => {
    const settled = async function () {
      const windows = windowsNow();
      const tabs = new Set(gBrowser.tabs);
      try {
        return await func.call(this);
      } finally {
        // Before the task's own teardown, which may delete what it filed.
        await restoreFixtureFavorites();
        while (taskTeardown.length) {
          try {
            await taskTeardown.pop()();
          } catch (err) {
            Assert.ok(false, `${func.name}'s teardown failed: ${err}`);
          }
        }
        await closeWhatTheTaskOpened(func.name, windows, tabs);
        await settleHelper(func.name);
      }
    };
    Object.defineProperty(settled, "name", { value: func.name });
    return func === properties
      ? addTask(settled)
      : addTask(properties, settled);
  };
}

/**
 * Every browser file starts from Known Good state, made here before the
 * file's own setup runs, and never from whatever the file before it left.
 * The files share one browser, and which file runs before which depends on
 * how CI splits the suite, so a file that relied on its predecessor would
 * pass or fail by its shard. A file that needs more than Known Good state
 * makes it itself, in its own setup.
 *
 * Known Good is the browser as the run's first file found it, recorded once
 * (`SvalTestSlate`):
 * - one browser window, holding one tab;
 * - prefs as the run began, which Mozilla's own check puts back
 *   (`checkPreferencesAfterTest` resets each pref it finds changed);
 * - the window's panel with its own methods, so no stub is left, and with
 *   the data fixtures replace (`PANEL_STATE`) back on the profile's engine
 *   and settings store;
 * - `SvalEngine`'s shared instance, and settings sync and Favorites on that
 *   engine, so no second engine is built over the profile's folder, no
 *   settings pass writes into a fixture's, and every window's Favorites are
 *   the profile's;
 * - the profile's document as it was, so no node a file left behind is
 *   drawn, or reopened as a tab when the window's workspace is shown, and
 *   the engine's files in the profile as they were, so no pass merges one
 *   back in;
 * - one tab observer, attached to the window over that engine.
 *
 * A method is a property whose function is named for its key: a stub
 * assigned to the property has no name, and a bound copy is named
 * "bound …", while a function the panel keeps as data is named otherwise
 * and left alone. The rest of the panel's data is its own bookkeeping, such
 * as the observers it has registered, which the panel keeps true itself and
 * a reset would make false. The observer is attached afresh, never put back: it is attached to
 * the window, so a stale one put back beside one a file attached itself
 * would leave two filing the same tabs.
 *
 * The same reset runs again after the file's last cleanup, two cleanups
 * deep, so after the cleanups that stop a file's observers and engines.
 * That pass leaves windows and tabs, and prefs
 * at both passes, to Mozilla's checks, which run after every cleanup
 * (`Tester_nextTest`):
 * `checkWindowsState` fails the file for a window or tab still open, and
 * `checkPreferencesAfterTest`, under `--compare-preferences`, for a pref
 * left changed once `SpecialPowers.flushPrefEnv` has undone every
 * `pushPrefEnv`. A file's own cleanups must put back what its setup opened
 * or set; the pass at the next file's start still puts back anything a
 * failed file left.
 */
{
  const { SvalEngine, TOP_DIR } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
  );
  const { SvalTabs } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
  );
  const { SvalSettingsSync } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
  );
  const { SvalFavoritesStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
  );
  const { SvalHistorySync } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
  );
  const { SvalDeviceNames } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs"
  );
  const { SvalSession } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSession.sys.mjs"
  );
  // The document modules with one instance for the process, each with what
  // starts it for a panel over an engine. A fixture that starts one on its
  // own engine moves it for every later file, so Known Good puts back the
  // engine each runs over.
  const SHARED_MODULES = [
    [
      SvalSettingsSync,
      (panel, engine) => SvalSession.startSettingsSync(engine, panel._settings),
    ],
    [
      SvalFavoritesStore,
      (panel, engine) => SvalFavoritesStore.startFor(engine),
    ],
    [SvalHistorySync, (panel, engine) => SvalHistorySync.startFor(engine)],
  ];
  const { SvalTestSlate } = ChromeUtils.importESModule(
    "resource://testing-common/SvalTestSlate.sys.mjs"
  );
  /**
   * The panel's data that fixtures replace, and Known Good puts back.
   * `PANEL_CONFIG` is what a fixture swaps in, and is put back whenever it
   * differs. The rest is drawn from the engine the panel is on, so it is put
   * back only when a fixture's engine replaced the profile's: on the
   * profile's own engine it is the panel's live data, which putting back
   * the run's first values would make stale.
   */
  const PANEL_CONFIG = [
    "_settings",
    "_engine",
    "_localRoot",
    "_startRetryWaitMs",
  ];
  const PANEL_STATE = [...PANEL_CONFIG, "_nodes", "_rows", "_focusedId"];
  const methodsOf = panel =>
    new Map(
      Object.entries(panel).filter(
        ([key, value]) => typeof value === "function" && value.name === key
      )
    );
  const browserWindows = () =>
    Array.from(Services.wm.getEnumerator("navigator:browser"));

  /**
   * Every file under `dir`, by its path below it.
   *
   * @param {string} dir
   * @returns {Promise<Map<string, Uint8Array>>}
   */
  async function filesUnder(dir) {
    const files = new Map();
    const walk = async at => {
      for (const child of await IOUtils.getChildren(at, {
        ignoreAbsent: true,
      })) {
        if ((await IOUtils.stat(child)).type === "directory") {
          await walk(child);
        } else {
          files.set(child.slice(dir.length), await IOUtils.read(child));
        }
      }
    };
    await walk(dir);
    return files;
  }
  const sameFiles = (a, b) =>
    a.size === b.size &&
    [...a].every(
      ([path, bytes]) =>
        b.get(path)?.length === bytes.length &&
        b.get(path).every((byte, i) => byte === bytes[i])
    );
  /**
   * Where the profile's engine keeps its files: a pass merges everything
   * there into the document, so a document put back over newer files would
   * take every node a file left behind back at its next pass.
   *
   * @param {SvalEngine|null} engine
   * @returns {string|null}
   */
  const engineFilesOf = engine =>
    engine?.root ? PathUtils.join(engine.root, TOP_DIR) : null;

  // The panel as it was when this head.js loaded, before the file's own code
  // ran. A file may make its state at its top level, outside any setup, as
  // browser_sval_first_run.js stubs `_importAvailable`. Setup runs after
  // that, so what differs from this is the file's own and stays.
  const atLoad =
    window.SvalPanel &&
    new Map([
      ...methodsOf(window.SvalPanel),
      ...PANEL_STATE.map(key => [key, window.SvalPanel[key]]),
    ]);
  const shownAtLoad = SvalWindowWorkspace.of(window).id;

  async function record() {
    const panel = window.SvalPanel;
    // A manifest that turns first run on starts on a profile whose first
    // window opens it, and startup ends only once the file has answered it
    // (`_maybeRunFirstRun`). Such a file is that profile's whole run, so
    // there is no panel state for a later file to be put back to.
    const started = panel && settledFlag(panel.started);
    if (panel) {
      await TestUtils.waitForCondition(
        () => started.settled || panel._firstRunInFlight,
        "the panel's startup, or the first run it opens",
        100,
        400
      );
    }
    if (panel?._firstRunInFlight) {
      SvalTestSlate.baseline = { tab: gBrowser.tabs[0], methods: null };
      return;
    }
    if (panel) {
      await within(panel._started.promise, 40_000, "the panel's startup");
      if (panel._observer && !panel._observer.detached) {
        await within(
          panel._observer.settled(),
          10_000,
          "the window's observer settling"
        );
      }
    }
    SvalTestSlate.baseline = {
      tab: gBrowser.tabs[0],
      tabId: taggedId(gBrowser.tabs[0]),
      methods: panel && methodsOf(panel),
      state: panel && new Map(PANEL_STATE.map(key => [key, panel[key]])),
      shown: SvalWindowWorkspace.of(window).id,
      // A private window's panel draws from its session's tree, which keeps
      // no document of the profile's to snapshot.
      tree:
        typeof panel?._engine?.treeJson === "function"
          ? await panel._engine.treeJson()
          : null,
      files: engineFilesOf(panel?._engine)
        ? await filesUnder(engineFilesOf(panel._engine))
        : null,
      observer: !!panel?._observer && !panel._observer.detached,
      shared: SvalEngine.sharedInstance,
      modules: SHARED_MODULES.map(([module]) => module.shared?.engine ?? null),
      deviceNames: SvalDeviceNames.engine,
    };
  }

  /**
   * Puts back what hears the profile's engine, once the panel is on it
   * again.
   *
   * @param {object} panel The window's `SvalPanel`.
   * @param {object} known The recorded state.
   * @param {boolean} replaced Whether a file had put the panel on a
   *   fixture's engine.
   */
  async function putBackWhatTheEngineFeeds(panel, known, replaced) {
    // A panel hears its engine's steps and passes through the listeners
    // `_listenToEngine` adds, and a fixture's start moves them to the
    // fixture's engine, so they come back with the profile's.
    if (replaced && panel._engine) {
      panel._listenToEngine();
    }
    // Device names are read through one engine for the process, which a
    // fixture's start moves too (`SvalDeviceNames.startFor`).
    if (SvalDeviceNames.engine !== known.deviceNames) {
      await (known.deviceNames
        ? SvalDeviceNames.startFor(known.deviceNames)
        : SvalDeviceNames.stop());
    }
  }

  /**
   * Puts the window's record of the workspace it shows back to the run's,
   * which is drawn from the engine as the rest of the panel's data is. At a
   * file's start, a workspace the file's own top level moved the window to
   * stays.
   *
   * @param {object} known The recorded state.
   * @param {boolean} replaced Whether a fixture's engine replaced the
   *   profile's.
   * @param {boolean} atStart Whether this is a file's start.
   */
  function putBackShownWorkspace(known, replaced, atStart) {
    const workspace = SvalWindowWorkspace.of(window);
    const filesOwn = atStart && workspace.id !== shownAtLoad;
    if (replaced && workspace.id !== known.shown && !filesOwn) {
      workspace.setShown(known.shown);
    }
  }

  /**
   * Switches the window back to the workspace it showed when the run was
   * recorded, if the document put back lacks the one it shows. An observer
   * attached to a workspace the document lacks files the window's tabs under
   * a parent the engine refuses. Called with no observer attached, so the
   * switch moves the window without handing its tabs over.
   *
   * @param {object} panel The window's `SvalPanel`.
   * @param {object} known The recorded state.
   * @param {object} restored The nodes of the document put back.
   */
  async function showRecordedWorkspace(panel, known, restored) {
    if (SvalWindowWorkspace.of(window).id in restored) {
      return;
    }
    await within(
      SvalWindowWorkspace.of(window).switchTo(known.shown),
      10_000,
      "the switch back to the recorded workspace"
    );
  }

  /**
   * Makes the browser Known Good, changing only what differs from it. A
   * reset that restarted what was already right would leave the restart
   * still settling when the file's own setup begins: a fresh tab observer's
   * first flush, or a settings sync pass, landing in the file's first task.
   *
   * @param {boolean} [atStart] Whether the file's own setup is still to run,
   *   so what the file changed at its top level is left as it is.
   */
  async function makeKnownGood(atStart = false) {
    const known = SvalTestSlate.baseline;
    if (!atStart) {
      // Mozilla flushes the file's prefs after its cleanups. Put back here,
      // before settings sync is put back below, no pass writes the restored
      // values into a document while the next file starts.
      await SpecialPowers.flushPrefEnv();
      while (keptPrefs.length) {
        keptPrefs.pop()();
      }
    }
    for (const win of atStart ? browserWindows() : []) {
      if (win !== window && !win.closed) {
        await within(
          BrowserTestUtils.closeWindow(win),
          10_000,
          "closing a window left open"
        );
      }
    }

    const panel = window.SvalPanel;
    const engine = known.state?.get("_engine") ?? null;
    const observerIsRight = () =>
      !!panel?._observer &&
      !panel._observer.detached &&
      panel._observer.engine === engine &&
      panel._observer.window === window;
    if (panel && known.methods && panel._observer && !observerIsRight()) {
      // An observer on a fixture's engine, or a second one, goes before it
      // can file what is closed below.
      if (!panel._observer.detached) {
        await stopFixture({ observer: panel._observer });
      }
      panel._observer = null;
    }

    if (atStart) {
      const keep = gBrowser.tabs.includes(known.tab)
        ? known.tab
        : gBrowser.tabs[0];
      for (const tab of Array.from(gBrowser.tabs)) {
        if (tab !== keep) {
          gBrowser.removeTab(tab, { animate: false, skipSessionStore: true });
        }
      }
    }

    if (!panel || !known.methods) {
      return;
    }
    const replaced =
      panel._engine !== engine ||
      panel._settings !== known.state.get("_settings");
    for (const [key, value] of [...known.methods, ...known.state]) {
      const derived = known.state.has(key) && !PANEL_CONFIG.includes(key);
      const filesOwn = atStart && atLoad && panel[key] !== atLoad.get(key);
      if (panel[key] !== value && (replaced || !derived) && !filesOwn) {
        panel[key] = value;
      }
    }
    putBackShownWorkspace(known, replaced, atStart);
    if (SvalEngine.sharedInstance !== known.shared) {
      SvalEngine.setSharedInstance(known.shared);
    }
    for (const [i, [module, start]] of SHARED_MODULES.entries()) {
      const want = known.modules[i];
      if ((module.shared?.engine ?? null) !== want) {
        await (want ? start(panel, want) : module.stopShared());
      }
    }
    await putBackWhatTheEngineFeeds(panel, known, replaced);
    // A window that began the run with no engine has nothing to load,
    // attach to or draw.
    if (!engine) {
      return;
    }
    Assert.ok(!engine.terminated, "the profile's engine is still running");
    if (observerIsRight()) {
      await within(
        panel._observer.settled(),
        10_000,
        "the window's observer settling"
      );
    }
    // Only the nodes say what the document holds: its write stamps move with
    // every pass.
    const nodesOf = json => JSON.stringify(JSON.parse(json).nodes);
    const filesAt = engineFilesOf(engine);
    const treeIsRight =
      !known.tree || nodesOf(await engine.treeJson()) === nodesOf(known.tree);
    const filesRight = async () =>
      !known.files || sameFiles(await filesUnder(filesAt), known.files);
    if (!treeIsRight || !(await filesRight())) {
      // Nothing may file this window's tabs while the document is replaced.
      if (observerIsRight()) {
        await stopFixture({ observer: panel._observer });
      }
      panel._observer = null;
      // The observer's detach publishes what the engine holds unpublished
      // (`#flushOnDetach` in SvalTabs.sys.mjs), which writes the files, so
      // they are compared once it has stopped.
      if (!(await filesRight())) {
        await IOUtils.remove(filesAt, { recursive: true, ignoreAbsent: true });
        for (const [path, bytes] of known.files) {
          await IOUtils.makeDirectory(PathUtils.parent(filesAt + path));
          await IOUtils.write(filesAt + path, bytes);
        }
      }
      if (known.tree) {
        await engine.loadTree(known.tree);
      }
    }
    if (known.observer && !observerIsRight()) {
      // The window's tabs are tabs of the workspace it shows. A fixture's
      // observer can have filed them into a fixture's document, and the
      // profile's observer, attaching, would close a tab whose node the
      // document lacks as one another device closed.
      const restored = (await engine.tree()).nodes ?? {};
      await showRecordedWorkspace(panel, known, restored);
      const workspace = SvalWindowWorkspace.of(window).id;
      // Mozilla's harness replaces the window's tab before every file
      // (`Tester.nextTest` in browser-test.js). At a file's start the tab in
      // its place stands for the node recorded with the one it replaced, so
      // the document put back holds no tab node that no tab stands for.
      const [only, ...more] = gBrowser.tabs;
      if (
        atStart &&
        known.tabId in restored &&
        !more.length &&
        taggedId(only) !== known.tabId
      ) {
        SessionStore.setCustomTabValue(only, SvalTabs.NODE_ID_KEY, known.tabId);
      }
      if (workspace in restored) {
        for (const tab of gBrowser.tabs) {
          await fileTab(engine, tab, workspace);
        }
      }
      panel._observer = null;
      await panel._attachTabs();
      await panel.refresh();
    }
  }

  add_setup(async function makeKnownGoodState() {
    if (!SvalTestSlate.baseline) {
      await record();
      return;
    }
    await makeKnownGood(true);
  });
  registerCleanupFunction(() =>
    registerCleanupFunction(async () => {
      if (SvalTestSlate.baseline) {
        await makeKnownGood();
      }
    })
  );
}

/**
 * Clears every user value in a pref branch, as `pushPrefEnv`'s `clear`
 * does for one pref: settings sync keeps some choices a pref per entry.
 *
 * @param {...string} branches
 */
function clearPrefBranches(...branches) {
  for (const name of branches.flatMap(b => Services.prefs.getChildList(b))) {
    Services.prefs.clearUserPref(name);
  }
}

/**
 * What `keepPrefs` puts back when the file ends, at Known Good's pass after
 * its cleanups, last kept first so a pref kept twice ends as it was first.
 */
const keptPrefs = [];

/**
 * Puts back, once the file's cleanups are done, the prefs `names` name as
 * the file found them. A name ending in "." stands for every pref under it.
 *
 * For prefs a file changes through the product, which derives other prefs
 * from them. A pref the file sets itself goes through
 * `SpecialPowers.pushPrefEnv`. Mozilla fails the file for a pref left
 * changed (`checkPreferencesAfterTest`), so whatever the product changes,
 * the file names here.
 *
 * @param {...string} names Pref names, or branches ending in ".".
 */
function keepPrefs(...names) {
  const found = new Map();
  for (const name of names) {
    const each = name.endsWith(".")
      ? Services.prefs.getChildList(name)
      : [name];
    for (const pref of each) {
      found.set(
        pref,
        Services.prefs.prefHasUserValue(pref) ? userValueOf(pref) : undefined
      );
    }
  }
  // Twice: putting one back can make Firefox or Sval write another, as a
  // category change records that the user changed it.
  const restore = () => {
    for (let pass = 0; pass < 2; pass++) {
      const now = names.flatMap(name =>
        name.endsWith(".") ? Services.prefs.getChildList(name) : [name]
      );
      for (const pref of new Set([...found.keys(), ...now])) {
        const value = found.get(pref);
        if (value === undefined) {
          Services.prefs.clearUserPref(pref);
        } else {
          setUserValue(pref, value);
        }
      }
    }
  };
  keptPrefs.push(restore);
}

/**
 * @param {string} name A pref with a user value.
 * @returns {boolean|number|string} That value.
 */
function userValueOf(name) {
  switch (Services.prefs.getPrefType(name)) {
    case Ci.nsIPrefBranch.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    case Ci.nsIPrefBranch.PREF_INT:
      return Services.prefs.getIntPref(name);
    default:
      return Services.prefs.getStringPref(name);
  }
}

/**
 * @param {string} name
 * @param {boolean|number|string} value As {@link userValueOf} gives it.
 */
function setUserValue(name, value) {
  if (typeof value === "boolean") {
    Services.prefs.setBoolPref(name, value);
  } else if (typeof value === "number") {
    Services.prefs.setIntPref(name, value);
  } else {
    Services.prefs.setStringPref(name, value);
  }
}

/**
 * Stops a fixture's engine, and settings, Favorites and history sync and
 * device names first when they run over that engine.
 *
 * Settings sync writes every pref change into its engine, and the harness
 * changes prefs between files, and Favorites write their own. A post to a
 * terminated engine does not fail: `BasePromiseWorker` starts a fresh worker
 * for it, holding an empty document, and its pass writes into the engine's
 * folder after the fixture removed it.
 *
 * @param {SvalEngine|null} engine
 * @returns {Promise<void>}
 */
async function stopEngine(engine) {
  if (!engine) {
    return;
  }
  const { SvalSettingsSync } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
  );
  if (SvalSettingsSync.shared?.engine === engine) {
    await SvalSettingsSync.stopShared();
  }
  const { SvalFavoritesStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
  );
  if (SvalFavoritesStore.shared?.engine === engine) {
    await SvalFavoritesStore.stopShared();
  }
  const { SvalHistorySync } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
  );
  if (SvalHistorySync.shared?.engine === engine) {
    await SvalHistorySync.stopShared();
  }
  const { SvalDeviceNames } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs"
  );
  if (SvalDeviceNames.engine === engine) {
    SvalDeviceNames.stop();
  }
  engine.terminate();
}

/**
 * Stops a fixture's tab observer, and then its engine.
 *
 * `detach` hands back the observer's last flush, which writes into the engine
 * and can publish. Awaited, that flush is over before the engine stops, so it
 * cannot start the fresh, empty worker `stopEngine` describes, and before the
 * next task starts, so it cannot write into that task's tabs.
 *
 * @param {object} fixture
 * @param {object} [fixture.observer] A tab observer from `SvalTabs.attach`.
 * @param {SvalEngine} [fixture.engine] The engine it writes into.
 * @returns {Promise<void>}
 */
async function stopFixture({ observer, engine } = {}) {
  await within(observer?.detach(), 10_000, "the observer's last flush");
  await stopEngine(engine);
}

/**
 * Files `tab` into `workspace` in `engine`'s document, unless the document
 * already holds the tab's node. A window attaching to a document that lacks a
 * tagged tab's node closes the tab as one another device closed, so a tab a
 * window keeps across a change of document is filed in the new one first.
 *
 * The engine's refusal of an id in use (`id_in_use`) is the answer to
 * whether the node is there.
 *
 * @param {object} engine A `SvalEngine`.
 * @param {MozTabbrowserTab} tab
 * @param {string} workspace The workspace the window shows.
 */
async function fileTab(engine, tab, workspace) {
  const id = taggedId(tab);
  if (!id) {
    return;
  }
  try {
    await engine.mutate({
      kind: "addTab",
      parent: workspace,
      name: tab.label,
      url: tab.linkedBrowser.currentURI.spec,
      id,
      now: Date.now(),
    });
  } catch (error) {
    if (error.code !== "id_in_use") {
      throw error;
    }
  }
}

/**
 * What the agent test files share: the pages they load, a fresh agent
 * workspace that goes away, with any window opened for it and every node
 * under it, when the test ends, per-task teardown, and the agent alert.
 */

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const PAGE = ROOT + "sval_agent_page.html";
const PAGE2 = ROOT + "sval_agent_page2.html";
/** PAGE2's title. */
const PAGE2_TITLE = "Second page";
const LINKS = ROOT + "sval_agent_links.html";
const ORG_PAGE = PAGE2.replace("://example.com/", "://example.org/");
const NET_PAGE = PAGE2.replace("://example.com/", "://example.net/");
/** The path `requestsTo` watches for the form fixture's posts. */
const POST_PATH = new URL(ROOT + "sval_agent_post.sjs").pathname;

/** The name the test agents pair under, which their alerts show. */
const AGENT_LABEL = "Test Agent";

/**
 * Closes the windows showing workspace `id`, then deletes the workspace with
 * everything in it, as "Delete workspace" does.
 *
 * @param {string} id
 */
async function removeWorkspace(id) {
  for (const win of BrowserWindowTracker.orderedWindows) {
    if (SvalWindowWorkspace.of(win).id === id && win !== window) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the test window closing"
      );
    }
  }
  // A closed window may still delete the workspace it showed, untouched, in
  // its last flush (`holdWhileClosing`), so the workspace is read once every
  // closed window has decided.
  const { closedWindowsDecided } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
  await within(closedWindowsDecided(id), 10_000, "the closed windows' flush");
  if (id in ((await SvalPanel.engine.tree()).nodes ?? {})) {
    await SvalPanel.engine.mutate({ kind: "remove", id });
  }
}

/**
 * Leaves the window in front on a tab inside a group, as a user reading a
 * grouped page has it: a link opened in a new tab from there goes in the
 * group. The tab and the group go when the task ends.
 *
 * @returns {Promise<{workspace: string, group: string}>}
 */
async function viewingAGroupedTab() {
  const workspace = SvalWindowWorkspace.of(window).id;
  const group = await SvalPanel.engine.mutate({
    kind: "addGroup",
    parent: workspace,
    name: "Reading",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await SvalPanel.engine.mutate({ kind: "remove", id: group });
    await SvalPanel.refresh();
  });
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    10_000,
    "a page opening"
  );
  await within(SvalPanel.observer.settled(), 10_000, "the observer settling");
  await SvalPanel.engine.mutate({
    kind: "moveNode",
    id: SvalPanel.observer.nodeIdFor(tab),
    newParent: group,
    before: null,
    after: null,
    now: Date.now(),
  });
  await SvalPanel.refresh();
  atTaskEnd(async () => {
    await BrowserTestUtils.removeTab(tab);
    await within(SvalPanel.observer.settled(), 10_000, "the observer settling");
  });
  Assert.equal(
    await SvalPanel._newTabParent(),
    group,
    "a link opened in a new tab here goes in the group"
  );
  return { workspace, group };
}

/**
 * Where the tab `tab` is filed, once the window is quiet.
 *
 * @param {object} tab A tab of this window's.
 * @returns {Promise<{parent: string, last: boolean}>} its parent, and
 *   whether it ends that parent's list.
 */
async function filedAt(tab) {
  let id;
  await TestUtils.waitForCondition(async () => {
    await within(SvalPanel.observer.settled(), 10_000, "the observer settling");
    id = SvalPanel.observer.nodeIdFor(tab);
    return id && (await nodes(SvalPanel.engine))[id];
  }, "the tab is filed");
  const all = await nodes(SvalPanel.engine);
  const { childrenByParent } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTree.sys.mjs"
  );
  const parent = all[id].placement.parent;
  return { parent, last: childrenByParent(all).get(parent).at(-1) === id };
}

/**
 * Counts the dialogs `win` opens from now on, queued ones included. Each
 * dialog `gDialogBox` shows is a `SubDialog` of its own, which fires
 * `dialogopen` as it draws and again whenever it is measured again
 * (`SubDialog.resizeDialog`), so each dialog is counted once. One that
 * is still loading is `gDialogBox.dialog` already, and one waiting its turn
 * is in `gDialogBox._queued`.
 *
 * @param {Window} win
 * @returns {{opened: number}}
 */
function countAlerts(win) {
  const { gDialogBox } = win;
  const earlier = new Set([gDialogBox.dialog, ...gDialogBox._queued]);
  const drawn = new Set();
  const onOpen = event => drawn.add(event.detail.dialog);
  win.addEventListener("dialogopen", onOpen, true);
  atTaskEnd(() => win.removeEventListener("dialogopen", onOpen, true));
  return {
    get opened() {
      const all = new Set([...drawn, gDialogBox.dialog, ...gDialogBox._queued]);
      return [...all].filter(d => d && !earlier.has(d)).length;
    },
  };
}

/**
 * The requests a write alert lists, each as the data its row carries.
 *
 * @param {Document} doc The alert.
 * @returns {object[]} `{method, target, path}` for each request, and
 *   `{more}` for the count of those it leaves out.
 */
function heldRequests(doc) {
  return [...doc.querySelectorAll("#sval-aa-items li")].map(li => ({
    ...li.dataset,
  }));
}

/**
 * Waits for `dialog`, a `SubDialog`, to be ready for a person's press: sized
 * (`_dialogReady`) and painted. A document's pres shell suppresses painting
 * until its first paint, and a subdocument whose painting is suppressed is
 * left out of hit testing (`GetSubdocumentPresShellForPainting` in
 * nsSubDocumentFrame.cpp), so a press there lands on the dialog's frame.
 *
 * @param {object} dialog A `SubDialog`.
 * @param {string} what Names the dialog's load in a failure.
 */
async function dialogShown(dialog, what) {
  await within(dialog._dialogReady, 10_000, what);
  const win = dialog._frame.contentWindow;
  if (win.windowUtils.paintingSuppressed) {
    await within(
      TestUtils.topicObserved("before-first-paint", doc => doc == win.document),
      10_000,
      `${what}: its first paint`
    );
  }
}

/**
 * Waits for Sval's own dialog (`SvalDialog.sys.mjs`) asking `state` in
 * `win`, and returns its parts.
 *
 * @param {Window} win The browser window it opens in.
 * @param {string} state The dialog's `data-state`, naming its question.
 * @returns {Promise<object>} `{ dialog, doc, form, input, ok, cancel,
 *   warning }`, where `form` is the page's `.sval-dialog`.
 */
async function svalDialogAsking(win, state) {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = win.gDialogBox.dialog;
    return (
      !dialog?._isClosing &&
      dialog?._frame?.contentDocument?.querySelector(
        `.sval-dialog[data-state="${state}"]`
      )
    );
  }, `Sval's dialog asks ${state}`);
  await dialogShown(dialog, `the ${state} dialog's load`);
  const doc = dialog._frame.contentDocument;
  return {
    dialog,
    doc,
    form: doc.querySelector(".sval-dialog"),
    input: doc.querySelector(".sval-dialog-input"),
    ok: doc.querySelector(".sval-dialog-actions .primary"),
    cancel: doc.querySelector('.sval-dialog-actions [data-button="cancel"]'),
    warning: doc.getElementById("sval-dialog-warning"),
  };
}

/**
 * Types `text` into a dialog's field, as the user does, and presses its
 * primary button.
 *
 * @param {object} asked `svalDialogAsking`'s result.
 * @param {string} text
 */
function submitInDialog(asked, text) {
  asked.input.value = text;
  asked.input.dispatchEvent(
    new asked.doc.defaultView.Event("input", { bubbles: true })
  );
  asked.ok.click();
}

/**
 * Waits for `asked`'s dialog to close.
 *
 * @param {Window} win The browser window it opened in.
 * @param {object} asked `svalDialogAsking`'s result.
 * @param {string} what Names the wait in a failure.
 */
async function svalDialogClosed(win, asked, what) {
  await TestUtils.waitForCondition(
    () => win.gDialogBox.dialog !== asked.dialog,
    what
  );
}

/**
 * Closes `dialog`, a page's `<dialog>`, with `act`, and waits for its close
 * event. `close()` drops `open` at once and fires "close" from an
 * `AsyncEventDispatcher` (`HTMLDialogElement::Close`), and the page's close
 * handler is what puts its state back.
 *
 * @param {Element} dialog
 * @param {Function} act Closes it, as the user would.
 * @param {string} what Names the closing in a failure.
 */
async function closeDialog(dialog, act, what) {
  const closed = BrowserTestUtils.waitForEvent(dialog, "close");
  act();
  await within(closed, 10_000, what);
  Assert.ok(!dialog.open, what);
}

/**
 * Waits for the generic alert to draw in `win`.
 *
 * @param {Window} win
 * @returns {Promise<Document>}
 */
async function alertIn(win) {
  // Some alerts follow a page's deliberately slow request, so this waits up
  // to 20s.
  await TestUtils.waitForCondition(
    () => win.gDialogBox.isOpen,
    "alert opens",
    100,
    200
  );
  await dialogShown(win.gDialogBox.dialog, "the alert's load");
  let doc;
  await TestUtils.waitForCondition(() => {
    doc = win.gDialogBox.dialog?._frame.contentDocument;
    return doc?.querySelector(".sval-aa-actions button");
  }, "the alert has drawn");
  return doc;
}

/**
 * Closes the dialogs a failed task left open or waiting, so one failure stays
 * one failure and the harness can shut the window down. `gDialogBox.open`
 * queues a dialog asked for while another is open, and opens it once that one
 * closes, so each closed dialog can make way for the next.
 */
async function closeLeftoverDialog() {
  while (gDialogBox.isOpen || gDialogBox._queued.length) {
    if (!gDialogBox.isOpen) {
      await TestUtils.waitForCondition(
        () => gDialogBox.isOpen || !gDialogBox._queued.length,
        "a dialog left waiting opens"
      );
      continue;
    }
    const dialog = gDialogBox.dialog;
    dialog?._frame?.contentWindow?.close();
    await TestUtils.waitForCondition(
      () => gDialogBox.dialog !== dialog,
      "a dialog left open closes"
    );
  }
}

/**
 * The document of the page `gDialogBox` shows, once a person can see it.
 * `SubDialog` keeps the overlay all but transparent until it has sized the
 * page (`_onContentLoaded`), and `_dialogReady` resolves after that.
 *
 * @param {string} selector Something the page draws once it has started.
 * @returns {Promise<Document>}
 */
async function openedDialog(selector) {
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "the page opens");
  const dialog = gDialogBox.dialog;
  await dialogShown(dialog, "the page's load");
  const doc = dialog._frame.contentDocument;
  Assert.ok(doc.querySelector(selector), "the page has drawn");
  Assert.ok(BrowserTestUtils.isVisible(dialog._frame), "and shows");
  return doc;
}

/**
 * Clicks `el`, in a page `openedDialog` answered, as a person would: once it
 * is drawn, enabled and the first thing under its centre, so the click lands
 * on it.
 *
 * @param {Element} el
 * @param {string} what Names `el` in the assertions.
 */
async function clickInDialog(el, what) {
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(el) && !el.disabled,
    `${what} is shown and enabled`
  );
  const rect = el.getBoundingClientRect();
  const hit = el.ownerDocument.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2
  );
  Assert.ok(hit === el || el.contains(hit), `${what} is in front`);
  // Sent to the browser window over the page's frame, so the window's own
  // hit test finds the target.
  const frame = el.documentGlobal.browsingContext.embedderElement;
  const outer = frame.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  Assert.equal(
    frame.ownerDocument.elementFromPoint(outer.left + x, outer.top + y),
    frame,
    `and the page's frame is in front of the window there`
  );
  EventUtils.synthesizeMouse(frame, x, y, {}, frame.documentGlobal);
}

/**
 * Clicks the choice `id` in the alert `doc` draws, once it can be clicked:
 * every choice but the default waits out the dialog delay.
 *
 * @param {Document} doc
 * @param {string} id
 */
async function choose(doc, id) {
  const button = doc.querySelector(
    `.sval-aa-actions button[data-choice="${id}"]`
  );
  await TestUtils.waitForCondition(() => !button.disabled, `${id} is enabled`);
  button.click();
}

/**
 * Clicks Pair in the pairing alert `doc` draws, once it can be clicked. The
 * alert's content is drawn before `SubDialog` shows it (`dialogShown`). Pair
 * waits out the dialog delay, which `EnableDelayHelper` runs from a timer it
 * starts only while the alert's window is in front, so Pair can still be
 * disabled when the alert has drawn, and a click on it then does nothing.
 *
 * @param {Document} doc
 */
async function pair(doc) {
  const frame = doc.defaultView.browsingContext.embedderElement;
  const dialog = frame.documentGlobal.gDialogBox.dialog;
  Assert.equal(dialog?._frame, frame, "the pairing alert is the open dialog");
  await dialogShown(dialog, "the pairing alert's load");
  const allow = doc.querySelector(".sval-ap-allow");
  await TestUtils.waitForCondition(() => !allow.disabled, "Pair is enabled");
  allow.click();
}

/**
 * Opens `menu` with a right-click on `target`, which the window's own hit
 * test sends to whatever is under the pointer, and waits for it to show.
 *
 * @param {Element} target What is right-clicked.
 * @param {Element} menu The `menupopup` it opens.
 * @returns {Promise<Element>} `menu`, open.
 */
async function rightClickOpens(target, menu) {
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  // A right-click presses the button before the menu opens, and what the
  // press does, such as putting a tab's preview away, comes first. The
  // release would land on the open menu, so it is left out.
  for (const type of ["mousedown", "contextmenu"]) {
    EventUtils.synthesizeMouseAtCenter(
      target,
      { type, button: 2 },
      target.documentGlobal
    );
  }
  await within(shown, 10_000, `${menu.id || "the menu"} showing`);
  return menu;
}

/**
 * Chooses `item` in the open menu `root`, as a click on it does, opening
 * the submenu it is in first as the pointer does, and waits for `root` to
 * close.
 *
 * `XULPopupElement.activateItem` chooses the item in the native menu macOS
 * shows a context menu as, where no synthesized click can land, and in
 * Gecko's own popup elsewhere. It runs a disabled item's command all the
 * same (`XULButtonElement::ExecuteMenu`), so the item is asserted enabled
 * first, as a click would need it to be. The command runs before the menu
 * hides (`nsXULMenuCommandEvent::Run`).
 *
 * @param {Element} item A `menuitem`.
 * @param {Element} root The open `menupopup` the item is in, at any depth.
 * @param {string} what Names the item in the assertions.
 * @returns {Promise<void>}
 */
async function chooseMenuItem(item, root, what) {
  Assert.ok(item && !item.hidden, `${what} is offered and visible`);
  Assert.ok(!item.disabled, `${what} can be chosen`);
  const popup = item.closest("menupopup");
  // Each submenu between `root` and the item, outermost first, opens as a
  // person's pointer opens it on the way in.
  const chain = [];
  for (
    let p = popup;
    p && p !== root;
    p = p.parentElement.closest("menupopup")
  ) {
    chain.unshift(p);
  }
  for (const each of chain) {
    if (each.state !== "open") {
      const shown = BrowserTestUtils.waitForPopupEvent(each, "shown");
      each.parentElement.openMenu(true);
      await within(shown, 10_000, `the submenu holding ${what} showing`);
    }
  }
  // A submenu's popuphidden bubbles to `root` and comes first, while `root`
  // is still open, so only `root`'s own counts.
  const hidden = BrowserTestUtils.waitForEvent(
    root,
    "popuphidden",
    false,
    event => event.target === root
  );
  popup.activateItem(item);
  await within(hidden, 10_000, `the menu closing on ${what}`);
}

/**
 * Chooses the switcher's "New Workspace…", as a person does, leaving its
 * dialog open.
 *
 * @returns {Promise<void>}
 */
async function chooseNewWorkspace() {
  const switcher = SvalPanel._els.switcherMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(switcher, "shown");
  SvalPanel._els.switcher.click();
  await within(shown, 10_000, "the switcher showing");
  await chooseMenuItem(
    switcher.querySelector("[data-sval-new-workspace]"),
    switcher,
    "New Workspace"
  );
}

/**
 * Clicks the panel header's New group, as a person does, leaving its dialog
 * open.
 */
function chooseNewGroup() {
  SvalPanel._els.header.querySelector('[data-command="addGroup"]').click();
}

/**
 * The node named `name`, once the document holds it.
 *
 * @param {string} name
 * @returns {Promise<object>} the node, with its `id`.
 */
async function nodeNamed(name) {
  let found;
  await TestUtils.waitForCondition(async () => {
    const all = (await SvalPanel.engine.tree()).nodes;
    const id = Object.keys(all).find(each => all[each].content?.name === name);
    found = id && { ...all[id], id };
    return found;
  }, `the document holds ${name}`);
  return found;
}

/**
 * @param {Promise} promise
 * @returns {{settled: boolean}} Set once `promise` settles either way.
 */
function settledFlag(promise) {
  const flag = { settled: false };
  promise.then(
    () => (flag.settled = true),
    () => (flag.settled = true)
  );
  return flag;
}

/** The client's handshake version, the one `SvalAgents` speaks. */
const AGENT_HELLO = 3;

/** How long a tool call's reply may take: past a load's own limit. */
const AGENT_REPLY_MS = 180_000;

/** A tool's failure as the agent reads it: its result's `error` and fields. */
class AgentToolError extends Error {
  /**
   * @param {object} body The failed result's JSON.
   * @param {string} body.error Its code.
   * @param {string} [body.message] Its message, which starts with the code.
   */
  constructor({ error, message = "", ...details }) {
    super(
      message.startsWith(`${error}: `)
        ? message.slice(error.length + 2)
        : message
    );
    this.name = "AgentToolError";
    this.code = error;
    this.details = details;
  }
}

/** The agent cancelled a call, which Sval answers with nothing (MCP). */
class AgentCallCancelled extends Error {
  /** @param {string} name The tool's. */
  constructor(name) {
    super(`the agent cancelled ${name}`);
    this.name = "AgentCallCancelled";
  }
}

/** Sval closed the agent's connection before it answered a request. */
class AgentConnectionClosed extends Error {
  /** @param {string} method The request's. */
  constructor(method) {
    super(`Sval closed the connection before answering ${method}`);
    this.name = "AgentConnectionClosed";
  }
}

/** Whether `agentAccessForTask` switched agent access on for this task. */
let agentAccessOfTask = false;

/**
 * Switches agent access back off, when the running task's
 * `agentAccessForTask` switched it on, and waits for the listener to close.
 */
async function endAgentAccessOfTask() {
  if (!agentAccessOfTask) {
    return;
  }
  agentAccessOfTask = false;
  const { SvalAgents } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
  );
  Services.prefs.clearUserPref(SvalAgents.PREF);
  await TestUtils.waitForCondition(
    () => SvalAgents.port === null,
    "agent access closes"
  );
}

/**
 * Turns agent access on for the running task, as Settings › Agents does,
 * unless it is on already, and waits for the listener's port file.
 *
 * @returns {Promise<{port: number, token: string}>} The port file.
 */
async function agentAccessForTask() {
  const { SvalAgents } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
  );
  if (!Services.prefs.getBoolPref(SvalAgents.PREF, false)) {
    Services.prefs.setBoolPref(SvalAgents.PREF, true);
    agentAccessOfTask = true;
    atTaskEnd(endAgentAccessOfTask);
  }
  const file = PathUtils.join(PathUtils.profileDir, "sval-agents", "port.json");
  let read;
  await TestUtils.waitForCondition(async () => {
    read =
      SvalAgents.port !== null &&
      (await IOUtils.exists(file)) &&
      (await IOUtils.readJSON(file));
    return read?.port === SvalAgents.port;
  }, "agent access listens and has written its port file");
  return read;
}

/**
 * Waits until `ms` have passed since `started`, for a task whose subject is
 * a time Sval waits out: the quiet time of an action's window, or how long
 * a call waits for the user.
 *
 * @param {number} started From `performance.now()`.
 * @param {number} ms
 * @param {string} what
 */
async function timePassed(started, ms, what) {
  let said = 0;
  await TestUtils.waitForCondition(
    () => {
      const passed = performance.now() - started;
      // Said every ten seconds, so the harness does not take the wait for
      // a stall (`Tester` in browser-test.js).
      if (passed - said >= 10_000) {
        said = passed;
        info(`${what}: ${Math.round(passed / 1000)} s of ${ms / 1000} s`);
      }
      return passed > ms;
    },
    what,
    100,
    Math.ceil(ms / 100) + 100
  );
}

/**
 * Turns agent access off, as Settings › Agents does, and waits for the
 * listener to close, which closes its gate and page dialog handling.
 */
async function agentAccessOff() {
  const { SvalAgents } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
  );
  Services.prefs.setBoolPref(SvalAgents.PREF, false);
  await TestUtils.waitForCondition(
    () => SvalAgents.port === null,
    "agent access closes"
  );
}

/**
 * Waits for the pairing alert in whichever window it opened, the top one
 * (`askToPair`), and answers it with Pair.
 */
async function pairInAlertAnywhere() {
  const doc = await TestUtils.waitForCondition(() => {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      const d = w.gDialogBox?.dialog?._frame.contentDocument;
      if (d?.querySelector(".sval-ap-allow")) {
        return d;
      }
    }
    return null;
  }, "the pairing alert draws");
  await pair(doc);
}

/**
 * A paired agent, made as Sval makes one: agent access is on, the agent
 * connects to the listener and proves itself as sval-mcp does
 * (`SvalTestAgentClient`), asks to pair, and the user answers the real
 * pairing alert. Every call goes over that connection, through the session's
 * argument check and dispatch to the listener's tools, gate, page dialog
 * handling and Be polite limiter, with their own timings. Its window is
 * already open, so a test can watch that window's alerts from the start.
 *
 * `call` answers a tool's JSON, and rejects with an `AgentToolError` on a
 * failed result. `reply` answers the JSON whether the call failed or not,
 * and `raw` the result as it arrived. `toolNames` answers the names of the
 * tools the agent is given.
 *
 * @param {object} [options]
 * @param {object} [options.sites] Site levels to set before the test.
 * @param {boolean} [options.openWindow] False leaves the agent's window
 *   unopened, as it is for a newly paired agent; `win` and `alerts` are then
 *   null.
 * @param {boolean} [options.isolated] Asks for an isolated workspace, which
 *   the user allows.
 * @returns {Promise<object>}
 */
async function agentSetup({
  sites = {},
  openWindow = true,
  isolated = false,
} = {}) {
  const { SvalAgents } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
  );
  const { SvalTestAgentClient } = ChromeUtils.importESModule(
    "resource://testing-common/SvalTestAgentClient.sys.mjs"
  );
  const { createAgentTabs } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs"
  );
  const { port, token } = await agentAccessForTask();
  const client = await SvalTestAgentClient.connect(port, token);
  client.sendFrame({
    hello: AGENT_HELLO,
    pair: true,
    proof: client.proof,
    launch: {
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      dir: "",
      started: Date.now(),
    },
  });
  await client.waitFor(f => f.ctl?.ready === "unpaired");
  let nextId = 1;
  const request = async (method, params, { id = nextId++, stop } = {}) => {
    client.sendFrame({
      mcp: { jsonrpc: "2.0", id, method, params },
      client: { name: AGENT_LABEL },
    });
    // A call can wait for the user, or for its turn on a site, for longer
    // than the harness lets a test go without output before it calls the
    // test stalled (`Tester` in browser-test.js).
    const started = performance.now();
    const waiting = setInterval(
      () =>
        info(
          `${params?.name ?? method} has waited ${Math.round((performance.now() - started) / 1000)} s`
        ),
      10_000
    );
    const { mcp } = await Promise.race([
      client.waitFor(f => f.mcp?.id === id && !f.mcp.method, AGENT_REPLY_MS),
      client.ended.then(() => {
        throw new AgentConnectionClosed(method);
      }),
      ...(stop ? [stop] : []),
    ]).finally(() => clearInterval(waiting));
    if (mcp.error) {
      throw new Error(`${method} failed: ${mcp.error.message}`);
    }
    return mcp.result;
  };
  const raw = (name, args, meta, options) =>
    request(
      "tools/call",
      {
        name,
        arguments: args,
        ...(meta && { _meta: meta }),
      },
      options
    );
  const bodyOf = result => {
    const body = JSON.parse(result.content[0].text);
    if (result.isError) {
      throw new AgentToolError(body);
    }
    return body;
  };
  const call = async (name, args) => bodyOf(await raw(name, args));
  const toolNames = async () =>
    (await request("tools/list", {})).tools.map(tool => tool.name);
  const reply = async (name, args) =>
    JSON.parse((await raw(name, args)).content[0].text);

  const paired = raw(
    isolated ? "request_isolated_pairing" : "request_shared_pairing",
    { task: AGENT_LABEL }
  );
  await pairInAlertAnywhere();
  const pairing = await paired;
  Assert.ok(!pairing.isError, "the agent pairs");
  const {
    ctl: {
      paired: { agent_id: agentId },
    },
  } = await client.waitFor(f => f.ctl?.paired);
  const store = SvalAgents.store;
  const [{ workspaceId: ws }] = store
    .agents()
    .find(a => a.agentId === agentId).workspaces;
  // The gate and the dialog handling close with agent access before the
  // agent's windows do: with them open, closing an agent's window can
  // outlast `removeWorkspace`'s wait for it.
  atTaskEnd(async () => {
    client.close();
    // Only the open listener's store unpairs (`SvalAgents.unpair`), and a
    // pairing left in the agents file is listed by every later file that
    // turns agent access on, so a task that switched access off has it
    // switched back on to unpair.
    if (!SvalAgents.store) {
      await agentAccessForTask();
    }
    await SvalAgents.unpair(agentId);
    await endAgentAccessOfTask();
    await removeWorkspace(ws);
  });
  for (const [site, level] of Object.entries(sites)) {
    await store.setSiteLevel(agentId, site, level);
  }
  const agent = { agentId, label: AGENT_LABEL, workspaceId: ws };
  const gate = SvalAgents.gate;
  const tabs = createAgentTabs({ engine: SvalPanel.engine, gate });

  /**
   * Calls a tool with a progress token, as a client that shows progress
   * does: it waits for the user's answer as long as they take, and collects
   * the progress Sval sends for it.
   *
   * `cancel` sends `notifications/cancelled` for the call, as a client does
   * when its user stops it: the call stops waiting for the user, gets no
   * reply, and `result` rejects with `AgentCallCancelled`. It resolves once
   * Sval has heard the cancel, which it knows from Sval's answer to a later
   * request: the listener handles one connection's frames in the order they
   * came (`Connection` in SvalAgents.sys.mjs).
   */
  let progressTokens = 0;
  const callWithProgress = (name, args) => {
    const progressToken = `progress-${++progressTokens}`;
    const id = nextId++;
    const cancelled = Promise.withResolvers();
    const progress = [];
    client.onFrame(f => {
      if (
        f.mcp?.method === "notifications/progress" &&
        f.mcp.params?.progressToken === progressToken
      ) {
        progress.push(f.mcp);
      }
    });
    const result = raw(
      name,
      args,
      { progressToken },
      { id, stop: cancelled.promise }
    ).then(bodyOf);
    // A task that cancels the call need not wait for its result.
    result.catch(() => {});
    const cancel = async () => {
      client.sendFrame({
        mcp: {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id },
        },
      });
      await toolNames();
      cancelled.reject(new AgentCallCancelled(name));
    };
    return { result, progress, cancel };
  };
  const made = {
    ws,
    agent,
    store,
    gate,
    dialogs: SvalAgents.dialogs,
    tabs,
    client,
    toolNames,
    call,
    reply,
    raw,
    callWithProgress,
  };
  if (!openWindow) {
    return { ...made, win: null, alerts: null };
  }
  const win = await tabs.windowFor(ws, { open: true });
  const alerts = countAlerts(win);
  return { ...made, win, alerts };
}

/**
 * A paired agent whose tab shows the test page, at `level` on example.com,
 * for the write gate's test files.
 *
 * @param {object} [options]
 * @param {string} [options.level] example.com's level for the agent.
 * @returns {Promise<object>} `agentSetup`'s, with the tab, its browser, and
 *   `ref`, which finds a ref in the tab's first snapshot.
 */
async function writesSetup({ level = "ask-before-writes" } = {}) {
  const setup = await agentSetup({ sites: { "example.com": level } });
  const { call, tabs, agent } = setup;
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = re => snapshot.match(re)[1];
  return { ...setup, tab, browser, ref };
}

/**
 * Collects the browsers of the tabs that open in `win`, in order.
 *
 * @param {Window} win
 * @returns {object[]}
 */
function tabsOpenedIn(win) {
  const opened = [];
  opened.times = [];
  const listener = event => {
    opened.push(event.target.linkedBrowser);
    opened.times.push(performance.now());
  };
  win.gBrowser.tabContainer.addEventListener("TabOpen", listener);
  atTaskEnd(() =>
    win.gBrowser?.tabContainer.removeEventListener("TabOpen", listener)
  );
  return opened;
}

/**
 * Records every tab node written under a workspace other than `agent`'s
 * until the task ends: what the user's synced tree would gain if an agent's
 * content landed outside its workspace, however briefly.
 *
 * @param {object} agent
 * @returns {object[]} `{id, parent}` for each one (`TAB_FILED_TOPIC`), with
 *   `filed`, every tab node written, the agent's included.
 */
function strayNodes(agent) {
  const { TAB_FILED_TOPIC } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
  );
  const strays = [];
  // Not enumerable, so `strays` still compares equal to `[]`.
  Object.defineProperty(strays, "filed", { value: [] });
  const observe = (_subject, _topic, data) => {
    const filed = JSON.parse(data);
    strays.filed.push(filed);
    if (filed.parent !== agent.workspaceId) {
      strays.push(filed);
    }
  };
  Services.obs.addObserver(observe, TAB_FILED_TOPIC);
  atTaskEnd(() => Services.obs.removeObserver(observe, TAB_FILED_TOPIC));
  return strays;
}

/**
 * Runs `action` and waits for the browser window it opens to start its
 * panel.
 *
 * @param {Function} action
 * @returns {Promise<Window>}
 */
async function newWindowAfter(action) {
  const before = new Set(Services.wm.getEnumerator("navigator:browser"));
  await action();
  let found;
  await TestUtils.waitForCondition(() => {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (!before.has(w) && !w.closed) {
        found = w;
      }
    }
    return found;
  }, "a window opens");
  expectOpened(found);
  await TestUtils.waitForCondition(
    () => found.SvalPanel?.initialized,
    "its panel starts"
  );
  // `_initialized` is set as `init` begins, and the tab observer is attached
  // only once the panel's first sync pass is done, which `_started` marks.
  await within(found.SvalPanel.started, 40_000, "its panel's startup");
  return found;
}

/**
 * @param {object} call
 * @param {string} tab
 * @param {RegExp} pattern Matches the line of the element, ref in group 1.
 * @returns {Promise<string>} The element's ref.
 */
async function refFor(call, tab, pattern) {
  const { snapshot } = await call("get_snapshot", { tab });
  const match = snapshot.match(pattern);
  if (!match) {
    throw new Error(`no ${pattern} in the snapshot:\n${snapshot}`);
  }
  return match[1];
}

/**
 * Closes `tab` and brings it back from the window's recently-closed list.
 *
 * @param {Window} win The window `tab` is in.
 * @param {object} tab A tab showing a page, so Firefox keeps it.
 * @returns {Promise<object>} The restored tab, once its window has filed it.
 */
async function closeAndRestore(win, tab) {
  const observer = win.SvalPanel.observer;
  const id = observer.nodeIdFor(tab);
  const closedBefore = SessionStore.getClosedTabCountForWindow(win);
  await BrowserTestUtils.removeTab(tab);
  await within(observer.settled(), 10_000, "the observer settling");
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabCountForWindow(win) > closedBefore,
    "Firefox keeps the closed tab"
  );
  const restored = SessionStore.undoCloseTab(win, 0);
  atTaskEnd(async () => {
    if (!restored.closing && restored.documentGlobal?.gBrowser) {
      await BrowserTestUtils.removeTab(restored);
      const observerThere = restored.documentGlobal.SvalPanel?.observer;
      if (observerThere) {
        await within(observerThere.settled(), 10_000, "the observer settling");
      }
    }
  });
  await TestUtils.waitForCondition(
    async () => (await SvalPanel.engine.tree()).nodes?.[id],
    "the restored tab is filed"
  );
  await within(observer.settled(), 10_000, "the observer settling");
  Assert.equal(observer.nodeIdFor(restored), id, "it is the same node");
  return restored;
}

/**
 * A paired agent whose tab shows the test page, at `full` on example.com
 * unless `level` says otherwise, for the page dialog files.
 *
 * @param {object} [options]
 * @param {string} [options.level] example.com's level for the agent.
 * @returns {Promise<object>} `writesSetup`'s.
 */
function dialogsSetup({ level = "full" } = {}) {
  return writesSetup({ level });
}

/**
 * Adds a button to the page whose click runs `onclick`, and returns its ref
 * from a fresh snapshot.
 *
 * @param {object} setup What `dialogsSetup` returned.
 * @param {Function} setup.call
 * @param {string} setup.tab
 * @param {object} setup.browser
 * @param {string} onclick
 * @returns {Promise<string>}
 */
async function buttonRunning({ call, tab, browser }, onclick) {
  await SpecialPowers.spawn(browser, [onclick], code => {
    const button = content.document.createElement("button");
    button.textContent = "Run it";
    button.setAttribute("onclick", code);
    content.document.body.prepend(button);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  return snapshot.match(/button "Run it" \[(e\d+)\]/)[1];
}

/**
 * Starts loading `url` in `browser` from the window, past the layer over an
 * agent's tab, which refuses the window's own navigation of the tab
 * (`SvalAgentMarking`). For tests of what the gate does with a load whatever
 * started it, such as one the user typed before the layer was up.
 *
 * @param {object} browser
 * @param {string} url
 */
function loadPastLayer(browser, url) {
  const { asAgentLoad } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
  );
  asAgentLoad(() => BrowserTestUtils.startLoadingURIString(browser, url));
}

const DOWNLOAD_SJS = ROOT + "sval_agent_download.sjs";

/**
 * An agent on the test page, with downloads going to a fresh folder.
 *
 * @param {object} [options]
 * @param {string} [options.downloads] example.com's download permission.
 * @returns {Promise<object>}
 */
async function downloadsSetup({ downloads } = {}) {
  const dir = await makeTempDir("sval-agent-downloads");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", dir],
      ["browser.download.folderList", 2],
      ["browser.download.useDownloadDir", true],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  atTaskEnd(async () => {
    for (const download of await list.getAll()) {
      await download.finalize(true).catch(() => {});
      await list.remove(download);
    }
    // The folder stays for scripts/test.sh to remove with the run's
    // temporary directory: on Windows another process, such as a virus
    // scanner, can still hold a file just downloaded, and the folder then
    // cannot be removed.
    await SpecialPowers.popPrefEnv();
  });
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  if (downloads) {
    await setup.store.setFilePermission(
      setup.agent.agentId,
      "downloads",
      "example.com",
      downloads
    );
  }
  const { tab } = await setup.call("open_tab", { url: PAGE });
  const { browser } = await setup.tabs.tabIn(setup.agent, tab);
  return { ...setup, dir, list, tab, browser };
}

/**
 * Has the page in `browser` run `code`, as a click handler would.
 *
 * @param {object} browser
 * @param {string} code
 */
async function pageRuns(browser, code) {
  await SpecialPowers.spawn(browser, [code], c => {
    content.eval(c);
  });
}

/**
 * @param {string} name
 * @returns {string} Code that downloads `name` from the test server.
 */
const download = name =>
  `location.href = ${JSON.stringify(`${DOWNLOAD_SJS}?name=${name}`)};`;

/**
 * @param {Function} call
 * @returns {Promise<object[]>} What `list_downloads` answers.
 */
async function agentDownloads(call) {
  return (await call("list_downloads", {})).downloads;
}

/**
 * Waits until `list_downloads` names `name` in `state`.
 *
 * @param {Function} call
 * @param {string} name
 * @param {string} state
 * @returns {Promise<object>} Its entry.
 */
async function listedAs(call, name, state) {
  let entry;
  await TestUtils.waitForCondition(async () => {
    entry = (await agentDownloads(call)).find(d => d.file_name === name);
    return entry?.state === state;
  }, `${name} is ${state}`);
  return entry;
}

/**
 * Follows the requests to `path` on `host`: how many started, and the
 * status each stopped with, one per channel. A channel cancelled while it
 * starts notifies `http-on-stop-request` twice, so stops are counted by
 * channel. `answered` counts the channels a response came back on, which
 * says a request reached the server whatever status it stops with: a
 * beacon's own listener cancels it once its response starts
 * (`BeaconStreamListener::OnStartRequest`).
 *
 * @param {string} path
 * @param {string} [host]
 * @returns {{started: number, answered: number, stopped: number[], whenStopped: Function}}
 *   `whenStopped(count)` resolves once `count` requests have stopped.
 */
function requestsTo(path, host = "example.com") {
  const stops = new Map();
  const answers = new Set();
  const waiters = [];
  const seen = {
    started: 0,
    get answered() {
      return answers.size;
    },
    get stopped() {
      return [...stops.values()];
    },
    whenStopped(count) {
      if (stops.size >= count) {
        return Promise.resolve();
      }
      const { promise, resolve } = Promise.withResolvers();
      waiters.push({ count, resolve });
      return promise;
    },
  };
  const observer = {
    observe(subject, topic) {
      let channel;
      try {
        channel = subject.QueryInterface(Ci.nsIHttpChannel);
      } catch {
        return;
      }
      if (channel.URI.host !== host || channel.URI.filePath !== path) {
        return;
      }
      if (topic === "http-on-modify-request") {
        seen.started++;
      } else if (topic === "http-on-examine-response") {
        answers.add(channel.channelId);
      } else if (!stops.has(channel.channelId)) {
        stops.set(channel.channelId, channel.status);
        for (const waiter of waiters.filter(w => stops.size >= w.count)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  Services.obs.addObserver(observer, "http-on-examine-response");
  Services.obs.addObserver(observer, "http-on-stop-request");
  atTaskEnd(() => {
    Services.obs.removeObserver(observer, "http-on-modify-request");
    Services.obs.removeObserver(observer, "http-on-examine-response");
    Services.obs.removeObserver(observer, "http-on-stop-request");
  });
  return seen;
}

/**
 * @param {{whenStopped: Function}} seen `requestsTo`'s result.
 * @param {number} count
 */
async function stopped(seen, count = 1) {
  await within(seen.whenStopped(count), 10_000, `${count} request(s) stopped`);
}

/**
 * This profile's two keys, as its panel holds them: the local key its own
 * copy is sealed under, and a sync key, distinct from it, for the shared
 * folder.
 *
 * A profile holds a sync key only once it is set up to share, so a profile
 * without one adopts a fresh key here, as pairing would. The two differ, as
 * they do on every real device, so a copy sealed under the wrong one cannot
 * be read where the right one is needed. A test that writes as this device
 * passes both to its engine; a peer it shares with holds the sync key and a
 * local key of its own. Pairing tests that adopt another key put this
 * profile's sync key back.
 *
 * @returns {Promise<{localKey: Uint8Array, syncKey: Uint8Array}>}
 */
async function svalKeys() {
  const { SvalIdentity: identity } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
  );
  const localKey = await identity.localKey();
  const sync = await identity.syncKey();
  const same = key => key.every((byte, i) => byte === localKey[i]);
  let syncKey;
  if (sync.state === identity.SYNC_KEY_STATES.present && !same(sync.bytes)) {
    syncKey = sync.bytes;
  } else {
    syncKey = crypto.getRandomValues(new Uint8Array(32));
    await identity.adoptSyncKey(syncKey);
  }
  // The panel read the sync key when it started, and its engine holds that
  // key. Allow Access reads it again from the store, as a person's press
  // does, and hands it to the engine.
  const panel = window.SvalPanel;
  const held = panel?.engine?.syncKey;
  if (
    panel?.engine &&
    (panel.syncState.keyState !== identity.SYNC_KEY_STATES.present ||
      held?.length !== syncKey.length ||
      !held.every((byte, i) => byte === syncKey[i]))
  ) {
    await within(panel.run("retrySyncKey"), 30_000, "the panel's key read");
  }
  return { localKey, syncKey };
}

/**
 * Writes an Arc install under a fake home: one Space with an emoji, a folder
 * of two tabs and a loose tab, and one Favorite. Arc's sidebar is plain JSON,
 * which makes it the simplest source to stand up on every platform.
 *
 * @returns {Promise<string>} the fake home.
 */
async function arcFixture() {
  const home = await makeTempDir("sval-import-home");
  const root = PathUtils.join(home, "Library", "Application Support", "Arc");
  await IOUtils.makeDirectory(PathUtils.join(root, "User Data", "Default"), {
    createAncestors: true,
  });
  const tab = (id, parentID, title, url) => [
    id,
    { id, parentID, title, childrenIds: [], data: { tab: { savedURL: url } } },
  ];
  const items = [
    [
      "pinned",
      {
        id: "pinned",
        childrenIds: ["folder", "loose"],
        data: { itemContainer: {} },
      },
    ],
    [
      "unpinned",
      { id: "unpinned", childrenIds: [], data: { itemContainer: {} } },
    ],
    [
      "folder",
      {
        id: "folder",
        parentID: "pinned",
        title: "Reading",
        childrenIds: ["t1", "t2"],
        data: { list: {} },
      },
    ],
    tab("t1", "folder", "One", "https://example.com/one"),
    tab("t2", "folder", "Two", "https://example.com/two"),
    tab("loose", "pinned", "Loose", "https://example.com/loose"),
    ["favs", { id: "favs", childrenIds: ["fav"], data: { itemContainer: {} } }],
    tab("fav", "favs", "Fav", "https://example.com/fav"),
  ].flat();
  await IOUtils.writeJSON(PathUtils.join(root, "StorableSidebar.json"), {
    version: 1,
    sidebar: {
      containers: [
        { global: {} },
        {
          spaces: [
            "space",
            {
              id: "space",
              title: "Home",
              profile: { default: true },
              containerIDs: ["pinned", "pinned", "unpinned", "unpinned"],
              customInfo: { iconType: { emoji_v2: "🏠" } },
            },
          ],
          items,
          topAppsContainerIDs: [{ default: true }, "favs"],
        },
      ],
    },
  });
  return home;
}

/**
 * @returns {Element[]} the panel's rows, in the order they are drawn. A closed
 *   tab's row still fading out is not one.
 */
function drawnRows() {
  return Array.from(
    SvalPanel._els.tree.querySelectorAll(".sval-row:not(.sval-row-leaving)")
  );
}

/**
 * Fails when an open menu shows a separator first, last, or straight after
 * another, which is what a block of entries all hidden would leave.
 *
 * @param {Element} menu An open `menupopup`.
 * @param {string} what The menu, for the assertion's message.
 */
function assertTidySeparators(menu, what) {
  const shown = Array.from(menu.children).filter(el => !el.hidden);
  const separator = el => el?.localName === "menuseparator";
  Assert.ok(shown.length, `${what} shows entries`);
  Assert.ok(!separator(shown[0]), `${what} starts with an entry`);
  Assert.ok(!separator(shown.at(-1)), `${what} ends with an entry`);
  Assert.ok(
    !shown.some((el, i) => separator(el) && separator(shown[i + 1])),
    `${what} shows no two separators together`
  );
}

/** @returns {string[]} the node ids of {@link drawnRows}, in order. */
function drawnIds() {
  return drawnRows().map(row => row.dataset.nodeId);
}

/**
 * The first of `node`'s native anonymous descendants that `matches`, such as
 * a scroll container's scrollbar and its thumb.
 *
 * @param {Node} node
 * @param {Function} matches
 * @returns {Element?}
 */
function nativePart(node, matches) {
  for (const child of InspectorUtils.getChildrenForNode(node, true, false)) {
    if (child.nodeType === Node.ELEMENT_NODE && matches(child)) {
      return child;
    }
    const inner = nativePart(child, matches);
    if (inner) {
      return inner;
    }
  }
  return null;
}

/**
 * The panel's tree, given rows enough to scroll, and scrolled to its top.
 *
 * @returns {Promise<Element>}
 */
async function scrollingTree() {
  const tree = document.querySelector("#sval-panel-container .sval-tree");
  while (tree.scrollHeight <= tree.clientHeight) {
    const tabs = Array.from({ length: 20 }, () =>
      BrowserTestUtils.addTab(gBrowser, "about:blank")
    );
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "the observer filing the new tabs"
    );
    await TestUtils.waitForCondition(() => {
      const ids = drawnIds();
      return tabs.every(tab => ids.includes(SvalPanel.observer.nodeIdFor(tab)));
    }, "the tree draws a row for each new tab");
  }
  tree.scrollTop = 0;
  return tree;
}

/**
 * @param {string} url
 * @returns {object[]} every favorite the process's Favorites hold for `url`.
 */
function favoritesFor(url) {
  const { SvalFavoritesStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
  );
  return SvalFavoritesStore.instance?.favoritesWithUrl(url) ?? [];
}

/** The engine of the file's own Favorites, while `favoritesFixture` has one. */
let favoritesFixtureEngine = null;

/**
 * Favorites of the file's own: the process's Favorites, which every window's
 * menu, favorite button, pins and address bar read, over an engine of its
 * own and empty. The file's cleanup stops them, and Known Good puts the
 * profile's back. A favorite is set up with `store.insertTree`, which Undo
 * does not take back, so a task starts with nothing to undo.
 *
 * A window that opens starts the process's Favorites over the profile's
 * engine (`SvalSession.start`), which stops the file's. So every
 * task's teardown begins with the file's Favorites started again, over the
 * same engine and the favorites it holds ({@link restoreFixtureFavorites}),
 * which a task that opens a window calls too before it files more, and
 * `store` answers for whichever store the process holds.
 *
 * @param {object} [identity] What the engine is made with beyond its own
 *   folder, key and device, as `SvalEngine` takes it: a `sharedRoot` and
 *   `keyBytes` another engine also has, for a file whose Favorites meet
 *   another device's.
 * @returns {Promise<{store: object, engine: object}>}
 */
async function favoritesFixture(identity = {}) {
  const { SvalEngine } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
  );
  const { SvalFavoritesStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
  );
  const engine = new SvalEngine({
    root: await makeTempDir("sval-favorites"),
    keyBytes: randomBytes(32),
    deviceId: randomBytes(16),
    ...identity,
  });
  await within(
    SvalFavoritesStore.startFor(engine),
    10_000,
    "the file's Favorites starting"
  );
  favoritesFixtureEngine = engine;
  registerCleanupFunction(() => {
    favoritesFixtureEngine = null;
    return stopEngine(engine);
  });
  const store = new Proxy(
    {},
    {
      get(_, name) {
        const current = SvalFavoritesStore.instance;
        const value = current?.[name];
        return typeof value === "function" ? value.bind(current) : value;
      },
    }
  );
  return { store, engine };
}

/**
 * Starts the file's Favorites again when something, such as a window
 * opening, has put the profile's in their place.
 *
 * @returns {Promise<void>}
 */
async function restoreFixtureFavorites() {
  const engine = favoritesFixtureEngine;
  if (!engine) {
    return;
  }
  const { SvalFavoritesStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
  );
  if (SvalFavoritesStore.shared?.engine !== engine) {
    await within(
      SvalFavoritesStore.startFor(engine),
      10_000,
      "the file's Favorites starting again"
    );
  }
}

/**
 * Runs `task` while the test pages' site has one fingerprinting exception,
 * set as the Sites card sets it.
 *
 * @param {string} id From `SvalFingerprinting.SITE_EXCEPTIONS`.
 * @param {Function} task
 * @returns {Promise<*>} What `task` returns.
 */
async function withException(id, task) {
  const { SvalSiteProtections } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
  SvalSiteProtections.setExceptions("example.com", [id]);
  try {
    return await task();
  } finally {
    SvalSiteProtections.setExceptions("example.com", []);
  }
}

/** @param {string|object} color As `contrastRatio` takes. */
function rgbaOf(color) {
  return typeof color === "string" ? InspectorUtils.colorToRGBA(color) : color;
}

/**
 * @param {object} engine A `SvalEngine`.
 * @returns {Promise<object>} its document's nodes, by id.
 */
async function nodes(engine) {
  return (await engine.tree()).nodes;
}

/**
 * The node id the session store holds for `tab`, or null, read through
 * `getCustomTabValue`, the API a restored tab's id has to reach.
 *
 * @param {object} tab A Firefox tab.
 * @returns {string|null}
 */
function taggedId(tab) {
  const { SvalTabs } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
  );
  return SessionStore.getCustomTabValue(tab, SvalTabs.NODE_ID_KEY) || null;
}

/**
 * @param {number} length
 * @returns {Uint8Array} `length` random bytes.
 */
function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * @param {Window} [win]
 * @returns {Element} the protection button's panel in `win`.
 */
function panelIn(win = window) {
  return win.document.getElementById("sval-protection-panel");
}

/**
 * Runs `fn` in the page's own global, as the page: a SpecialPowers caller
 * is System, which Sval's gates do not hold back.
 *
 * @param {Element} browser
 * @param {Function} fn Evaluated in the page, so it must stand alone.
 * @param {object} [options]
 * @param {boolean} [options.gesture] Give the page a user activation first.
 * @returns {Promise<*>}
 */
function asPage(browser, fn, { gesture = false } = {}) {
  return within(
    SpecialPowers.spawn(
      browser,
      [fn.toString(), gesture],
      async (src, withGesture) => {
        if (withGesture) {
          content.document.notifyUserGestureActivation();
        }
        return content.wrappedJSObject.eval(`(${src})()`);
      }
    ),
    10_000,
    `the page's ${fn.name}`
  );
}

/**
 * Resolves once `win` has finished its tab switch, if one is under way, and
 * its panel any workspace switch. Tabbrowser switches tabs asynchronously
 * (`AsyncTabSwitcher`): it moves the window's focus to the new tab and
 * dispatches `TabSwitchDone` only once the tab's layers are ready, so until
 * then the window's focus is still moving.
 *
 * @param {Window} [win]
 */
async function switchDone(win = window) {
  // `AsyncTabSwitcher.destroy` clears `_switcher` in the same call that
  // dispatches `TabSwitchDone`.
  await explained(
    TestUtils.waitForCondition(
      () => !win.gBrowser._switcher,
      "the tab switch finishing"
    ),
    () => loadState(win.gBrowser.selectedBrowser)
  );
  await within(
    SvalWindowWorkspace.of(win).switchesSettled(),
    10_000,
    "the workspace switch"
  );
}

/**
 * Selects `tab` in its window, and resolves once the switch to it is done
 * (`switchDone`).
 *
 * @param {Element} tab
 */
async function selectTab(tab) {
  const win = tab.documentGlobal;
  win.gBrowser.selectedTab = tab;
  await switchDone(win);
}

/**
 * The accessible of `node`, once Gecko has made it. An accessible is made
 * on the refresh after its node is inserted or shown
 * (`NotificationController::WillRefresh`), so a node in the DOM can have
 * none yet.
 *
 * @param {Node} node
 * @returns {Promise<nsIAccessible>}
 */
async function accessibleOf(node) {
  const service = Cc["@mozilla.org/accessibilityService;1"].getService(
    Ci.nsIAccessibilityService
  );
  let accessible = null;
  await TestUtils.waitForCondition(
    () => (accessible = service.getAccessibleFor(node)),
    "the node's accessible"
  );
  return accessible;
}

/**
 * Resolves once Fluent has translated `elements` as their `data-l10n-id`
 * says. `document.l10n.setAttributes` sets the id and translates later, so
 * an element's text still reads its last translation until then.
 *
 * @param {...Element} elements Elements of one document.
 */
async function translated(...elements) {
  await within(
    elements[0].ownerDocument.l10n.translateElements(elements),
    10_000,
    "the translation"
  );
}

/**
 * What Fluent says for the message `id` in `resource`, or for one of its
 * attributes, so a test can tell which message an element shows by its id
 * while the words stay free to change.
 *
 * @param {string} resource A Fluent file, such as `sval/launcher.ftl`.
 * @param {string} id
 * @param {object} [options]
 * @param {string} [options.attribute] The attribute's name, such as `label`.
 * @param {object} [options.args] The message's variables.
 * @returns {string|undefined}
 */
function fluentText(resource, id, { attribute, args } = {}) {
  const l10n = new Localization(["branding/brand.ftl", resource], true);
  const [message] = l10n.formatMessagesSync([{ id, args }]);
  return attribute
    ? message?.attributes?.find(a => a.name === attribute)?.value
    : message?.value;
}

/**
 * Resolves once `browser` has committed a load of `url`, for a test that
 * needs the address alone. The page's document can still be empty then:
 * a test that reads the page waits with `pageReady`.
 *
 * @param {Element|Function} browser A `<browser>`, or a function that
 *   returns the one to check each time, for a window or Quick Peek that has none
 *   yet.
 * @param {string|Function} url The address, or a function that takes the
 *   `<browser>` and says whether it has the load waited for, for an address
 *   known only in part, such as an error page's.
 * @param {string} [what] What is waited for, when `url` is a function.
 */
async function committed(browser, url, what = `the tab has ${url}`) {
  const current = typeof browser === "function" ? browser : () => browser;
  const has =
    typeof url === "function"
      ? b => !!b && url(b)
      : b => b?.currentURI?.spec === url;
  await TestUtils.waitForCondition(() => has(current()), what);
}

/**
 * Runs a command line through every `command-line-handler`, in entry order,
 * as a running Sval runs one another process hands it.
 *
 * @param {string[]} args
 * @param {number} [state]
 */
function runCommandLine(args, state = Ci.nsICommandLine.STATE_REMOTE_AUTO) {
  const cmdLine = Cu.createCommandLine(args, null, state);
  const handlers = [
    ...Services.catMan.enumerateCategory("command-line-handler"),
  ].sort((a, b) => (a.entry < b.entry ? -1 : 1));
  for (const { value } of handlers) {
    Cc[value].getService(Ci.nsICommandLineHandler).handle(cmdLine);
  }
}

/**
 * Resolves once `target` shows `url` and its document has loaded, so the
 * page can be read. The address is there from the load's commit
 * (`nsDocShell::CreateDocumentViewer`, through `OnNewURI`), before the new
 * document has a body or has run its deferred scripts. The load is checked
 * in the page itself, which holds whether its load event came before this
 * was called or after, as it does for a page a preloaded browser loaded.
 *
 * @param {Element|BrowsingContext} target A `<browser>`, or a frame's
 *   browsing context.
 * @param {string} url
 */
async function pageReady(target, url) {
  await explained(
    TestUtils.waitForCondition(
      () =>
        (target.browsingContext ?? target)?.currentWindowGlobal?.documentURI
          ?.spec === url,
      `the page shows ${url}`
    ),
    () => loadState(target)
  );
  await explained(
    within(
      SpecialPowers.spawn(target, [url], href =>
        ContentTaskUtils.waitForCondition(
          () =>
            content.document.documentURI === href &&
            content.document.readyState === "complete",
          "the page's load"
        )
      ),
      10_000,
      `${url} loading`
    ),
    () => loadState(target)
  );
}

/**
 * What a failed wait on a page's load reports: where its browser is in the
 * load, in which process, whether it renders, and whether its window is in
 * front.
 *
 * @param {Element|BrowsingContext} target
 * @returns {object}
 */
function loadState(target) {
  const context = target?.browsingContext ?? target;
  const browser = context?.top?.embedderElement ?? target;
  const win = browser?.documentGlobal;
  return {
    currentURI: browser?.currentURI?.spec,
    documentURI: context?.currentWindowGlobal?.documentURI?.spec,
    loading: browser?.webProgress?.isLoadingDocument,
    busy: win?.gBrowser?.getTabForBrowser?.(browser)?.hasAttribute("busy"),
    remoteType: browser?.remoteType,
    pid: context?.currentWindowGlobal?.osPid,
    active: browser?.docShellIsActive,
    renderLayers: browser?.renderLayers,
    hasLayers: browser?.hasLayers,
    hiddenEmbedder: context?.isUnderHiddenEmbedderElement,
    windowState: win?.windowState,
    hidden: win?.document.hidden,
    front: Services.focus.activeWindow === win,
  };
}

/**
 * Opens `url` in a new tab in front, and resolves with the tab once its page
 * has loaded (`pageReady`).
 *
 * @param {string} url
 * @param {Window} [win]
 * @returns {Promise<Element>} the tab.
 */
async function openPage(url, win = window) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url, false),
    10_000,
    `a tab opening ${url}`
  );
  await pageReady(tab.linkedBrowser, url);
  return tab;
}

/**
 * Keeps `win`'s content on the screen until the task ends, moving the window
 * there and putting it back afterwards. An earlier file can leave a window
 * reaching past the screen, and a native mouse event goes to a point on the
 * screen: Windows moves a point off the screen to its edge (`SetCursorPos`),
 * so a part of the window past the screen cannot be clicked.
 *
 * @param {Window} [win]
 */
async function moveWindowOnScreen(win = window) {
  const { screen } = win;
  const onScreenNow = () =>
    win.mozInnerScreenX >= screen.left &&
    win.mozInnerScreenY >= screen.top &&
    win.mozInnerScreenX + win.innerWidth <= screen.left + screen.width &&
    win.mozInnerScreenY + win.innerHeight <= screen.top + screen.height;
  if (onScreenNow()) {
    return;
  }
  const was = {
    x: win.screenX,
    y: win.screenY,
    width: win.outerWidth,
    height: win.outerHeight,
  };
  atTaskEnd(async () => {
    win.resizeTo(was.width, was.height);
    win.moveTo(was.x, was.y);
    await TestUtils.waitForCondition(
      () =>
        win.outerWidth === was.width &&
        win.outerHeight === was.height &&
        win.screenX === was.x &&
        win.screenY === was.y,
      "the window going back"
    );
  });
  win.resizeTo(
    Math.min(win.outerWidth, screen.availWidth),
    Math.min(win.outerHeight, screen.availHeight)
  );
  win.moveTo(screen.availLeft, screen.availTop);
  await TestUtils.waitForCondition(onScreenNow, "the window on the screen");
}

/**
 * Sends a native mouse event at `screenX`, `screenY` through the platform, as
 * `EventUtils.promiseNativeMouseEvent` does, once the point is checked to
 * lie on the screen and over `win`'s content. Off the screen, Windows moves
 * the point to the screen's edge (`SetCursorPos`); past the window, the
 * event goes to whatever is there. Either way it would land where the test
 * did not mean, and the failure would name only what did not happen next.
 * Given `eventTargetToListen`, it resolves once that target hears the event.
 *
 * @param {object} params `EventUtils.synthesizeNativeMouseEvent`'s, with
 *   `screenX` and `screenY`.
 * @param {Window} [params.win] The window the point must be over.
 */
async function nativeMouse({ win = window, ...params }) {
  const { type, screenX: x, screenY: y } = params;
  const { screen } = win;
  Assert.ok(
    x >= screen.left &&
      x < screen.left + screen.width &&
      y >= screen.top &&
      y < screen.top + screen.height,
    `the ${type} at ${x},${y} is on the screen`
  );
  Assert.ok(
    x >= win.mozInnerScreenX &&
      x < win.mozInnerScreenX + win.innerWidth &&
      y >= win.mozInnerScreenY &&
      y < win.mozInnerScreenY + win.innerHeight,
    `and over the window`
  );
  if (params.eventTargetToListen) {
    await within(
      EventUtils.promiseNativeMouseEventAndWaitForEvent({ win, ...params }),
      10_000,
      `the ${type} arriving`
    );
    return;
  }
  await within(
    EventUtils.promiseNativeMouseEvent({ win, ...params }),
    10_000,
    `the ${type} being sent`
  );
}

/**
 * In the page, through `asPage`: whether a new video plays.
 *
 * @returns {Promise<string>} `"resolved"`, or the name of play()'s error.
 */
async function videoProbe() {
  const canvas = document.createElement("canvas");
  canvas.getContext("2d").fillRect(0, 0, 1, 1);
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = canvas.captureStream();
  document.body.append(video);
  // A blocked play() rejects; an allowed one fires `playing`. `asPage`
  // bounds the wait.
  const play = await new Promise(resolve => {
    video.addEventListener("playing", () => resolve("resolved"), {
      once: true,
    });
    video.play().catch(e => resolve(e.name));
  });
  video.remove();
  return play;
}

/**
 * In the page, through `asPage`: how many channels of a canvas read back
 * carry noise.
 *
 * @returns {number}
 */
function canvasProbe() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(200, 40, 40)";
  ctx.fillRect(0, 0, 32, 64);
  ctx.fillStyle = "rgb(40, 40, 200)";
  ctx.fillRect(32, 0, 32, 64);
  const pixels = ctx.getImageData(0, 0, 64, 64).data;
  let noised = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const want = (i / 4) % 64 < 32 ? [200, 40, 40] : [40, 40, 200];
    for (let c = 0; c < 3; c++) {
      if (pixels[i + c] != want[c]) {
        noised++;
      }
    }
  }
  return noised;
}

/**
 * Shows the about:preferences pane `category` in `page`, and resolves once
 * it is shown: `gotoPref` waits for the pane's localization before it
 * reveals the pane (`gotoPref` in preferences.js).
 *
 * @param {Window} page The about:preferences window.
 * @param {string} category A pane, or a pane and subcategory.
 * @returns {Promise<void>}
 */
function showPane(page, category) {
  return within(
    page.gotoPref(category),
    10_000,
    `the ${category} pane showing`
  );
}

/**
 * The contrast ratio between two CSS colours, from 1 to 21, as WCAG 2.2
 * defines it. Text a person has to read needs 4.5 (success criterion 1.4.3).
 *
 * @param {string|object} first A CSS colour, or `InspectorUtils.colorToRGBA`'s
 *   reading of one.
 * @param {string|object} second Another.
 * @returns {number}
 */
function contrastRatio(first, second) {
  const luminance = color => {
    const { r, g, b } = rgbaOf(color);
    const [red, green, blue] = [r, g, b].map(channel => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort(
    (x, y) => y - x
  );
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * What `el` is drawn on: every background from the first opaque ancestor
 * inwards, composited.
 *
 * @param {Element} el
 * @returns {{r: number, g: number, b: number}}
 */
function drawnBehind(el) {
  const layers = [];
  for (let node = el; node; node = node.parentElement) {
    const bg = rgbaOf(getComputedStyle(node).backgroundColor);
    if (bg.a > 0) {
      layers.unshift(bg);
    }
    if (bg.a === 1) {
      break;
    }
  }
  Assert.equal(layers[0]?.a, 1, "something opaque is behind the row");
  return layers
    .slice(1)
    .reduce((under, top) => paintedOver(top, under), layers[0]);
}

/**
 * @param {{r: number, g: number, b: number, a: number}} top
 * @param {{r: number, g: number, b: number}} under
 * @returns {{r: number, g: number, b: number}} `top` drawn on `under`.
 */
function paintedOver(top, under) {
  return {
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
  };
}

// ------------------------------------------------------- Sval's settings page
// Shared by the settings files: browser_sval_settings.js and the
// browser_sval_settings_*.js files beside it.

/**
 * The window's own panel, with a workspace of this task's in its document
 * to lose, shown in the window.
 *
 * The workspace is written through the profile's engine and shown by the
 * window's own switch, whose tabs are declared as the task's
 * (`expectWorkspaceTabs`). The document also holds the profile's startup
 * workspace and what earlier tasks made, so a task asserts on `workspace`.
 * A shared folder this chooses is put back, through `chooseSharedFolder`,
 * when the task ends: the settings store keeps it across files, which Known
 * Good state does not put back. The window goes back to the workspace it
 * showed then too.
 *
 * @param {string} label Distinguishes this task's temporary paths.
 * @param {object} [options]
 * @param {boolean} [options.shared] Choose a temporary directory as the
 *   shared folder and wait for a pass to reach it. Choosing it makes `sval/`
 *   in it. Without it the panel shares nowhere.
 * @returns {Promise<object>} `{ root, folder, settings, engine, workspace,
 *   tab }`: the engine's own location, a maker of further temporary
 *   directories, the window's settings store and engine, and the task's
 *   workspace and its tab.
 */
async function panelOnAFolder(label, { shared = false } = {}) {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const { engine, settings } = SvalPanel;
  const { SvalSharedFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
  );
  const folder = name => makeTempDir(`sval-settings-${name}-${label}`);
  // Sharing needs the sync key, and a pass of this task's may be what the
  // task asserts on, so the key is in place before either. A key adopted
  // here reaches the panel as Allow Access brings one in.
  const { SvalIdentity } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
  );
  const { present } = SvalIdentity.SYNC_KEY_STATES;
  if ((await SvalIdentity.syncKey()).state !== present) {
    await SvalIdentity.adoptSyncKey(crypto.getRandomValues(new Uint8Array(32)));
  }
  if (SvalPanel.syncState.keyState !== present) {
    await within(SvalPanel.run("retrySyncKey"), 30_000, "the key read");
  }

  const before = SvalPanel.sharedRootSetting();
  atTaskEnd(async () => {
    await SvalSharedFolder._whenIdle();
    await within(
      SvalPanel.chooseSharedFolder(before),
      20_000,
      "putting back the shared folder"
    );
  });

  const workspace = await engine.mutate({
    kind: "addWorkspace",
    name: "Kept through a folder change",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  settings.setCollapsed(workspace, false);
  const tab = await engine.mutate({
    kind: "addTab",
    parent: workspace,
    name: "A page",
    url: "https://example.com/kept",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  expectWorkspaceTabs();
  // The window goes back to the workspace it showed. Left on this task's,
  // its tab outlives the task as the window's one visible tab, and at the
  // file's end Known Good attaches the profile's observer to a document
  // that lacks the tab's node, which closes the tab as an orphan while
  // Mozilla's end-of-file check (`checkWindowsState`) removes tabs.
  const shownBefore = SvalWindowWorkspace.of(window).id;
  atTaskEnd(async () => {
    await within(
      SvalWindowWorkspace.of(window).switchTo(shownBefore),
      10_000,
      "the switch back to the workspace shown before"
    );
  });
  Assert.ok(
    await within(
      SvalWindowWorkspace.of(window).switchTo(workspace),
      10_000,
      "the switch to the task's workspace"
    ),
    "the window shows the task's workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the observer filing the switch's tabs"
  );

  if (shared) {
    const sharedRoot = await folder("shared");
    // One helper at a time: a step still winding down answers "busy", so
    // the folder is asked again until a pass reaches it.
    await TestUtils.waitForCondition(async () => {
      await SvalSharedFolder._whenIdle();
      return (
        (await SvalPanel.chooseSharedFolder(sharedRoot)).reached &&
        SvalPanel.syncState.folderState === "reached"
      );
    }, "a pass reached the shared folder");
  }

  return {
    root: engine.root,
    folder,
    settings,
    engine,
    workspace,
    tab,
  };
}

/**
 * Waits for one sealed copy of a sync key in `root`, written and its write
 * finished. A step that reaches the folder starts that write and does not
 * wait for it (`SvalFolderUpkeep`), so a task
 * that changes the folder's files after a step reached it waits here first.
 * The helper writes the copy under a temporary name in the same directory
 * and renames it (`write_atomically` in tools/sval-folder), so only the
 * `.key` name says the copy is there.
 *
 * @param {string} root The shared folder.
 * @param {string} what
 */
async function keyCopyIn(root, what) {
  const { SvalSharedFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
  );
  const keys = PathUtils.join(root, "sval", "keys");
  await TestUtils.waitForCondition(async () => {
    const names = await IOUtils.getChildren(keys, { ignoreAbsent: true });
    return names.length === 1 && names[0].endsWith(".key");
  }, what);
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
}

/**
 * Opens Sval's settings page the way the panel does, and waits for its script
 * to have run.
 *
 * @param {string} [section] `"offer"`, `"claim"` or `"storage"`: which part
 *   of the page gets focus, as the panel's own call names it. None is the
 *   default.
 * @returns {Promise<object>} `{ tab, page, settings, els }`.
 */
async function openSvalSettings(section) {
  const tab = expectOpened(SvalPanel.openSettingsPage(section));
  await TestUtils.waitForCondition(
    () =>
      tab.linkedBrowser.currentURI?.spec.startsWith("about:preferences") &&
      tab.linkedBrowser.contentWindow?.SvalSettings?._els,
    "settings loaded in a tab with Sval's panes"
  );
  const page = tab.linkedBrowser.contentWindow;
  // about:preferences sets up its other panes from an idle callback
  // (`gSearchResultsPane.initializeCategories` in findInPage.js), and the
  // Home pane's settings read the most recent browser window as they are set
  // up. A window the task opens before then has no `gBrowser` yet, and the
  // pane's setting groups are never registered. `categoriesInitialized` is
  // set as the panes' synchronous set-up begins, so once it reads true here
  // that set-up has run.
  if (!page.gSearchResultsPane.categoriesInitialized) {
    await within(
      TestUtils.topicObserved(
        "preferences-MaybeCategoriesInitializedSLOW",
        subject => subject === page
      ),
      10_000,
      "the settings page setting up its panes"
    );
  }
  // A page that has just started sweeps the pairing folder (`SvalSettings.init`),
  // and a task's next request would meet that helper and read the folder as
  // busy. The sweep's last request can answer before its helper exits.
  await within(page.SvalSettings._sweep, 10_000, "the page's pairing sweep");
  await within(
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
    ).SvalSharedFolder._whenIdle(),
    10_000,
    "the sweep's helper exiting"
  );
  const byId = id => page.document.getElementById(id);
  const command = name =>
    page.document.querySelector(
      `#sval-sync-buttons button[data-command="${name}"]`
    );
  return {
    tab,
    page,
    settings: page.SvalSettings,
    els: {
      storage: byId("sval-storage"),
      storageChoose: byId("sval-storage-choose"),
      storageChange: byId("sval-storage-change"),
      storageStop: byId("sval-storage-stop"),
      storageStatus: byId("sval-storage-status"),
      storageResultActions: byId("sval-storage-result-actions"),
      folderField: byId("sval-folder-field"),
      folderPath: byId("sval-folder-path"),
      folderReveal: byId("sval-folder-reveal"),
      syncButtons: byId("sval-sync-buttons"),
      syncState: byId("sval-sync-state"),
      syncLast: byId("sval-sync-last"),
      syncStatus: byId("sval-sync-status"),
      heading: byId("sval-settings-heading"),
      // The Sync card draws its buttons for the state it is in, so these
      // are found as they are asked for.
      get syncNow() {
        return command("syncNow");
      },
      get storageReuse() {
        return command("useFolderAgain");
      },
    },
    /** The Sync card's button running `name`, or null. */
    command,
    /** The page state the Sync card shows (`SvalPanelModel.syncPage`). */
    get state() {
      return byId("sval-storage").dataset.state;
    },
  };
}

/** Every part of the Sync and devices page whose showing depends on state. */
const SYNC_PAGE_PARTS = [
  "sval-location-choices",
  "sval-folder-field",
  "sval-folder-reveal",
  "sval-storage-change",
  "sval-storage-stop",
  "sval-backup-missing",
  "sval-storage-working",
  "sval-pairing-start",
  "sval-path-offer-steps",
  "sval-sync-advanced",
];

/**
 * Asserts that the Sync and devices page shows only its state's parts and
 * buttons, and that no two of its parts disagree: the Sync card's state is
 * the footer's, and a line under it was written in that state.
 *
 * @param {object} ui `openSvalSettings`'s or `openSettings`'s result: what
 *   is read is its `page`.
 * @param {object} expected
 * @param {?string} expected.primary The primary button's command, or null.
 * @param {string[]} [expected.secondary] The other buttons' commands.
 * @param {string[]} expected.shown The ids of `SYNC_PAGE_PARTS` that show.
 */
function assertOnlyPageControls(ui, { primary, secondary = [], shown }) {
  const doc = ui.page.document;
  const settings = ui.page.SvalSettings;
  const state = doc.getElementById("sval-storage").dataset.state;
  const status = doc.getElementById("sval-storage-status");
  Assert.deepEqual(
    SYNC_PAGE_PARTS.filter(id =>
      BrowserTestUtils.isVisible(doc.getElementById(id))
    ),
    SYNC_PAGE_PARTS.filter(id => shown.includes(id)),
    `${state} shows only its own parts`
  );
  const buttons = [
    ...doc.getElementById("sval-sync-buttons").querySelectorAll("button"),
  ];
  Assert.deepEqual(
    buttons.map(button => button.dataset.command),
    [primary, ...secondary].filter(Boolean),
    `and its own buttons`
  );
  const card = doc.getElementById("sval-storage");
  Assert.equal(
    card.querySelectorAll(".sval-button-primary").length,
    primary ? 1 : 0,
    "with one primary at most"
  );
  // The state, its buttons and Stop Syncing are one row, primary first and
  // Stop Syncing last.
  const row = doc.getElementById("sval-sync-state");
  const stop = doc.getElementById("sval-storage-stop");
  const inRow = [...row.querySelectorAll("button")].filter(button =>
    BrowserTestUtils.isVisible(button)
  );
  Assert.deepEqual(
    inRow.map(button => button.dataset.command),
    [primary, ...secondary, shown.includes(stop.id) ? "stop" : null].filter(
      Boolean
    ),
    "in the state's row"
  );
  if (primary) {
    Assert.ok(
      inRow[0].classList.contains("sval-button-primary"),
      "the primary first"
    );
  }
  const footer = settings.panel?.syncIndicator();
  if (footer && settings._page.location) {
    Assert.equal(state, footer.state, "saying what the footer says");
  }
  Assert.ok(
    !status.textContent || settings._statusState === settings._page.scope,
    "beside no line from another state"
  );
}

/**
 * Moves the start of the folder outage in progress back past the wait the
 * footer gives one before it shows (decision 0032), as three minutes of it
 * would, and has every window and page redraw for it.
 */
function outageWaitedOut() {
  const { FOLDER_UNAVAILABLE_AFTER_MS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
  const state = SvalPanel.syncState;
  Assert.notEqual(state.unreachableSince, null, "the folder is away");
  state.unreachableSince -= FOLDER_UNAVAILABLE_AFTER_MS;
  SvalPanel._drawSyncState();
}

/**
 * Presses the page's "Sync now", or the Try again a folder that can't be
 * reached offers in its place, and waits for the pass to have come back.
 * The page holds its outcome while the pass runs.
 *
 * @param {object} ui `openSvalSettings`'s result.
 */
async function syncFromSettings(ui) {
  await TestUtils.waitForCondition(
    () => ui.els.syncNow && !ui.els.syncNow.disabled,
    "the page offers a pass"
  );
  ui.els.syncNow.click();
  await TestUtils.waitForCondition(
    () => !ui.settings._syncOutcome,
    "the pass the page asked for came back"
  );
}

/**
 * Closes a settings tab, so the next `openSvalSettings` is a fresh page.
 *
 * @param {object} ui `openSvalSettings`'s result.
 * @returns {Promise<void>} Settles once the tab is gone.
 */
function closeSvalSettings(ui) {
  return BrowserTestUtils.removeTab(ui.tab);
}

/** The update channel this file found, which `useUpdateChannel` restores. */
let gOriginalUpdateChannel = null;

/**
 * Puts this build on update channel `channel` until the file ends. The
 * channel is a default pref, locked on macOS, where Gecko reads it from the
 * app's ChannelPrefs framework; Mozilla's own update tests unlock it the same
 * way (`setUpdateChannel`).
 *
 * @param {string} channel Such as `"release"`.
 */
function useUpdateChannel(channel) {
  const defaults = Services.prefs.getDefaultBranch("");
  if (!gOriginalUpdateChannel) {
    gOriginalUpdateChannel = {
      value: defaults.getCharPref("app.update.channel"),
      locked: Services.prefs.prefIsLocked("app.update.channel"),
    };
    registerCleanupFunction(() => {
      const { value, locked } = gOriginalUpdateChannel;
      defaults.setCharPref("app.update.channel", value);
      if (locked) {
        defaults.lockPref("app.update.channel");
      }
      gOriginalUpdateChannel = null;
    });
  }
  defaults.unlockPref("app.update.channel");
  defaults.setCharPref("app.update.channel", channel);
}

/**
 * Has the next step that reaches the shared folder look for another key's
 * workspaces, and forgets what the last look found, so a task can wait for
 * `syncState.otherWorkspacesIn` to name the folder again. The profile looks
 * at most once per `SvalFolderUpkeep.OTHER_WORKSPACES_CHECK_MS`.
 *
 * @param {object} [panel] A window's `SvalPanel`.
 */
function lookForOtherWorkspacesAgain(panel = SvalPanel) {
  const { SvalFolderUpkeep } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFolderUpkeep.sys.mjs"
  );
  panel.syncState.setOtherWorkspaces([], null);
  SvalFolderUpkeep.of(panel.engine).lookAgain();
}

/**
 * Keeps `win` visible to its page whatever else is on the desktop, as a peek
 * the user has in front is. A window another covers is hidden to its page,
 * and its refresh driver is throttled, so its panels take seconds to open and
 * close. A test cannot raise a window over other apps' windows on every
 * desktop: Windows raises a focused window only while its app is in the
 * foreground (`nsWindow::SetFocus` calls `::SetFocus` alone), and on a CI
 * desktop the runner's own terminal holds the foreground and can cover the
 * peek. `forceAppWindowActive` is Gecko's own way to keep an app window
 * active while it is covered, which Picture-in-Picture uses.
 *
 * @param {Window} win A browser window.
 */
async function uncovered(win) {
  const context = win.browsingContext;
  context.forceAppWindowActive = true;
  atTaskEnd(() => {
    if (!context.isDiscarded) {
      context.forceAppWindowActive = false;
    }
  });
  await TestUtils.waitForCondition(
    () => !win.document.hidden,
    "the window's page can see it"
  );
}

/**
 * @param {string} spec A chrome:, resource: or moz-src: address.
 * @returns {boolean} whether the package holds a file at it. Opening a
 *   missing one is no way to ask: under automation Gecko crashes on it
 *   (`CheckForBrokenChromeURL`).
 */
function packaged(spec) {
  let uri = Services.io.newURI(spec);
  // An override maps a chrome: address to another one.
  while (uri.schemeIs("chrome")) {
    uri = Cc["@mozilla.org/chrome/chrome-registry;1"]
      .getService(Ci.nsIChromeRegistry)
      .convertChromeURL(uri);
  }
  if (uri.schemeIs("resource") || uri.schemeIs("moz-src")) {
    uri = Services.io.newURI(
      Services.io
        .getProtocolHandler(uri.scheme)
        .QueryInterface(Ci.nsISubstitutingProtocolHandler)
        .resolveURI(uri)
    );
  }
  if (uri instanceof Ci.nsIJARURI) {
    const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
      Ci.nsIZipReader
    );
    reader.open(uri.JARFile.QueryInterface(Ci.nsIFileURL).file);
    try {
      return reader.hasEntry(uri.JAREntry);
    } finally {
      reader.close();
    }
  }
  return uri.QueryInterface(Ci.nsIFileURL).file.exists();
}
