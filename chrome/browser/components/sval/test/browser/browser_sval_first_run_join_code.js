/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A first run that joins another device's tabs and settings (first-run
 * spec §3.2). The other device is an engine of its own that keeps the shared
 * folder as its own location, under its sync key, with a workspace in it,
 * and offers that key under a code, as its settings page's "Show a code"
 * does (`SvalPairing.offer`).
 *
 * The question's I use Sval on another device goes to the folder step. The
 * code step groups the code as it is typed, refuses a short code without
 * trying it and a code the offer does not open, and with the offer's code
 * adopts the other device's key. The progress bar holds through the
 * adoption, Back from search never claims again, and the flow ends on the
 * welcome with the card synced from the other device, with the other
 * device's workspace here.
 */
/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */
/* import-globals-from sval_first_run_dialog_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_first_run_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_first_run_dialog_helpers.js",
  this
);

/**
 * @param {Document} doc The dialog's document.
 * @returns {string} what the visible step's status line says, by its
 *   `data-said`.
 */
function saidOf(doc) {
  return shownSection(doc).querySelector(".sval-fr-status").dataset.said ?? "";
}

/**
 * @param {Document} doc The dialog's document.
 * @returns {string} what the code step's join line says, by its `data-said`.
 */
function joinSaidOf(doc) {
  return shownSection(doc).querySelector(".sval-fr-join").dataset.said ?? "";
}

/**
 * A shared folder holding `sval/`, as a device that shares writes it.
 *
 * @param {string} label
 * @returns {Promise<string>}
 */
async function sharedFolder(label) {
  const folder = await makeTempDir(`sval-fr-${label}`);
  await IOUtils.makeDirectory(PathUtils.join(folder, "sval"));
  return folder;
}

add_task(async function a_joining_device_adopts_the_others_key() {
  keepFirstRunPrefs();
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => MockFilePicker.cleanup());
  const folder = await sharedFolder("join-code");
  const theirKey = randomBytes(32);
  const them = new SvalEngine({
    root: folder,
    keyBytes: theirKey,
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(them));
  const theirs = await them.mutate({
    kind: "addWorkspace",
    name: "Theirs",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  Assert.notEqual(
    (await them.sync(SYNC_DOCUMENT, Date.now())).wrote,
    null,
    "the other device's workspace reached the folder"
  );
  const offer = await SvalPairing.offer(folder, theirKey);

  const doc = await firstRunShown();
  const facts = await realFacts();
  await choosePath(doc, "join", STEPS.joinFolder);
  chooseFolderWith(folder);
  shownSection(doc).querySelector(".sval-fr-choose-folder").click();
  await TestUtils.waitForCondition(
    () => !button(doc, "continue").disabled,
    "the folder step takes the folder for a join"
  );
  const join = { ...SvalFirstRunModel.defaults(), path: "join" };
  Assert.equal(
    shown(doc),
    shareOf(STEPS.joinFolder, join, facts),
    "the bar fills to the folder's place on the join path"
  );
  await settled(doc);
  await press(doc, "continue", STEPS.joinCode);

  const win = doc.defaultView;
  const field = shownSection(doc).querySelector(".sval-fr-code");
  field.focus();
  EventUtils.sendString("k7q48mtz", win);
  Assert.equal(field.value, "K7Q4-8MTZ", "typed in fours, with a dash");
  for (let i = 0; i < 4; i++) {
    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, win);
  }
  EventUtils.synthesizeKey("KEY_Backspace", {}, win);
  Assert.equal(field.value, "K7Q8-MTZ", "Backspace at a dash deletes past it");
  Assert.equal(field.selectionStart, 3, "with the caret where it was");
  EventUtils.sendString("4", win);
  Assert.equal(field.value, "K7Q4-8MTZ", "and a character typed back fits in");

  await settled(doc);
  button(doc, "continue").click();
  await TestUtils.waitForCondition(
    () => saidOf(doc) === "code-wrong",
    "a short code is not a code"
  );
  Assert.equal(shownSection(doc).dataset.join, "idle", "and is not tried");

  // A whole code, which the offer in the folder does not open.
  const wrong = offer.code.startsWith("A")
    ? "B" + offer.code.slice(1)
    : "A" + offer.code.slice(1);
  typeCode(doc, wrong.toLowerCase());
  await settled(doc);
  button(doc, "continue").click();
  await TestUtils.waitForCondition(
    () => saidOf(doc) === "code-wrong" && field.value === wrong,
    "a code that does not open the offer says so, and stays to check",
    250,
    80
  );
  Assert.equal(shownStep(doc), STEPS.joinCode, "on the code step");

  typeCode(doc, offer.code);
  await submitCode(doc);
  await TestUtils.waitForCondition(
    () => !button(doc, "continue").disabled,
    "adoption enables Continue",
    250,
    80
  );
  Assert.equal(joinSaidOf(doc), "joined", "the join line says it landed");
  Assert.equal(
    shown(doc),
    shareOf(STEPS.joinCode, join, facts),
    "adoption keeps the bar where it was"
  );
  Assert.ok(
    button(doc, "back").disabled,
    "a landed pairing has no folder or code to go back to"
  );

  // The engine the other device's tabs and settings use is preset.
  await press(doc, "continue", STEPS.search);
  Assert.equal(
    shownSection(doc).querySelector("input:checked")?.value,
    await SvalSettingsSync.searchService().currentId(),
    "search is preset to the engine in use"
  );
  await press(doc, "back", STEPS.joinCode);
  Assert.ok(!button(doc, "continue").disabled, "it is still complete");
  Assert.equal(joinSaidOf(doc), "joined", "and never claims again");

  const path = pathOf(join, facts);
  await walkToEnd(doc, path.slice(path.indexOf(STEPS.joinCode) + 1));
  declineDefaultBrowser(doc);
  await press(doc, "continue", STEPS.welcome);
  const welcome = shownSection(doc);
  Assert.equal(welcome.dataset.card, "synced", "the card is the synced one");
  Assert.ok(
    BrowserTestUtils.isHidden(welcome.querySelector(".sval-fr-set-up-sync")),
    "and sync needs no setting up"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(welcome.querySelector(".sval-fr-import")),
    "nothing is imported"
  );
  await startBrowsing(doc);
  await within(SvalPanel.started, 40_000, "the panel's startup");

  Assert.ok(
    (await workspacesInEngine()).includes(theirs),
    "the other device's workspace is here"
  );
  const stored = (await SvalIdentity.syncKey()).bytes;
  Assert.deepEqual(
    Array.from(stored),
    Array.from(theirKey),
    "under the key the code carried"
  );
  Assert.ok(!(await IOUtils.exists(offer.path)), "and the offer is gone");
  Assert.equal(SvalPanel.sharedRootSetting(), folder, "through the folder");
  await within(SvalPanel.chooseSharedFolder(null), 20_000, "sharing stopping");
});
