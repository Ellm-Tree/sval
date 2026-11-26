/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */
/* import-globals-from sval_ctrl_tab_helpers.js */

/**
 * The Ctrl+Tab switcher lists the pages of the workspace's pins among its
 * tabs, in order of use, and marks a pin's page with the pin glyph and a tab
 * in a group with the group's chip, its name in its colour, as the
 * Launcher's rows do (`SvalTabSwitcher`).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_ctrl_tab_helpers.js",
  this
);

add_setup(pinsSetup);

/** @returns {Element} The caption under the carousel. */
function caption() {
  return document.querySelector(".sval-switcher-caption");
}

/**
 * Steps the switcher with Ctrl+Tab until `option` is selected.
 *
 * @param {Element} option
 */
async function selectOption(option) {
  const count = switcherOptions().length;
  for (
    let i = 0;
    i < count && option.getAttribute("aria-selected") !== "true";
    i++
  ) {
    EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
  }
  Assert.equal(option.getAttribute("aria-selected"), "true", "it is selected");
}

add_task(async function a_pin_and_a_grouped_tab_are_marked() {
  const { engine, home, work } = pinsFixture;
  const now = Date.now();
  const group = await engine.mutate({
    kind: "addGroup",
    parent: home,
    name: "Research",
    id: crypto.randomUUID(),
    now,
  });
  atTaskEnd(async () => {
    await engine.mutate({ kind: "remove", id: group });
    await SvalPanel.refresh();
  });
  await engine.mutate({
    kind: "setAppearance",
    id: group,
    color: "purple",
    emoji: null,
    now,
  });
  for (let i = 1; i <= 3; i++) {
    await engine.mutate({
      kind: "addTab",
      parent: group,
      name: `Grouped ${i}`,
      url: titledPage(`Grouped ${i}`),
      id: crypto.randomUUID(),
      now,
    });
  }
  await SvalPanel.refresh();
  expectWorkspaceTabs();
  await showWorkspace(work);
  await showWorkspace(home);

  const guid = await pinFavorite(PAGE2, PAGE2_TITLE);
  const page = await clickTile(guid, PAGE2);
  Assert.ok(isPin(page), "the window shows the pin's page");

  await holdCtrlTab();
  const options = switcherOptions();
  const pinned = options.filter(option => "pin" in option.dataset);
  Assert.equal(pinned.length, 1, "one card is the pin's");
  Assert.equal(optionTitle(pinned[0]), PAGE2_TITLE, "the page shown");
  await selectOption(pinned[0]);
  Assert.ok(
    caption().querySelector(".sval-mark[data-mark=pin]"),
    "its caption carries the pin glyph"
  );
  Assert.ok(
    pinned[0].getAttribute("aria-description"),
    "and described as a pin to a screen reader"
  );

  const grouped = options.filter(option => option.dataset.group === group);
  Assert.deepEqual(
    grouped.map(optionTitle).sort(),
    ["Grouped 1", "Grouped 2", "Grouped 3"],
    "each of the group's tabs is marked with the group"
  );
  for (const option of grouped) {
    await selectOption(option);
    const chip = caption().querySelector(".sval-chip");
    Assert.equal(chip?.dataset.color, "purple", "in the group's colour");
    Assert.equal(
      chip.querySelector(".sval-chip-name").textContent,
      "Research",
      "with its name"
    );
    Assert.equal(
      option.getAttribute("aria-description"),
      "Research",
      "which a screen reader hears"
    );
  }
  const plain = options.find(
    option => !grouped.includes(option) && !pinned.includes(option)
  );
  await selectOption(plain);
  Assert.ok(
    !caption().querySelector(".sval-chip, .sval-mark"),
    "a tab outside a group carries no mark"
  );

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !switcherShown(),
    "the switcher closing"
  );
  await releaseCtrl();
});

add_task(async function a_pin_left_for_a_tab_is_listed_and_picked() {
  const { home, work } = pinsFixture;
  expectWorkspaceTabs();
  await showWorkspace(work);
  await showWorkspace(home);
  const guid = await pinFavorite(PAGE2, PAGE2_TITLE);
  const page = await clickTile(guid, PAGE2);
  // Two more tabs than the pin's page, so Ctrl+Tab shows its list.
  const open = title =>
    within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, titledPage(title)),
      10_000,
      "a tab opening"
    );
  await open("Other");
  const last = await open("Last");
  await selectTab(page);
  await selectTab(last);
  Assert.ok(page.hidden, "the pin's page is hidden as the tab shows");

  await holdCtrlTab();
  const second = switcherOptions()[1];
  Assert.equal(
    optionTitle(second),
    PAGE2_TITLE,
    "the pin's page is listed second, as the one used before"
  );
  Assert.ok("pin" in second.dataset, "marked as the pin's");
  Assert.equal(selectedTitle(), PAGE2_TITLE, "and selected");
  await releaseCtrl();
  Assert.equal(gBrowser.selectedTab, page, "letting Ctrl go shows the page");
  Assert.equal(selectedPinGuid(), guid, "as the pin selected");
});
