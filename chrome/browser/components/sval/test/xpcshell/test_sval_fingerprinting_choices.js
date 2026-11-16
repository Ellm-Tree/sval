/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The fingerprinting switches that are RFP targets keep one choice each, and
 * the overrides string Gecko reads is composed from them (decision 0114): a
 * profile's earlier string becomes choices, and a choice arriving from
 * another device leaves this device's own alone.
 */

const FP = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
);

const OVERRIDES = "privacy.fingerprintingProtection.overrides";
const byId = id => FP.ITEMS.find(item => item.id === id);
const tokens = () => Services.prefs.getStringPref(OVERRIDES).split(",");

function clearAll() {
  for (const name of FP.PREFS) {
    Services.prefs.clearUserPref(name);
  }
}

add_task(function a_string_from_an_earlier_build_becomes_choices() {
  // An earlier build kept the switches only in the string: Canvas noise off,
  // Spoofed keyboard layout on, and a target set by hand in about:config.
  const earlier = FP.defaultOverrides()
    .replace(
      "-EfficientCanvasRandomization,+CanvasRandomization",
      "-CanvasRandomization"
    )
    .concat(",+KeyboardEvents,+AudioSampleRate");
  Services.prefs.setStringPref(OVERRIDES, earlier);

  FP.start();

  Assert.strictEqual(
    Services.prefs.getBoolPref(FP.choicePref(byId("canvas-noise"))),
    false,
    "Canvas noise is a choice, off"
  );
  Assert.strictEqual(
    Services.prefs.getBoolPref(FP.choicePref(byId("kb"))),
    true,
    "the keyboard layout is a choice, on"
  );
  const unchanged = FP.ITEMS.filter(
    item => item.on && !["canvas-noise", "kb"].includes(item.id)
  );
  Assert.deepEqual(
    unchanged.filter(item =>
      Services.prefs.prefHasUserValue(FP.choicePref(item))
    ),
    [],
    "every other switch stays at Sval's default"
  );
  Assert.ok(!FP.isOn(byId("canvas-noise")), "Canvas noise stays off");
  Assert.ok(FP.isOn(byId("kb")), "the keyboard layout stays on");
  Assert.ok(tokens().includes("+AudioSampleRate"), "the hand-set target stays");
  clearAll();
});

/**
 * Lets the string be composed for the choices changed in this turn, which
 * the module does once they have all landed.
 *
 * @returns {Promise<void>}
 */
const composed = () => Promise.resolve();

add_task(async function a_switch_from_another_device_keeps_this_devices_own() {
  FP.start();
  clearAll();
  FP.setSwitches(new Map([[byId("canvas-noise"), false]]));

  // Settings sync applies Touch points, turned off on another device.
  Services.prefs.setBoolPref(FP.choicePref(byId("touch")), false);
  await composed();

  Assert.ok(!FP.isOn(byId("touch")), "Touch points are off");
  Assert.ok(tokens().includes("-MaxTouchPointsCollapse"), "in the string");
  Assert.ok(!FP.isOn(byId("canvas-noise")), "and Canvas noise stays off");

  // And back to its default there.
  Services.prefs.clearUserPref(FP.choicePref(byId("touch")));
  await composed();
  Assert.ok(FP.isOn(byId("touch")), "Touch points are back on");
  Assert.ok(!FP.isOn(byId("canvas-noise")), "Canvas noise is still off");
  clearAll();
  await composed();
  Assert.ok(
    !Services.prefs.prefHasUserValue(OVERRIDES),
    "at defaults the string is Sval's own"
  );
});

add_task(async function a_sync_pass_writes_the_string_once() {
  FP.start();
  clearAll();
  await composed();
  let writes = 0;
  const onWrite = () => writes++;
  Services.prefs.addObserver(OVERRIDES, onWrite);
  try {
    // A sync pass applies two switches turned off on another device.
    Services.prefs.setBoolPref(FP.choicePref(byId("touch")), false);
    Services.prefs.setBoolPref(FP.choicePref(byId("canvas-noise")), false);
    await composed();
    Assert.equal(writes, 1, "the string is written once");
    Assert.ok(
      tokens().includes("-MaxTouchPointsCollapse") &&
        tokens().includes("-CanvasRandomization"),
      "carrying both switches off"
    );
  } finally {
    Services.prefs.removeObserver(OVERRIDES, onWrite);
    clearAll();
    await composed();
  }
});
