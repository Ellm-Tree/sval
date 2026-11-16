/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the startup test files share: a profile nothing has started on, and
 * new windows that start on it as a launch's windows do. Each file loads this
 * with `loadSubScript` into its own scope.
 */

/* exported SvalEngine, SvalLocalSettings, SvalSharedFolder, freshProfile, answerNameDialog */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);
const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const { useSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);

/**
 * A profile no window has started on, for the rest of the running task:
 * a folder nobody has synced into yet, a settings file of its own, and no
 * engine. Each window `open` opens runs `SvalPanel.init` on it, as a
 * launch's window does, with the real restore and tab observer.
 *
 * Where the profile lives is the one thing a test cannot choose for a window
 * it opens, so `SvalLocalSettings.localRoot` and `profilePath` answer this
 * task's folder and file until the task ends, and `SvalEngine`'s shared
 * instance is forgotten so the first window builds its engine there. The
 * harness's window keeps its own engine, settings and observer throughout,
 * and every window this opened is closed, and its engine stopped, before
 * those are put back. The profile's keys and device id are the harness
 * profile's: `SvalIdentity` keeps them outside the profile folder.
 *
 * @param {object} [options]
 * @param {Function} [options.publish] Called with `{ root, keys }` before any
 *   window starts, so a test can put another device's file in the folder.
 *   `keys` is `svalKeys()`'s answer.
 * @param {string} [options.shared] A shared folder chosen before any window
 *   starts.
 * @param {string} [options.localRoot] The device's own folder, when a task
 *   needs to know its path in advance.
 * @param {object} [options.storedSettings] What the settings file holds before
 *   it is first read, for a task about a file an older build wrote. `shared`
 *   is ignored then.
 * @returns {Promise<object>} `{ root, keys, settings, settingsPath, open,
 *   relaunch }`. `open()` opens a window on the profile and answers it once
 *   its startup is done. `relaunch()` closes every window on the profile,
 *   stops its engine, and opens a window on what the folder holds.
 */
async function freshProfile({
  publish,
  shared,
  localRoot,
  storedSettings,
} = {}) {
  // The last task's startup sweep can still be running, and one helper runs
  // at a time.
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  const root = localRoot ?? tempPath("sval-first-run");
  const settingsPath = tempPath("sval-first-run-settings", ".json");
  await IOUtils.makeDirectory(root);
  if (storedSettings) {
    await IOUtils.writeJSON(settingsPath, storedSettings);
  }
  // `open` answers every caller with one store per path, so the window's
  // `openProfile` gets this one.
  const settings = await SvalLocalSettings.open(settingsPath);
  if (shared && !storedSettings) {
    settings.sharedFolder = shared;
  }
  const keys = await svalKeys();
  if (publish) {
    await publish({ root, keys });
  }

  const harnessEngine = SvalEngine.sharedInstance;
  const real = {
    localRoot: SvalLocalSettings.localRoot,
    profilePath: SvalLocalSettings.profilePath,
  };
  SvalLocalSettings.localRoot = () => root;
  SvalLocalSettings.profilePath = () => settingsPath;
  SvalEngine.setSharedInstance(null);

  const windows = [];
  const engines = new Set();
  const closeAll = async () => {
    for (const win of windows.splice(0)) {
      const observer = win.SvalPanel?.observer;
      // A window the product closed itself fires no further close event.
      if (!win.closed) {
        await within(
          BrowserTestUtils.closeWindow(win),
          10_000,
          "a window on the fresh profile closing"
        );
      }
      // The window's unload detached it; this is its last flush.
      await within(observer?.detach(), 10_000, "the window's last flush");
    }
    for (const engine of engines) {
      await stopEngine(engine);
    }
    engines.clear();
  };
  atTaskEnd(async () => {
    await closeAll();
    SvalEngine.setSharedInstance(harnessEngine);
    Object.assign(SvalLocalSettings, real);
    // The last window to start hands agent control its settings store.
    useSettings(SvalPanel.settings);
  });

  const open = async () => {
    const win = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      20_000,
      "a window on the fresh profile opening"
    );
    windows.push(win);
    expectWorkspaceTabs(win);
    await within(win.SvalPanel.started, 20_000, "the window's startup");
    if (win.SvalPanel.engine) {
      engines.add(win.SvalPanel.engine);
    }
    if (win.SvalPanel.observer) {
      await within(
        win.SvalPanel.observer.settled(),
        10_000,
        "the window's observer filing its tabs"
      );
    }
    return win;
  };
  const relaunch = async () => {
    await closeAll();
    SvalEngine.setSharedInstance(null);
    return open();
  };
  return { root, keys, settings, settingsPath, open, relaunch };
}

/**
 * Types `name` into the dialog `pending` opened in `win` and submits it with
 * Enter, as the user does, then waits for what the dialog's answer started.
 *
 * @param {Window} win
 * @param {Promise} pending The command that opened the dialog.
 * @param {string} field The dialog's name field: `.sval-dialog-input` for a
 *   rename, `.sval-nw-name` for a new group.
 * @param {string} name
 */
async function answerNameDialog(win, pending, field, name) {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = win.gDialogBox.dialog;
    return dialog && !dialog._isClosing;
  }, "a dialog opens");
  await dialogShown(dialog, "the dialog's load");
  const doc = dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector(field),
    `the dialog has drawn ${field}`
  );
  const input = doc.querySelector(field);
  input.value = name;
  input.dispatchEvent(new doc.defaultView.Event("input"));
  input.focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  await within(pending, 10_000, "the command the dialog answered");
}
