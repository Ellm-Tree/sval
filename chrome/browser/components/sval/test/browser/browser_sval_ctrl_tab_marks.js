/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */
/* import-globals-from sval_ctrl_tab_helpers.js */

/**
 * The Ctrl+Tab switcher marks a pin's page with the pin glyph and a tab in a
 * group with the group's chip, its name in its colour, as the Launcher's
 * rows do (`SvalTabSwitcher`).
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
  Assert.ok(
    pinned[0].querySelector(".sval-mark[data-mark=pin]"),
    "marked with the pin glyph"
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
    const chip = option.querySelector(".sval-chip");
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
  Assert.ok(
    options
      .filter(option => !grouped.includes(option) && !pinned.includes(option))
      .every(option => !option.querySelector(".sval-chip, .sval-mark")),
    "a tab outside a group carries no mark"
  );

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !switcherShown(),
    "the switcher closing"
  );
  await releaseCtrl();
});
