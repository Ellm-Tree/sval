/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Settings › Appearance chooses the Workspace switcher: the menu, which is
 * the default, or the strip, whose own choices show only while it is
 * chosen. Where names sit shows only while the strip shows names. The
 * window's panel follows the choice as it is made.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SWITCHER_PREF, STRIP_NAMES_PREF, STRIP_NAMES_AT_PREF } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );

add_task(async function the_switcher_is_chosen_in_appearance() {
  await panelWithFolder(null);
  const radio = (ui, name, value) =>
    ui.page.document.querySelector(`input[name="${name}"][value="${value}"]`);
  const ui = await openPane(
    "paneAppearance",
    opened => radio(opened, "sval-switcher", "menu")?.checkVisibility(),
    "Appearance showing the switcher's choice"
  );
  atTaskEnd(() => Services.prefs.clearUserPref(SWITCHER_PREF));
  const options = ui.byId("sval-strip-options");
  Assert.ok(radio(ui, "sval-switcher", "menu").checked, "the menu by default");
  Assert.ok(!options.checkVisibility(), "and the strip's choices hidden");

  radio(ui, "sval-switcher", "strip").click();
  Assert.equal(
    Services.prefs.getStringPref(SWITCHER_PREF),
    "strip",
    "a card writes the choice"
  );
  await TestUtils.waitForCondition(
    () => SvalPanel._els.strip.checkVisibility(),
    "the panel showing the strip"
  );
  Assert.ok(options.checkVisibility(), "the strip's choices show");
  Assert.ok(
    radio(ui, "sval-strip-names", "all").checked,
    "names on every Workspace by default"
  );
  Assert.ok(
    radio(ui, "sval-strip-at", "below").checked,
    "each name under its icon by default"
  );
  Assert.ok(
    radio(ui, "sval-strip-wheel", "slide").checked,
    "and the wheel sliding the strip"
  );

  radio(ui, "sval-strip-at", "beside").click();
  atTaskEnd(() => Services.prefs.clearUserPref(STRIP_NAMES_AT_PREF));
  await TestUtils.waitForCondition(
    () => SvalPanel._els.strip.dataset.at === "beside",
    "the strip putting names beside their icons"
  );

  const at = ui.byId("sval-strip-at-options");
  Assert.ok(at.checkVisibility(), "where names sit shows with names");
  radio(ui, "sval-strip-names", "none").click();
  await TestUtils.waitForCondition(
    () => !at.checkVisibility(),
    "where names sit hidden with icons only"
  );

  Services.prefs.setStringPref(STRIP_NAMES_PREF, "current");
  atTaskEnd(() => Services.prefs.clearUserPref(STRIP_NAMES_PREF));
  await TestUtils.waitForCondition(
    () => radio(ui, "sval-strip-names", "current").checked,
    "a change from the strip's menu moves the choice"
  );

  radio(ui, "sval-switcher", "menu").click();
  await TestUtils.waitForCondition(
    () => SvalPanel._els.switcher.checkVisibility(),
    "the panel showing the menu's button again"
  );
  Assert.ok(!options.checkVisibility(), "the strip's choices hidden again");
});
