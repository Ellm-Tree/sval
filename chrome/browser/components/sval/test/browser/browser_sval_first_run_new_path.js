/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */
/* import-globals-from sval_first_run_scenario_helpers.js */

for (const helpers of [
  "sval_first_run_helpers.js",
  "sval_first_run_scenario_helpers.js",
]) {
  Services.scriptloader.loadSubScript(
    getRootDirectory(gTestPath) + helpers,
    this
  );
}

const MockFilePicker = SpecialPowers.MockFilePicker;

/**
 * A new user who imports nothing and continues through every step of first
 * run on a fresh profile (first-run spec §3, 2026-11-09 spec §3.4, §3.6,
 * §4): the Workspace step's name, colour and emoji show on the panel behind
 * the sheet as they change, the search step draws each engine's own icon,
 * "A few more things" moves the panel as its side is chosen and writes
 * agent access and sites' tools, and first run leaves exactly one
 * workspace, wearing the name, colour and emoji chosen. Nothing chose a
 * folder or made a sync key, which on a Mac is the Keychain's.
 */
add_task(async function continuing_through_first_run_keeps_each_answer() {
  keepFirstRunChoices();
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => MockFilePicker.cleanup());
  let pickers = 0;
  MockFilePicker.showCallback = () => {
    pickers++;
  };
  const doc = await firstRunShown();
  const container = document.getElementById("sval-panel-container");
  const switcher = document.querySelector(".sval-switcher");

  await walkTo(doc, STEPS.workspace);
  const step = shownSection(doc);
  const name = step.querySelector(".sval-nw-name");
  Assert.equal(doc.activeElement, name, "the name has focus");
  Assert.equal(
    name.selectionEnd - name.selectionStart,
    name.value.length,
    "with its preset selected, so typing replaces it"
  );
  Assert.ok(name.value, "and a name Continue can keep as it is");
  EventUtils.sendString("Studio", doc.defaultView);
  await TestUtils.waitForCondition(
    () =>
      switcher.querySelector(".sval-switcher-name").textContent === "Studio",
    "the panel behind the sheet follows the name"
  );
  // The swatches are a radio group with a roving tabindex: Tab reaches the
  // checked one and the arrow keys the rest.
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  step.querySelector('.sval-nw-swatch[data-token="pink"]').click();
  AccessibilityUtils.resetEnv();
  await TestUtils.waitForCondition(
    () => SvalPanel.windowColor === "pink",
    "and the colour, on the window"
  );
  const emoji = step.querySelector(".sval-nw-emoji-value").textContent;
  Assert.equal(
    switcher.querySelector(".sval-switcher-emoji").textContent,
    emoji,
    "and the emoji"
  );
  Assert.equal(
    step.querySelector(".sval-fr-ws-name").textContent,
    "Studio",
    "the step's own header follows too"
  );

  // The picker opens in the step, and Escape closes it before it skips.
  step.querySelector(".sval-nw-emoji").click();
  await TestUtils.waitForCondition(
    () =>
      step
        .querySelector(".sval-fr-emoji")
        ?.contentDocument?.querySelector(".sval-emoji-search"),
    "the emoji picker opens in the step"
  );
  const picker = step.querySelector(".sval-fr-emoji");
  await TestUtils.waitForCondition(
    () =>
      picker.contentDocument.activeElement ===
      picker.contentDocument.querySelector(".sval-emoji-search"),
    "with focus in its search"
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, picker.contentWindow);
  await TestUtils.waitForCondition(
    () => !step.querySelector(".sval-fr-emoji"),
    "Escape closes the picker"
  );
  Assert.ok(gDialogBox.isOpen, "and leaves first run open");
  Assert.equal(shownStep(doc), STEPS.workspace, "on the Workspace step");
  Assert.equal(
    step.querySelector(".sval-nw-emoji-value").textContent,
    emoji,
    "with the emoji as it was"
  );

  await walkTo(doc, STEPS.search);
  // The search service gives each engine's icon as a `blob:` URL, which the
  // dialog's document must be able to load.
  const icons = [...shownSection(doc).querySelectorAll(".sval-fr-icon")];
  const blobs = icons.filter(img => img.src.startsWith("blob:"));
  Assert.greater(blobs.length, 0, "the engines' icons are blob: URLs");
  for (const img of blobs) {
    await TestUtils.waitForCondition(
      () => img.complete && img.naturalWidth > 0,
      "an engine's icon loads"
    );
  }

  await walkTo(doc, STEPS.more);
  const more = shownSection(doc);
  Assert.equal(
    more.querySelector('input[data-setting="agents"]:checked').value,
    "off",
    "AI assistants start off"
  );
  const check = more.querySelector(".sval-fr-check");
  Assert.ok(BrowserTestUtils.isHidden(check), "with no tools checkbox");
  pick(doc, "on");
  Assert.ok(BrowserTestUtils.isVisible(check), "which On shows");
  Assert.ok(!more.querySelector(".sval-fr-tools").checked, "unchecked");
  more.querySelector(".sval-fr-tools").click();

  Assert.deepEqual(
    await workspacesInEngine(),
    [],
    "nothing is made while the questions are asked"
  );
  pick(doc, "right");
  await TestUtils.waitForCondition(
    () => container.getAttribute("sval-placement") === "right",
    "the panel moves to the right"
  );
  Assert.equal(shownStep(doc), STEPS.more, "while the step is still up");
  Assert.ok(more.contains(doc.activeElement), "and focus stays in the sheet");
  Assert.greaterOrEqual(
    Math.round(container.getBoundingClientRect().left),
    Math.round(
      document.getElementById("tabbrowser-tabbox").getBoundingClientRect().right
    ),
    "and it is drawn right of the page"
  );

  await finishFirstRun(doc);
  const workspaces = await workspacesInEngine();
  Assert.equal(workspaces.length, 1, "exactly one workspace");
  Assert.equal(
    SvalPanel.nodes[workspaces[0]].content.name,
    "Studio",
    "with the name typed"
  );
  Assert.deepEqual(
    SvalTree.appearanceOf(SvalPanel.nodes, workspaces[0]),
    { color: "pink", emoji, transparency: null },
    "and the colour and emoji chosen"
  );
  Assert.equal(pickers, 0, "no folder was chosen");
  Assert.equal(SvalPanel.sharedRootSetting(), null, "it saves on this device");
  Assert.equal(
    (await SvalIdentity.syncKey()).state,
    SvalIdentity.SYNC_KEY_STATES.none,
    "with no sync key, so nothing asked the system's key store"
  );
  Assert.equal(
    Services.prefs.getStringPref(LEVEL_PREF),
    "balanced",
    "Balanced, as shown, is the ad-blocking level"
  );
  Assert.ok(
    Services.prefs.getBoolPref("browser.sval.agents.enabled"),
    "On turns agent access on"
  );
  Assert.ok(
    Services.prefs.getBoolPref("browser.sval.agents.pageTools.enabled"),
    "and its checkbox sites' tools"
  );
  const onDisk = await IOUtils.readJSON(SvalLocalSettings.profilePath());
  Assert.equal(onDisk.placement, "right", "the side is kept on disk");
  Assert.strictEqual(onDisk.firstRunDone, true, "and first run is done");
});
