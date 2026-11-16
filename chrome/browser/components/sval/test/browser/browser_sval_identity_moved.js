/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A profile that last ran on another computer: `SvalIdentity.deviceId` asks
 * the user, through Firefox's window prompt, whether the profile moved here
 * or is a new device, and keeps or replaces the id by the answer.
 *
 * The other computer is the identity file such a computer leaves: its
 * `devices` map names that computer's fingerprint and not this one's.
 */

const { SvalIdentity, fingerprintOf, machineFingerprintOf, readMachineId } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
  );

const OTHER_COMPUTER = "another computer";
const OLD_ID = "5a".repeat(16);
/** The local key the profile carried from the other computer. */
const LOCAL_KEY = new Uint8Array(32).fill(9);

/**
 * Points `SvalIdentity` at a temporary identity file holding a profile that
 * last ran on {@link OTHER_COMPUTER}, for one task, and puts the profile's
 * own back when the task ends.
 *
 * @returns {Promise<string>} the file's path.
 */
async function profileFromAnotherComputer() {
  Assert.notEqual(await readMachineId(), null, "this computer's id reads");
  const previous = {
    path: SvalIdentity.path,
    localKeyPath: SvalIdentity.localKeyPath,
  };
  const dir = await makeTempDir("sval-identity-moved");
  SvalIdentity.path = PathUtils.join(dir, "sval-identity.json");
  SvalIdentity.localKeyPath = PathUtils.join(dir, "sval-local-key");
  atTaskEnd(() => {
    SvalIdentity.path = previous.path;
    SvalIdentity.localKeyPath = previous.localKeyPath;
    SvalIdentity.forgetCachedValues();
  });
  await IOUtils.write(SvalIdentity.localKeyPath, LOCAL_KEY);
  await IOUtils.writeJSON(SvalIdentity.path, {
    deviceId: OLD_ID,
    devices: { [await machineFingerprintOf(OTHER_COMPUTER)]: OLD_ID },
    localKeyFingerprint: await fingerprintOf(LOCAL_KEY),
  });
  SvalIdentity.forgetCachedValues();
  return SvalIdentity.path;
}

/** This computer's fingerprint, as the identity file keys it. */
async function thisComputer() {
  return machineFingerprintOf(await readMachineId());
}

function hex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Waits for the moved-here question, proves it is a two-button window
 * prompt in front with the button enabled, and clicks button `which`.
 *
 * @param {number} which 0 for "I moved here", 1 for "New device".
 * @returns {Promise<void>} once the prompt has closed.
 */
async function answer(which) {
  const loaded = await within(
    TestUtils.topicObserved("common-dialog-loaded"),
    10_000,
    "the moved-here question"
  );
  const dialogWin = loaded[0];
  const { Dialog } = dialogWin;
  Assert.equal(Dialog.args.promptType, "confirmEx", "it is a question");
  const buttons = [Dialog.ui.button0, Dialog.ui.button1];
  for (const button of buttons) {
    Assert.ok(BrowserTestUtils.isVisible(button), `${button.id} shows`);
  }
  Assert.ok(BrowserTestUtils.isHidden(Dialog.ui.button2), "and no third");
  await within(
    TestUtils.waitForCondition(
      () => Services.focus.activeWindow === dialogWin,
      "the question is in front"
    ),
    10_000,
    "the question in front"
  );
  const target = buttons[which];
  Assert.ok(!target.disabled, `${target.id} takes the click`);
  const closed = BrowserTestUtils.windowClosed(dialogWin);
  EventUtils.synthesizeMouseAtCenter(target, {}, dialogWin);
  await within(closed, 10_000, "the question closing on the click");
}

/** The device id a restart reads, which must not ask. */
async function restartUnasked() {
  SvalIdentity.forgetCachedValues();
  return within(SvalIdentity.deviceId(), 10_000, "a restart that never asks");
}

add_task(async function a_moved_profile_keeps_its_id() {
  const path = await profileFromAnotherComputer();
  const answered = answer(0);
  const [first, second] = await within(
    Promise.all([SvalIdentity.deviceId(), SvalIdentity.deviceId()]),
    20_000,
    "the id after the answer"
  );
  await answered;
  Assert.equal(hex(first), OLD_ID, "the moved profile keeps its id");
  Assert.equal(hex(second), OLD_ID, "and so does a concurrent caller");
  Assert.deepEqual(
    (await IOUtils.readJSON(path)).devices,
    { [await thisComputer()]: OLD_ID },
    "the id moved to this computer and left the other"
  );
  Assert.equal(hex(await restartUnasked()), OLD_ID, "a restart keeps it");
});

add_task(async function a_copied_profile_becomes_a_new_device() {
  const path = await profileFromAnotherComputer();
  const answered = answer(1);
  const fresh = hex(
    await within(SvalIdentity.deviceId(), 20_000, "the id after the answer")
  );
  await answered;
  Assert.equal(fresh.length, 32, "the new id is 16 bytes");
  Assert.notEqual(fresh, OLD_ID, "the new device has its own id");
  const stored = await IOUtils.readJSON(path);
  Assert.equal(stored.deviceId, fresh, "and starts with it");
  Assert.deepEqual(
    stored.devices,
    {
      [await machineFingerprintOf(OTHER_COMPUTER)]: OLD_ID,
      [await thisComputer()]: fresh,
    },
    "the other computer keeps the old id beside this one's"
  );
  Assert.equal(hex(await restartUnasked()), fresh, "a restart keeps it");
  Assert.equal(
    hex(await within(SvalIdentity.localKey(), 10_000, "the local key")),
    hex(LOCAL_KEY),
    "the local key is the one the old copy opens with"
  );
});
