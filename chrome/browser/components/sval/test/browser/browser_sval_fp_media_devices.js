/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * enumerateDevices reports one device of each input kind the page holds no
 * permission for, and the real list of a kind it was granted
 * (RFPTarget::MediaDevicesBeforePermission).
 */

/**
 * Evaluated in the page's own global, so it must stand alone.
 *
 * @param {?string} grant getUserMedia constraints to take first, as JSON,
 *   or null. A string, because a chrome object handed to a page function is
 *   opaque to it.
 * @returns {Promise<string>} What the page read, as JSON.
 */
async function devicesProbe(grant) {
  const list = async win =>
    (await win.navigator.mediaDevices.enumerateDevices()).map(d => ({
      kind: d.kind,
      label: d.label,
      deviceId: d.deviceId,
    }));
  if (grant) {
    const stream = await navigator.mediaDevices.getUserMedia(JSON.parse(grant));
    stream.getTracks().forEach(t => t.stop());
    return JSON.stringify({ after: await list(window) });
  }
  const frame = document.createElement("iframe");
  frame.src = location.href;
  frame.allow = "camera; microphone";
  await new Promise(resolve => {
    frame.onload = resolve;
    document.body.append(frame);
  });
  const before = await list(window);
  const framed = await list(frame.contentWindow);
  frame.remove();
  return JSON.stringify({ before, framed });
}

async function readDevices(browser, grant = null) {
  return within(
    SpecialPowers.spawn(
      browser,
      [devicesProbe.toString(), grant && JSON.stringify(grant)],
      async (src, g) => {
        return JSON.parse(await content.wrappedJSObject.eval(`(${src})`)(g));
      }
    ),
    10_000,
    "the page's devices"
  );
}

// The machine's own devices, whatever they are: a machine without a camera
// still reads as having one.
function checkBefore(fp, where) {
  const shape = [
    { kind: "audioinput", label: "", deviceId: "" },
    { kind: "videoinput", label: "", deviceId: "" },
  ];
  Assert.deepEqual(fp.before, shape, `${where}: one of each before permission`);
  Assert.deepEqual(fp.framed, shape, `${where}: an iframe sees the same`);
}

add_task(async function a_normal_window_sees_a_constant_list() {
  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    checkBefore(await readDevices(browser), "normal window");
  });
});

add_task(async function a_private_window_sees_the_same() {
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
    checkBefore(await readDevices(tab.linkedBrowser), "private window");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});

/**
 * Takes `grant` in a new tab with fake devices and returns the inputs the
 * page then lists.
 *
 * @param {object} grant getUserMedia constraints.
 * @returns {Promise<object[]>} The audioinput and videoinput entries.
 */
async function inputsAfter(grant) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      ["media.navigator.permission.disabled", true],
    ],
  });
  try {
    return await BrowserTestUtils.withNewTab(PAGE2, async browser => {
      const { after } = await readDevices(browser, grant);
      return after.filter(d => d.kind != "audiooutput");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

// The granted kind lists its devices with labels and ids; the other kind
// stays at the one anonymous entry it had before permission, and the
// microphones still come before the camera.
function checkPartial(inputs, granted, other) {
  const grantedList = inputs.filter(d => d.kind == granted);
  Assert.ok(grantedList.length, `the grant shows the ${granted} devices`);
  Assert.ok(
    grantedList.every(d => d.label && d.deviceId),
    `the ${granted} list is the real one, with labels`
  );
  Assert.deepEqual(
    inputs.filter(d => d.kind == other),
    [{ kind: other, label: "", deviceId: "" }],
    `the ${other} list keeps its single anonymous entry`
  );
  const kinds = inputs.map(d => d.kind);
  Assert.less(
    kinds.lastIndexOf("audioinput"),
    kinds.indexOf("videoinput"),
    "microphones come before the camera"
  );
}

add_task(async function a_grant_shows_the_real_list() {
  const inputs = await inputsAfter({ audio: true, video: true });
  Assert.ok(inputs.length, "the grant shows the devices");
  Assert.ok(
    inputs.every(d => d.label && d.deviceId),
    "the granted list is the real one, with labels"
  );
});

add_task(async function a_microphone_grant_shows_nothing_about_cameras() {
  checkPartial(await inputsAfter({ audio: true }), "audioinput", "videoinput");
});

add_task(async function a_camera_grant_shows_nothing_about_microphones() {
  checkPartial(await inputsAfter({ video: true }), "videoinput", "audioinput");
});
