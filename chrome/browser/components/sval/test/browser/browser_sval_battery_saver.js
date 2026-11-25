/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Battery Saver (`SvalBatterySaver`): when its mode and the power source turn
 * it on, what it changes while on, Turn Off for Now and Turn On for Now, the
 * header's button and the Tools menu's item.
 *
 * A stand-in takes the battery's place, so the computer's own power source
 * never reaches a task. The manifest sets the mode to "never" for every
 * other file; each task here sets the mode it is about.
 */

const {
  SvalBatterySaver,
  BUTTON_ID,
  PANEL_ID,
  MENU_ITEM_ID,
  SAVER_PREFS,
  MODE_PREF,
  BATTERY_SAVER_UNLOAD_MS,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBatterySaver.sys.mjs"
);
const { hiddenWorkspaceUnloadMs, HIDDEN_WORKSPACE_UNLOAD_MS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
  );

const defaults = Services.prefs.getDefaultBranch("");
/** Each pref's default while Battery Saver is off, read before any task. */
const ORIGINALS = Object.fromEntries(
  Object.keys(SAVER_PREFS).map(name => [name, defaults.getIntPref(name)])
);

/**
 * A battery that reports `charging` and fires `chargingchange` as a
 * `BatteryManager` does, put in the battery's place until the task ends.
 *
 * @param {boolean} charging
 * @returns {object} `{ plug(charging) }`, which changes the power source.
 */
function standInBattery(charging) {
  const stand = new EventTarget();
  stand.charging = charging;
  const restore = SvalBatterySaver.useBatteryForTests(stand);
  atTaskEnd(restore);
  return {
    plug(value) {
      stand.charging = value;
      stand.dispatchEvent(new Event("chargingchange"));
    },
  };
}

/** @param {string} mode */
async function useMode(mode) {
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, mode]] });
}

/**
 * Asserts each pref holds Battery Saver's value on the default branch while
 * `on`, and its own default otherwise, with no user value written.
 *
 * @param {boolean} on
 */
function assertPrefs(on) {
  for (const [name, value] of Object.entries(SAVER_PREFS)) {
    Assert.equal(
      defaults.getIntPref(name),
      on ? value : ORIGINALS[name],
      `${name}'s default while Battery Saver is ${on ? "on" : "off"}`
    );
    Assert.ok(
      !Services.prefs.prefHasUserValue(name),
      `${name} has no user value`
    );
  }
}

