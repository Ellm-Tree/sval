/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */

/**
 * What the first-run join scenarios share: the other device, already using
 * Sval in a shared folder, and the folder picker that answers with it. Each
 * scenario is a file on a fresh profile of its own, whose first window opens
 * first run at startup; a file loads this after `sval_first_run_helpers.js`.
 */

/* exported theOtherDevice, noOwnWorkspace, continueToEnd */

const MockFilePicker = SpecialPowers.MockFilePicker;
const { HISTORY_INDEX, SvalHistorySync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
);

/** The ad-blocking level the other device chose, which joining brings. */
const THEIR_LEVEL = "strict";

/**
 * Another device, already using Sval in a fresh shared folder: a workspace
 * and an ad-blocking level of its own, and a pairing offer for this device.
 * The folder picker answers with that folder until the file ends.
 *
 * @param {object} [options]
 * @param {string} [options.week] A week of history, from 2020, the other
 *   device has published and listed in its history index.
 * @returns {Promise<object>} `{ shared, theirs, code, offerPath, level,
 *   keyBytes }`, where `keyBytes` is their sync key.
 */
async function theOtherDevice({ week = null } = {}) {
  const shared = await makeTempDir("sval-fr-shared");
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => MockFilePicker.cleanup());
  MockFilePicker.useDirectory(shared);

  const theirKey = crypto.getRandomValues(new Uint8Array(32));
  const them = new SvalEngine({
    root: shared,
    keyBytes: theirKey,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    const theirs = await them.mutate({
      kind: "addWorkspace",
      name: "Theirs",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    await them.addDocument("settings");
    await them.mutate({
      kind: "setSetting",
      document: "settings",
      key: LEVEL_PREF,
      valueJson: JSON.stringify(THEIR_LEVEL),
      now: Date.now(),
    });
    if (week) {
      await them.addDocument(week);
      await them.mutate({
        kind: "addVisit",
        document: week,
        url: "https://example.com/visited",
        title: "Visited",
        visitedAt: Date.UTC(2020, 0, 1),
        transition: 1,
        workspace: null,
      });
      await them.addDocument(HISTORY_INDEX);
      await them.mutate({
        kind: "touchShard",
        document: HISTORY_INDEX,
        name: week,
        now: Date.now(),
      });
    }
    await them.sync(SYNC_DOCUMENT, Date.now());
    await SvalSharedFolder._whenIdle();
    const { code, path } = await SvalPairing.offer(shared, theirKey);
    return {
      shared,
      theirs,
      code,
      offerPath: path,
      level: THEIR_LEVEL,
      keyBytes: theirKey,
    };
  } finally {
    await stopEngine(them);
  }
}

/**
 * Checks, on the join path's code step, that choosing the folder made no
 * workspace of this device's own.
 *
 * @returns {Function} `joinUpToWaiting`'s `atStep`.
 */
function noOwnWorkspace() {
  return async step => {
    if (step === STEPS.joinCode) {
      Assert.deepEqual(
        await workspacesInEngine(),
        [],
        "no workspace of this device's own, with the folder chosen"
      );
    }
  };
}

/**
 * Presses Continue on each step, then Start browsing on the welcome, as a
 * user taking every default does, except that Sval is never made this
 * machine's default browser: its card is answered No, and Continue is
 * pressed only once No is the answer checked. The card's radios carry
 * `String(value)` of its values (`_buildMore` in first-run.js), so No is
 * `"false"`.
 *
 * @param {Document} doc The dialog's document.
 */
async function continueToEnd(doc) {
  for (;;) {
    await settled(doc);
    const from = shownStep(doc);
    const no = shownSection(doc).querySelector(
      'input[data-setting="defaultBrowser"][value="false"]'
    );
    if (no) {
      no.click();
      if (!no.checked) {
        throw new Error("No is not checked for the default browser");
      }
    }
    if (from === STEPS.welcome) {
      await startBrowsing(doc);
      return;
    }
    button(doc, "continue").click();
    let to = from;
    await TestUtils.waitForCondition(() => {
      if (gDialogBox.dialog?._frame?.contentDocument !== doc) {
        return true;
      }
      to = shownStep(doc);
      return to !== from;
    }, `Continue from ${from}`);
    if (gDialogBox.dialog?._frame?.contentDocument !== doc) {
      return;
    }
  }
}
