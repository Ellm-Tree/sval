/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A standard-mapped gamepad reports a generic id; one without a standard
 * mapping keeps its own (RFPTarget::GamepadIdGeneric).
 */

/** Evaluated in the page's own global, so it must stand alone. */
async function gamepadProbe() {
  const svc = navigator.requestGamepadServiceTest();
  const eventIds = [];
  const connected = new Promise(resolve => {
    addEventListener("gamepadconnected", e => {
      eventIds.push(e.gamepad.id);
      if (eventIds.length == 2) {
        resolve();
      }
    });
  });
  const pads = [
    await svc.addGamepad(
      "045e-028e-Xbox 360 Controller",
      svc.standardMapping,
      svc.noHand,
      17,
      4,
      0,
      0,
      0
    ),
    await svc.addGamepad(
      "046d-c216-Logitech Dual Action",
      svc.noMapping,
      svc.noHand,
      12,
      4,
      0,
      0,
      0
    ),
  ];
  for (const pad of pads) {
    await svc.newButtonEvent(pad, 0, true, true);
  }
  await connected;
  const ids = navigator
    .getGamepads()
    .filter(Boolean)
    .map(g => g.id);
  for (const pad of pads) {
    await svc.removeGamepad(pad);
  }
  return JSON.stringify({ ids, eventIds: eventIds.sort() });
}

async function readGamepads(browser) {
  return within(
    SpecialPowers.spawn(browser, [gamepadProbe.toString()], async src => {
      return JSON.parse(await content.wrappedJSObject.eval(`(${src})()`));
    }),
    10_000,
    "the page's gamepads"
  );
}

function checkIds(fp, where) {
  Assert.deepEqual(
    fp.ids,
    ["Standard Gamepad", "046d-c216-Logitech Dual Action"],
    `${where}: the standard gamepad's id is generic, the other keeps its own`
  );
  Assert.deepEqual(
    fp.eventIds,
    ["046d-c216-Logitech Dual Action", "Standard Gamepad"],
    `${where}: gamepadconnected reads the same`
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.gamepad.test.enabled", true]],
  });
});

add_task(async function a_normal_window_reads_a_generic_id() {
  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    checkIds(await readGamepads(browser), "normal window");
  });
});

add_task(async function a_private_window_reads_the_same() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a new window opening"
  );
  try {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE2),
      10_000,
      "a new tab's load"
    );
    checkIds(await readGamepads(tab.linkedBrowser), "private window");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});