add_task(async function the_mode_and_the_power_source_turn_it_on() {
  const battery = standInBattery(true);
  const cases = [
    ["always", true, true],
    ["always", false, true],
    ["unplugged", true, false],
    ["unplugged", false, true],
    ["never", true, false],
    ["never", false, false],
  ];
  for (const [mode, charging, on] of cases) {
    await useMode(mode);
    battery.plug(charging);
    Assert.equal(
      SvalBatterySaver.active,
      on,
      `mode ${mode}, ${charging ? "plugged in" : "on battery"}`
    );
    assertPrefs(on);
    Assert.equal(
      hiddenWorkspaceUnloadMs(),
      on ? BATTERY_SAVER_UNLOAD_MS : HIDDEN_WORKSPACE_UNLOAD_MS,
      "a hidden Workspace's sleep delay"
    );
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function a_value_the_user_set_wins() {
  standInBattery(true);
  const name = "gfx.display.max-frame-rate";
  await SpecialPowers.pushPrefEnv({ set: [[name, 30]] });
  await useMode("always");
  Assert.ok(SvalBatterySaver.active, "Battery Saver is on");
  Assert.equal(Services.prefs.getIntPref(name), 30, "the user's value holds");
  Assert.equal(defaults.getIntPref(name), SAVER_PREFS[name], "under it");
  await SpecialPowers.popPrefEnv();
  Assert.equal(defaults.getIntPref(name), ORIGINALS[name], "default put back");
  await SpecialPowers.popPrefEnv();
});

add_task(async function an_override_lasts_until_the_power_source_changes() {
  const battery = standInBattery(false);
  await useMode("unplugged");
  Assert.ok(SvalBatterySaver.active, "on battery, Battery Saver is on");

  SvalBatterySaver.toggleForNow();
  Assert.ok(!SvalBatterySaver.active, "Turn Off for Now turns it off");
  assertPrefs(false);
  battery.plug(false);
  Assert.ok(!SvalBatterySaver.active, "a report of no change keeps it off");

  battery.plug(true);
  Assert.ok(!SvalBatterySaver.active, "plugged in, the mode keeps it off");
  SvalBatterySaver.toggleForNow();
  Assert.ok(SvalBatterySaver.active, "Turn On for Now turns it on");
  assertPrefs(true);

  battery.plug(false);
  Assert.ok(SvalBatterySaver.active, "unplugged, the mode keeps it on");
  battery.plug(true);
  Assert.ok(!SvalBatterySaver.active, "plugged in again, the mode rules");
  assertPrefs(false);
});

add_task(async function a_choice_in_settings_ends_an_override() {
  standInBattery(false);
  await useMode("unplugged");
  SvalBatterySaver.toggleForNow();
  Assert.ok(!SvalBatterySaver.active, "Turn Off for Now turns it off");

  await useMode("always");
  Assert.ok(SvalBatterySaver.active, "choosing Always turns it on");
  assertPrefs(true);
});

add_task(async function the_button_shows_while_on_and_turns_it_off() {
  const battery = standInBattery(true);
  await useMode("unplugged");
  const button = document.getElementById(BUTTON_ID);
  Assert.ok(button.hidden, "plugged in, no button");

  battery.plug(false);
  Assert.ok(!button.hidden, "on battery, the button shows");
  Assert.equal(
    button.previousElementSibling?.id,
    "split-view-button",
    "after the split button, the address pill's neighbour"
  );

  const panel = () => document.getElementById(PANEL_ID);
  const shown = BrowserTestUtils.waitForEvent(
    document.getElementById("mainPopupSet"),
    "popupshown",
    false,
    event => event.target.id === PANEL_ID
  );
  button.click();
  await within(shown, 10_000, "the Battery Saver popover opening");
  const off = panel().querySelector('[data-action="off"]');
  const hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
  off.click();
  await within(hidden, 10_000, "the popover closing");
  Assert.ok(!SvalBatterySaver.active, "Turn Off for Now turned it off");
  Assert.ok(button.hidden, "and the button went");
});

add_task(async function the_popover_links_to_the_setting() {
  const battery = standInBattery(false);
  await useMode("unplugged");
  battery.plug(false);
  const shown = BrowserTestUtils.waitForEvent(
    document.getElementById("mainPopupSet"),
    "popupshown",
    false,
    event => event.target.id === PANEL_ID
  );
  document.getElementById(BUTTON_ID).click();
  await within(shown, 10_000, "the Battery Saver popover opening");
  document
    .getElementById(PANEL_ID)
    .querySelector('[data-action="settings"]')
    .click();
  const settingsTab = () =>
    [...gBrowser.tabs].find(t =>
      t.linkedBrowser.currentURI?.spec.startsWith("about:preferences")
    );
  await TestUtils.waitForCondition(
    () => settingsTab()?.linkedBrowser.contentWindow?.SvalSettings?._els,
    "Settings opens with Sval's panes"
  );
  const tab = expectOpened(settingsTab());
  const page = tab.linkedBrowser.contentWindow;
  await TestUtils.waitForCondition(
    () =>
      page.document
        .querySelector(
          '[data-category="paneSync"] setting-group[groupid="svalBatterySaver"]'
        )
        ?.checkVisibility(),
    "General shows Battery Saver"
  );
  const choice = page.document.querySelector(
    "#setting-control-svalBatterySaverMode moz-radio-group"
  );
  await TestUtils.waitForCondition(
    () => choice?.value === "unplugged",
    "the choice reads the mode"
  );
  await TestUtils.waitForCondition(
    () => choice.matches(":focus-within"),
    "the caret is on the choice"
  );
});

/**
 * Runs a menu item's command as choosing it does, without opening the menu
 * bar, which macOS draws natively.
 *
 * @param {Element} item
 */
function choose(item) {
  item.dispatchEvent(new Event("command"));
}

add_task(async function the_tools_menu_item_follows_and_flips_it() {
  const battery = standInBattery(true);
  await useMode("unplugged");
  const item = document.getElementById(MENU_ITEM_ID);
  Assert.equal(
    item.parentNode.id,
    "menu_ToolsPopup",
    "the item is in the Tools menu"
  );
  Assert.equal(item.getAttribute("type"), "checkbox", "as a checkbox");
  Assert.equal(item.getAttribute("checked"), "false", "unchecked while off");

  choose(item);
  Assert.ok(SvalBatterySaver.active, "choosing it turns it on for now");
  Assert.equal(item.getAttribute("checked"), "true", "checked while on");
  Assert.ok(!document.getElementById(BUTTON_ID).hidden, "the button shows");

  choose(item);
  Assert.ok(!SvalBatterySaver.active, "choosing it again turns it off");
  Assert.equal(item.getAttribute("checked"), "false", "unchecked again");

  battery.plug(false);
  Assert.equal(item.getAttribute("checked"), "true", "on battery, checked");
});
