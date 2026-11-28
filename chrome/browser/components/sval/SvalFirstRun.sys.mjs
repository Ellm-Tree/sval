/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Opens first run (first-run spec §3) in the window's modal dialog
 * (`gDialogBox`), over the dimmed browser, as `SvalNewWorkspace` opens its
 * dialog.
 *
 * The page decides nothing about effects. Every effect is one of the
 * `actions` its caller passes, so the page can be driven with fakes and the
 * panel stays the one owner of the engine, the storage setting and the key.
 */

import { openSvalDialogPage } from "moz-src:///browser/components/sval/SvalDialog.sys.mjs";

const DIALOG_URL = "chrome://browser/content/sval/first-run.xhtml";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * The process's one first run: `{ win, promise, settled }`, or null before any
 * window has started it. Kept once settled, so no window of this process
 * opens it again, whatever the outcome.
 */
let firstRunRun = null;

/**
 * A joining device's pairing that first run left claiming in the background
 * (first-run spec §3.2): `{ stopped }`, or null. Process-wide, because every
 * window's startup leaves the workspace to pairing until it lands (§3.4), and
 * a pairing the user starts anywhere replaces it.
 */
let pairing = null;

/** What runs once {@link pairing} ends: each held window's startup. */
let afterPairing = [];

export const SvalFirstRun = {
  /**
   * Runs `fn` as this process's first run, unless one has already started.
   *
   * The record is made before `fn` runs, so a window that asks while it is in
   * flight finds it. A window other than the one running it waits for it and
   * then goes on with its own startup, which finds the workspace first run
   * left. The running window itself is told so and does not wait: a startup
   * nested inside first run, such as one an adoption runs, would otherwise
   * wait on the flow that is waiting on it. A dialog whose window
   * closes never answers, so the window's closing ends first run for every
   * window waiting on it.
   *
   * @param {Window} win The window asking.
   * @param {Function} fn Runs first run; called at most once per process.
   * @returns {{ran: boolean, nested: boolean, promise: Promise}} `ran` when
   *   this call started it, `nested` when `win` is the window already running
   *   it, and `promise`, which settles when it has ended and never rejects.
   */
  runOnce(win, fn) {
    if (firstRunRun) {
      return {
        ran: false,
        nested: firstRunRun.win === win && !firstRunRun.settled,
        promise: firstRunRun.promise,
      };
    }
    const run = { win, promise: null, settled: false };
    firstRunRun = run;
    const closed = new Promise(resolve =>
      win.addEventListener("unload", resolve, { once: true })
    );
    run.promise = Promise.race([(async () => fn())(), closed])
      .catch(() => {})
      .finally(() => {
        run.settled = true;
      });
    return { ran: true, nested: false, promise: run.promise };
  },

  /** @returns {boolean} Whether this process has started first run. */
  get started() {
    return firstRunRun !== null;
  },

  /** @returns {?{stopped: boolean}} See {@link pairing}. */
  get pairing() {
    return pairing;
  },

  /** @param {?{stopped: boolean}} value The claim first run left, or null. */
  set pairing(value) {
    pairing = value;
  },

  /**
   * Runs `fn` once the pending pairing ends, however it ends.
   *
   * @param {Function} fn A held window's startup.
   */
  afterPairing(fn) {
    afterPairing.push(fn);
  },

  /**
   * Ends `claim`, if it is still the pending pairing, and runs what waited on
   * it. They run on this module's clock: the claim can end from a window that
   * is closing, whose own tasks never run again.
   *
   * @param {object} claim The pairing that ended.
   */
  endPairing(claim) {
    if (pairing !== claim) {
      return;
    }
    pairing = null;
    const waiting = afterPairing;
    afterPairing = [];
    for (const fn of waiting) {
      lazy.setTimeout(fn, 0);
    }
  },

  /**
   * Stops the pairing first run left claiming, because the user has started
   * one of their own.
   */
  stopPairing() {
    if (pairing) {
      pairing.stopped = true;
    }
  },

  /**
   * Shows first run and waits for it to end.
   *
   * `actions.apply(step, answers)` has performed each step's effect by the
   * time its Continue moves on (spec §3.3), and `actions.end` the rest by the
   * time the welcome shows (2026-11-09 spec §4): the held steps, Skip
   * setup's answers and, on the new path, the first workspace. The answers
   * that come back are a record of the flow. On the join path they carry no
   * `search` or `adblock`: those arrive with pairing, and first run never
   * writes them (spec §3.2).
   *
   * @param {Window} win The browser window to show it in.
   * @param {object} options
   * @param {object} options.actions The effects, each returning a promise:
   *   `chooseFolder()`, `useFolder(path)`, `recoverKey()`, `claim(code)`,
   *   `stopClaim()`, `adopt()`, `restore(text)`, `searchEngines()`,
   *   `apply(step, answers)`, `movePanel(side)`, `previewWorkspace(fields)`,
   *   `end({ outcome, answers, completed })`, which answers
   *   `{ importing }`, `runImport(entries, onProgress)`,
   *   `openSyncSettings()`, `signInToKagi(url)`, `kagiSignedIn()` and
   *   `syncedSearch()`.
   * @param {object} options.facts What `SvalFirstRunModel` is told about this
   *   device: `importAvailable`, `isDefaultBrowser`, and `earlier`, the
   *   answers an interrupted first run already applied.
   * @param {object} [options.roots] Where the import step's readers look,
   *   for tests, as `SvalImport.askImport` takes them.
   * @returns {Promise<{outcome: string, answers?: object,
   *   completed?: string[], kagi?: ?{page: ?string}, report?: ?string}>}
   *   `outcome` is `done` or `later`, with the answers, the steps continued
   *   through, `kagi`, set when Kagi was chosen, whose `page` is `signIn`
   *   when its sign-in is to open, and `report`, the context of a report
   *   the user asked to send; or `closed`, with nothing, when the dialog
   *   went away unanswered, which records nothing (spec §8).
   */
  async open(win, { actions, facts, roots }) {
    const args = {
      actions,
      facts: { ...facts },
      roots,
      result: null,
    };
    await openSvalDialogPage(win, DIALOG_URL, args);
    return args.result ?? { outcome: "closed" };
  },
};
