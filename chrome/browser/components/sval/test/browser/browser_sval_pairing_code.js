/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pairing_helpers.js */

/**
 * Pairing through Sval's settings page, from the claiming side: the code a
 * person types, refused or waited for, and this device joined by it to the
 * other device's document (spec §6.7, messages spec §7). The other device
 * offers its key as its own page does, through `SvalPairing.offer`.
 * `test_sval_pairing_look.js` holds what a stopped look's late answer does.
 *
 * These tasks change the profile's stored key, so the file runs on a fresh
 * profile of its own (browser-pairing-code.toml).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pairing_helpers.js",
  this
);

const { SvalPairing } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
);

/**
 * The whole feature: the other device offers its key under a code, this
 * device's user types that code into the page, and this device ends up
 * holding the other's workspaces without losing its own.
 */
add_task(async function two_engines_one_folder_and_a_code() {
  const us = await thisDevice("page");
  const theirKey = randomBytes(32);
  const them = await peerPublishing(us.root, theirKey, "Theirs, via the page");
  await SvalSharedFolder._whenIdle();
  const { code, path } = await SvalPairing.offer(us.root, theirKey);
  Assert.equal(
    SvalPanelModel.normalizeCode(code),
    code,
    `the code is in the shape the other device shows: ${code}`
  );

  const ui = await openSettingsPage("claim");
  submitCode(ui, code.toLowerCase().replace(/-/g, " "));

  // A claim's Argon2id and the adoption after it take seconds on a loaded
  // machine, past waitForCondition's default budget.
  await TestUtils.waitForCondition(
    () => ui.els.claimStatus.dataset.outcome,
    "the page reported an outcome from the panel",
    250,
    80
  );
  Assert.equal(ui.els.claimStatus.dataset.outcome, "adopted", "it joined");
  Assert.equal(ui.els.claimStatus.dataset.said, "joined", "it says so");
  Assert.equal(ui.els.claimStatus.dataset.status, "success", "as a success");
  Assert.equal(
    ui.els.claimActions.childElementCount,
    0,
    "with no button to press"
  );

  const ours = Object.keys(await nodes(us.engine));
  Assert.ok(ours.includes(us.workspace), "this device's workspace survived");
  Assert.ok(ours.includes(us.tab), "and the tab under it");
  Assert.ok(ours.includes(them.id), "and the other device's workspace arrived");

  SvalIdentity.forgetCachedValues();
  Assert.deepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(theirKey),
    "a restart would read the key the code carried"
  );
  await within(SvalSharedFolder._whenIdle(), 20_000, "the withdrawal");
  Assert.ok(
    !(await IOUtils.exists(path)),
    "and the offer is out of the folder"
  );
  BrowserTestUtils.removeTab(ui.tab);
});

/**
 * Twelve characters from a 32-character alphabet, checked before anything
 * expensive runs: a mistyped code is told so without a look at the folder,
 * which would put it to every offer there behind Argon2id (spec §6.7).
 */
add_task(async function a_malformed_code_is_refused_before_any_argon2_work() {
  await thisDevice("shape");
  const ui = await openSettingsPage("claim");

  for (const typed of [
    "ABCD-EFGH-JKM", // eleven characters
    "ABCD-EFGH-JKMNP", // thirteen
    "ABCD-EFGH-JKMU", // U is not in the alphabet, and looks like no digit
    "ABCD-EFGH-JKM!", // nor is punctuation
    "", // nothing at all
  ]) {
    submitCode(ui, typed);
    Assert.equal(
      ui.els.claimStatus.dataset.said,
      "malformed",
      `"${typed}" is refused as not looking like a code, never as wrong`
    );
    Assert.ok(
      ui.els.claimStop.hidden && !ui.els.claimSubmit.disabled,
      "and the folder is not looked at"
    );
  }

  // A check that refused every code would pass every assertion above.
  submitCode(ui, "ABCD-EFGH-JKMN");
  await TestUtils.waitForCondition(
    () => ui.els.claimStatus.dataset.said === "waiting",
    "a well-formed code is put to the folder"
  );
  ui.els.claimStop.click();
  BrowserTestUtils.removeTab(ui.tab);
});

/**
 * "Waiting" is not "wrong". A folder that has not delivered the offer yet
 * is the common case on a provider spec §6.4 measures in tens of minutes.
 * Only a live offer that this code does not open means the code is wrong,
 * and the look that finds one stops.
 *
 * The one task that waits out the page's look (`CLAIM_POLL_MS`).
 */
add_task(async function waiting_is_never_rendered_as_a_wrong_code() {
  const us = await thisDevice("waiting");
  const ui = await openSettingsPage("claim");
  submitCode(ui, "ABCD-EFGH-JKMN");
  await TestUtils.waitForCondition(
    () => ui.els.claimStatus.dataset.said === "waiting",
    "with no offer in the folder, the page says none has arrived"
  );
  Assert.ok(
    ui.els.claimSubmit.disabled,
    "and the page is still looking, so the code cannot be sent again"
  );
  Assert.ok(!ui.els.claimStop.hidden, "and there is a way to stop");

  // An offer this code does not open arrives before the next look.
  await SvalSharedFolder._whenIdle();
  await SvalPairing.offer(us.root, randomBytes(32));
  await TestUtils.waitForCondition(
    () => ui.els.claimStatus.dataset.said === "no-match",
    "the next look reports a live offer this code does not open as wrong",
    250,
    80
  );
  Assert.ok(
    !ui.els.claimSubmit.disabled && ui.els.claimStop.hidden,
    "and the page stops looking"
  );
  BrowserTestUtils.removeTab(ui.tab);
});
