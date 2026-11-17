/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What the files on the passes Sval runs on its own share. The manifest
 * turns those passes off for every other file
 * (`browser.sval.sync.background.enabled`), so these files are where the tab
 * observer's poll, and the pass it asks the window's own panel for
 * (`_passOnItsOwn`), run as they do in use. Nothing in the window acts
 * between a peer's write and the assertions on it.
 *
 * A peer's file is read in a shared step, which a background pass runs at
 * most every `SHARED_INTERVAL_MS` (`SvalEngine.sys.mjs`), so each file holds
 * one task.
 */

/* import-globals-from head.js */
/* exported SvalEngine, SYNC_DOCUMENT, sharingWithAPeer, shownHere */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SYNC_DOCUMENT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

/**
 * The window's own panel sharing a fresh folder, through Settings' own
 * call, with another device that holds the same sync key and a local key of
 * its own.
 *
 * @param {string} label Distinguishes this task's folders.
 * @returns {Promise<SvalEngine>} the other device's engine.
 */
async function sharingWithAPeer(label) {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.sync.background.enabled", true]],
  });
  await within(SvalPanel.started, 10_000, "the panel starting");
  const { syncKey } = await svalKeys();
  const shared = await makeTempDir(`sval-bg-shared-${label}`);
  const answer = await SvalPanel.chooseSharedFolder(shared);
  registerCleanupFunction(() => SvalPanel.chooseSharedFolder(null));
  Assert.ok(answer.reached, "the window shares the folder");

  const peer = new SvalEngine({
    root: await makeTempDir(`sval-bg-peer-${label}`),
    sharedRoot: shared,
    localKey: crypto.getRandomValues(new Uint8Array(32)),
    syncKey,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => stopEngine(peer));
  // Read before it writes, so the window's watermark is in its file.
  await peer.sync(SYNC_DOCUMENT, Date.now(), { shared: "wait" });
  return peer;
}

/**
 * Resolves once the window's panel has drawn `id` from a pass, which a
 * background pass reaches within a shared step's interval.
 *
 * @param {string} id A node id.
 * @param {string} what
 * @returns {Promise<void>}
 */
function shownHere(id, what) {
  return TestUtils.waitForCondition(
    () => id in (SvalPanel.nodes ?? {}),
    what,
    250,
    160
  );
}
