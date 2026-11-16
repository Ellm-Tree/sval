/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Removes, after every browser-chrome file, each workspace the file left
 * behind. The harness calls {@link SvalTestLeftovers.runStarts} before the
 * first file and {@link SvalTestLeftovers.afterFile} at the end of each
 * (`Tester.nextTest`, `mochitest-files-start-without-leftovers.patch`), so
 * Mozilla's files get it as well as Sval's. A file that opens a window after
 * closing one it browsed in calls {@link SvalTestLeftovers.beforeFile} before
 * that window as well (`sessionstore-test-windows-without-leftovers.patch`).
 *
 * A removal that fails fails the file that ended, before the harness logs its
 * end: every file after it starts outside Known Good state, and the file that
 * left the state is the one a retry should run again.
 *
 * A window takes a workspace no other window shows and opens that
 * workspace's tabs (spec §10.7, decision 0079), and closing a window keeps
 * its workspace once a page was browsed in it (decision 0101). A workspace
 * an earlier file browsed in therefore outlives that file, and the next
 * window any file opens takes it and opens its tabs beside the ones the file
 * put there. Mozilla's tests count a new window's tabs on the premise that a
 * new window brings none of its own.
 *
 * What stays is every workspace the document held when the run's first file
 * started, and every workspace a window shows. Sval's own files are also put
 * in Known Good state by their head.js (`SvalTestSlate`).
 */

import { SvalEngine } from "moz-src:///browser/components/sval/SvalEngine.sys.mjs";
import { workspaceIds } from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import {
  waitForCondition,
  within,
} from "resource://testing-common/SvalTestWait.sys.mjs";

/** The workspaces the document held as the run's first file started. */
let atRunStart = null;

/** Why {@link SvalTestLeftovers.runStarts} could not record them. */
let startFailure = null;

export const SvalTestLeftovers = {
  /**
   * Records the workspaces the run starts with. A failure is kept for
   * {@link SvalTestLeftovers.afterFile} to report, since no file has
   * started that it could fail.
   *
   * @param {DOMWindow} win The harness's browser window.
   */
  async runStarts(win) {
    try {
      await this.beforeFile(win);
    } catch (ex) {
      startFailure = ex;
    }
  },

  /**
   * Removes the workspaces the file that ended left.
   *
   * @param {DOMWindow} win The harness's browser window.
   * @returns {Promise<Error|null>} What kept the next file from starting
   *   without them, or what kept the run from recording its start, or null.
   */
  async afterFile(win) {
    const failure = startFailure;
    startFailure = null;
    try {
      await this.beforeFile(win);
    } catch (ex) {
      return ex;
    }
    return failure;
  },

  /**
   * Removes the workspaces no window shows that the document did not hold
   * when the run's first file started. The first call records that set.
   *
   * @param {DOMWindow} win The harness's browser window.
   */
  async beforeFile(win) {
    // The window's panel makes the profile's engine as it starts, and its
    // workspace is part of what the run starts with.
    // A profile whose first window opens first run starts only once the file
    // has answered it (`_maybeRunFirstRun`). Such a profile is fresh, and its
    // file is the run's only one, so it holds nothing to remove.
    const panel = win.SvalPanel;
    if (panel) {
      let started = false;
      panel.started.then(
        () => (started = true),
        () => (started = true)
      );
      await waitForCondition(
        () => started || panel._firstRunInFlight,
        "the panel's startup, or the first run it opens",
        100,
        400
      );
      if (!started) {
        return;
      }
    }
    const engine = SvalEngine.sharedInstance;
    if (!engine || engine.terminated) {
      return;
    }
    // A window an earlier file closed writes its last content, and deletes a
    // workspace nobody touched, after it has gone.
    await within(
      engine.closedWindowsFlushed(),
      10_000,
      "closed windows' last writes"
    );
    const ids = workspaceIds((await engine.tree()).nodes ?? {});
    if (!atRunStart) {
      atRunStart = new Set(ids);
      return;
    }
    const shown = new Set();
    for (const other of Services.wm.getEnumerator("navigator:browser")) {
      const id = other.SvalPanel?.workspaceId;
      if (id) {
        shown.add(id);
      }
    }
    for (const id of ids) {
      if (!atRunStart.has(id) && !shown.has(id)) {
        await engine.mutate({ kind: "remove", id });
      }
    }
  },
};
