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
  const asked = await codeDialog(ui);
  Assert.equal(
    asked.doc.activeElement,
    asked.input,
    "the dialog opens with the code field focused"
  );
  submitCode(asked, code.toLowerCase().replace(/-/g, " "));

  // A claim's Argon2id and the adoption after it take seconds on a loaded
  // machine, past waitForCondition's default budget.
  // A join that lands closes Enter code and says so on the Sync card.
  const landed = ui.els.storageStatus;
  await TestUtils.waitForCondition(
    () => landed.dataset.outcome,
    "the page reported an outcome from the panel",
    250,
    80
  );
  await svalDialogClosed(
    ui.page.browsingContext.topChromeWindow,
    asked,
    "the dialog closes"
  );
  Assert.equal(landed.dataset.outcome, "adopted", "it joined");
  Assert.equal(landed.dataset.reason, "joined", "it says so");
  Assert.equal(landed.dataset.status, "success", "as a success");
  Assert.equal(
    ui.els.storageResultActions.childElementCount,
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
  const asked = await codeDialog(ui);

  for (const typed of [
    "ABCD-EFGH-JKM", // eleven characters
    "ABCD-EFGH-JKMNP", // thirteen
    "ABCD-EFGH-JKMU", // U is not in the alphabet, and looks like no digit
    "ABCD-EFGH-JKM!", // nor is punctuation
    "", // nothing at all
  ]) {
    submitCode(asked, typed);
    Assert.equal(
      asked.input.getAttribute("aria-invalid"),
      "true",
      `"${typed}" is refused as not looking like a code, never as wrong`
    );
    Assert.equal(
      asked.card.state,
      "enter-code",
      "and the folder is not looked at"
    );
  }

  // A check that refused every code would pass every assertion above.
  submitCode(asked, "ABCD-EFGH-JKMN");
  await TestUtils.waitForCondition(
    () => asked.card.state === "waiting",
    "a well-formed code is put to the folder"
  );
  asked.cancel.click();
  await svalDialogClosed(
    ui.page.browsingContext.topChromeWindow,
    asked,
    "Cancel closes the dialog"
  );
  Assert.ok(!ui.settings._claims.looking, "and stops the look");
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
  const asked = await codeDialog(ui);
  submitCode(asked, "ABCD-EFGH-JKMN");
  await TestUtils.waitForCondition(
    () => asked.card.state === "waiting",
    "with no offer in the folder, the dialog says none has arrived"
  );
  Assert.ok(
    asked.ok.disabled,
    "and Sval is still looking, so the code cannot be sent again"
  );
  Assert.ok(!asked.cancel.disabled, "and Cancel stops the look");

  // An offer this code does not open arrives before the next look.
  await SvalSharedFolder._whenIdle();
  await SvalPairing.offer(us.root, randomBytes(32));
  await TestUtils.waitForCondition(
    () => asked.card.state === "no-match",
    "the next look reports a live offer this code does not open as wrong",
    250,
    80
  );
  Assert.ok(!asked.ok.disabled, "and Sval stops looking");
  Assert.ok(!ui.settings._claims.looking);
  BrowserTestUtils.removeTab(ui.tab);
});
