/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_styles_helpers.js */

// Colorshift's dialog (site styles spec §3): it opens on its own, apart from
// Site settings, and stays open while the page reloads, the window loses
// focus or the person works in the page. Changes show at once and are kept
// only by Save; Cancel, its Close button, Escape and a tab switch put the
// page back as the dialog found it. The keyboard alone works every control,
// the wheel's dots follow the pointer, and the dialog moves by its title.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_styles_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

/** A blue tint at 60 percent. */
const TINT = { hue: 220, strength: 60, complement: 55 };

/** @returns {object[]} the saved styles. */
function saved() {
  return JSON.parse(Services.prefs.getStringPref(STYLES_PREF, "[]") || "[]");
}

/**
 * Presses Tab until `id` has the focus, failing past `limit` presses.
 *
 * @param {string} id
 */
function tabTo(id) {
  for (let left = 30; left && document.activeElement?.id !== id; left--) {
    EventUtils.synthesizeKey("KEY_Tab");
  }
  Assert.equal(document.activeElement?.id, id, `Tab reaches ${id}`);
}

/**
 * Presses one of the dialog's buttons and waits for it to close.
 *
 * @param {string} id
 */
async function pressToClose(id) {
  const hidden = BrowserTestUtils.waitForPopupEvent(editor(), "hidden");
  byId(id).click();
  await within(hidden, 10_000, `${id} closing the dialog`);
}

/**
 * Turns the accent dot a quarter of the way round with the keyboard, which
 * changes the tint the page shows.
 */
function turnTheTint() {
  byId("sval-style-accent").focus();
  for (let i = 0; i < 6; i++) {
    EventUtils.synthesizeKey("KEY_ArrowRight", { shiftKey: true });
  }
}

add_task(async function the_editor_stays_open_while_the_person_works() {
  const tab = await openPage(STYLE_PAGE);
  const browser = tab.linkedBrowser;
  await openFromSiteMenu();

  await within(BrowserTestUtils.reloadTab(tab), 10_000, "the page reloading");
  await pageReady(browser, STYLE_PAGE);
  Assert.equal(editor().state, "open", "a reload leaves the editor open");

  await BrowserTestUtils.synthesizeMouseAtCenter("#text", {}, browser);
  Assert.equal(editor().state, "open", "a click in the page leaves it open");

  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "another window opening"
  );
  await within(SimpleTest.promiseFocus(other), 10_000, "the other window");
  Assert.equal(
    editor().state,
    "open",
    "another window taking the focus leaves it open"
  );
  await within(
    BrowserTestUtils.closeWindow(other),
    10_000,
    "the other window closing"
  );
  await within(SimpleTest.promiseFocus(window), 10_000, "this window again");
  Assert.equal(editor().state, "open", "and it is there on return");

  const hidden = BrowserTestUtils.waitForPopupEvent(editor(), "hidden");
  byId("sval-style-close").click();
  await within(hidden, 10_000, "Close closing the editor");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function escape_close_and_a_tab_switch_close_it() {
  const tab = await openPage(STYLE_PAGE);
  await openFromSiteMenu();
  editor().querySelector("#sval-style-font").focus();
  let hidden = BrowserTestUtils.waitForPopupEvent(editor(), "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await within(hidden, 10_000, "Escape closing the dialog");

  await openFromSiteMenu();
  await pressToClose("sval-style-close");

  await openFromSiteMenu();
  hidden = BrowserTestUtils.waitForPopupEvent(editor(), "hidden");
  const other = await openPage(`https://example.org${STYLE_PATH}`);
  await within(hidden, 10_000, "a tab switch closing it");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function it_opens_on_its_own_beside_site_settings() {
  const tab = await openPage(STYLE_PAGE);
  await openFromSiteMenu();
  const menu = byId("sval-site-menu");
  const button = byId("sval-site-menu-button");
  Assert.equal(menu.state, "closed", "Site settings closes as it opens");
  Assert.ok(!button.hasAttribute("open"), "its button is not left open");
  Assert.ok(
    !button.hasAttribute("sval-stem"),
    "nor joined to the dialog, which has no stem"
  );
  Assert.equal(editor().anchorNode, null, "the dialog has no anchor");

  const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  button.click();
  await within(menuShown, 10_000, "Site settings opening beside it");
  Assert.equal(editor().state, "open", "the dialog stays open beside it");
  const menuHidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(menuHidden, 10_000, "Site settings closing");
  Assert.equal(editor().state, "open", "and is there once it closes");
  await closeEditor();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function save_keeps_the_changes_and_cancel_puts_back_the_page() {
  SvalSiteStyles.setStyle("example.com", TINT);
  registerCleanupFunction(() => Services.prefs.clearUserPref(STYLES_PREF));
  const tab = await openPage(STYLE_PAGE);
  const browser = tab.linkedBrowser;
  const before = await drawnBackground(browser);
  const kept = Services.prefs.getStringPref(STYLES_PREF);

  for (const [how, close] of [
    ["Cancel", () => pressToClose("sval-style-cancel")],
    ["Close", () => pressToClose("sval-style-close")],
    [
      "Escape",
      async () => {
        const hidden = BrowserTestUtils.waitForPopupEvent(editor(), "hidden");
        EventUtils.synthesizeKey("KEY_Escape");
        await within(hidden, 10_000, "Escape closing the dialog");
      },
    ],
  ]) {
    await openFromSiteMenu();
    turnTheTint();
    await until(
      async () => !sameColor(await drawnBackground(browser), before),
      `the page showing the change before ${how}`
    );
    Assert.equal(
      Services.prefs.getStringPref(STYLES_PREF),
      kept,
      "nothing is saved while the dialog is open"
    );
    await close();
    await until(
      async () => sameColor(await drawnBackground(browser), before),
      `${how} putting back the page as the dialog found it`
    );
    Assert.equal(
      Services.prefs.getStringPref(STYLES_PREF),
      kept,
      `${how} keeps the saved style`
    );
  }

  await openFromSiteMenu();
  turnTheTint();
  await pressToClose("sval-style-save");
  Assert.notEqual(saved()[0].hue, TINT.hue, "Save keeps the new tint");
  const after = await drawnBackground(browser);
  Assert.ok(!sameColor(after, before), "and the page shows it");
  await within(BrowserTestUtils.reloadTab(tab), 10_000, "the page reloading");
  await pageReady(browser, STYLE_PAGE);
  Assert.ok(sameColor(await drawnBackground(browser), after), "on every visit");
  Services.prefs.clearUserPref(STYLES_PREF);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function reset_shows_the_sites_own_look_until_save() {
  const tab = await openPage(STYLE_PAGE);
  const browser = tab.linkedBrowser;
  await openFromSiteMenu();
  byId("sval-style-accent").focus();
  for (let i = 0; i < 8; i++) {
    EventUtils.synthesizeKey("KEY_ArrowUp");
  }
  await until(
    async () => !sameColor(await drawnBackground(browser), WHITE_RGB),
    "the page showing an unsaved tint"
  );
  byId("sval-style-reset").click();
  await until(
    async () => sameColor(await drawnBackground(browser), WHITE_RGB),
    "Reset putting back the site's own look with nothing saved"
  );
  Assert.equal(editor().state, "open", "Reset leaves the dialog open");
  Assert.equal(
    byId("sval-style-accent").dataset.strength,
    "0",
    "the wheel is back at its middle"
  );
  await pressToClose("sval-style-save");
  Assert.ok(!saved().length, "Save after Reset saves no style");

  SvalSiteStyles.setStyle("example.com", TINT);
  registerCleanupFunction(() => Services.prefs.clearUserPref(STYLES_PREF));
  await until(
    async () => !sameColor(await drawnBackground(browser), WHITE_RGB),
    "the saved tint on the page"
  );
  const kept = Services.prefs.getStringPref(STYLES_PREF);
  await openFromSiteMenu();
  byId("sval-style-reset").click();
  await until(
    async () => sameColor(await drawnBackground(browser), WHITE_RGB),
    "Reset showing the site's own look at once"
  );
  Assert.equal(
    byId("sval-style-accent").dataset.strength,
    "0",
    "the wheel is back at its middle"
  );
  await pressToClose("sval-style-cancel");
  await until(
    async () => !sameColor(await drawnBackground(browser), WHITE_RGB),
    "Cancel undoing the reset"
  );
  Assert.equal(Services.prefs.getStringPref(STYLES_PREF), kept, "still saved");

  await openFromSiteMenu();
  byId("sval-style-reset").click();
  await pressToClose("sval-style-save");
  Assert.ok(!saved().length, "Save after Reset removes the saved style");
  await until(
    async () => sameColor(await drawnBackground(browser), WHITE_RGB),
    "the page keeping its own look"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function site_settings_marks_a_saved_colorshift() {
  const tab = await openPage(STYLE_PAGE);
  const menu = byId("sval-site-menu");
  const showMenu = async () => {
    await menuReady();
    const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    byId("sval-site-menu-button").click();
    await within(menuShown, 10_000, "Site settings showing");
  };
  const hideMenu = async () => {
    const menuHidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.hidePopup();
    await within(menuHidden, 10_000, "Site settings closing");
  };
  await showMenu();
  Assert.ok(!byId("sval-site-style-dot"), "no dot without a Colorshift");
  const plain = byId("sval-site-style-sub").textContent;
  await hideMenu();

  SvalSiteStyles.setStyle("example.com", { ...TINT, theme: "dark" });
  registerCleanupFunction(() => Services.prefs.clearUserPref(STYLES_PREF));
  await showMenu();
  Assert.ok(byId("sval-site-style-dot"), "the Colorshift row carries the dot");
  Assert.ok(
    byId("sval-site-menu-button").hasAttribute("sval-styled"),
    "as the button does"
  );
  Assert.notEqual(
    byId("sval-site-style-sub").textContent,
    plain,
    "and its second line names what is applied"
  );
  await hideMenu();
  Services.prefs.clearUserPref(STYLES_PREF);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_keyboard_works_every_control() {
  const tab = await openPage(STYLE_PAGE);
  await openFromSiteMenu();
  await until(
    () => editor().contains(document.activeElement),
    "the focus in the dialog"
  );

  // The accent dot: up and down move it out from the middle, which is the
  // tint's strength, and left and right turn its hue.
  tabTo("sval-style-accent");
  const accent = byId("sval-style-accent");
  Assert.equal(accent.getAttribute("role"), "slider", "the dot is a slider");
  Assert.equal(accent.dataset.strength, "0", "it starts in the middle");
  for (let i = 0; i < 8; i++) {
    EventUtils.synthesizeKey("KEY_ArrowUp");
  }
  Assert.equal(accent.dataset.strength, "40", "ArrowUp strengthening");
  EventUtils.synthesizeKey("KEY_ArrowRight", { shiftKey: true });
  Assert.equal(accent.getAttribute("aria-valuenow"), "235", "Shift+ArrowRight");
  Assert.ok(
    accent.getAttribute("aria-valuetext"),
    "the dot gives its hue and strength in words"
  );

  // The second dot turns on its own, at the accent's strength.
  tabTo("sval-style-second");
  EventUtils.synthesizeKey("KEY_ArrowLeft");
  Assert.equal(
    byId("sval-style-second").getAttribute("aria-valuenow"),
    "285",
    "ArrowLeft turning the second dot"
  );

  // A slider moves a step at a time.
  tabTo("sval-style-brightness");
  EventUtils.synthesizeKey("KEY_ArrowLeft");
  Assert.equal(byId("sval-style-brightness").value, "-5", "ArrowLeft");

  // The font's button opens its menu.
  tabTo("sval-style-font");
  const shown = BrowserTestUtils.waitForEvent(
    document,
    "popupshown",
    false,
    event => event.target.id === "sval-style-font-menu"
  );
  EventUtils.synthesizeKey("KEY_Enter");
  await within(shown, 10_000, "Enter opening the font menu");
  const fonts = byId("sval-style-font-menu");
  const hidden = BrowserTestUtils.waitForPopupEvent(fonts, "hidden");
  fonts.activateItem(menuItem({ popup: fonts }, "serif"));
  await within(hidden, 10_000, "the font menu closing");
  await until(
    () => byId("sval-style-font")?.dataset.font === "serif",
    "the font chosen"
  );

  // The arrow keys pick the theme, from Automatic. Each pick is dispatched
  // again on the item's host, which has no accessible of its own
  // (`pickTheme`, sval_site_styles_helpers.js).
  tabTo("sval-style-theme-auto");
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  EventUtils.synthesizeKey("KEY_ArrowRight");
  EventUtils.synthesizeKey("KEY_ArrowRight");
  AccessibilityUtils.resetEnv();
  await until(() => byId("sval-style-theme").value === "dark", "Dark picked");

  // Save, from the keyboard, keeps every change.
  tabTo("sval-style-save");
  const closed = BrowserTestUtils.waitForPopupEvent(editor(), "hidden");
  EventUtils.synthesizeKey(" ");
  await within(closed, 10_000, "Save closing the dialog");
  Assert.deepEqual(
    saved()[0],
    {
      scope: "example.com",
      hue: 235,
      strength: 40,
      complement: 50,
      brightness: -5,
      theme: "dark",
      font: "serif",
    },
    "Save keeps what the controls show"
  );
  Services.prefs.clearUserPref(STYLES_PREF);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_dots_follow_the_pointer() {
  const tab = await openPage(STYLE_PAGE);
  const browser = tab.linkedBrowser;
  await openFromSiteMenu();
  const wheel = () => editor().querySelector(".sval-style-wheel");
  const { width } = wheel().getBoundingClientRect();
  const middle = width / 2;
  const accent = byId("sval-style-accent");

  // The wheel's surface takes the pointer for its dots, which are the
  // controls the keyboard and a screen reader use, so a press on the bare
  // wheel lands on no control.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  registerCleanupFunction(() => AccessibilityUtils.resetEnv());

  // A drag to the right of the middle, at half the wheel's reach: hue 90,
  // half strength. The page shows the tint while the pointer is down.
  EventUtils.synthesizeMouse(wheel(), middle, middle, { type: "mousedown" });
  EventUtils.synthesizeMouse(wheel(), middle + width * 0.25, middle, {
    type: "mousemove",
  });
  await until(
    async () => !sameColor(await drawnBackground(browser), WHITE_RGB),
    "the page showing the tint as the dot is dragged"
  );
  EventUtils.synthesizeMouse(wheel(), middle + width * 0.25, middle, {
    type: "mouseup",
  });
  // A pointer lands on a whole pixel, so the values are near the ones aimed at.
  const hue = Number(accent.getAttribute("aria-valuenow"));
  const strength = Number(accent.dataset.strength);
  Assert.lessOrEqual(Math.abs(hue - 90), 2, "the angle is the hue");
  Assert.lessOrEqual(
    Math.abs(strength - 50),
    2,
    "the distance is the strength"
  );

  // The second dot is dragged around the circle and keeps its distance.
  const second = byId("sval-style-second");
  EventUtils.synthesizeMouseAtCenter(second, { type: "mousedown" });
  EventUtils.synthesizeMouse(wheel(), middle, middle + width * 0.3, {
    type: "mousemove",
  });
  EventUtils.synthesizeMouse(wheel(), middle, middle + width * 0.3, {
    type: "mouseup",
  });
  Assert.lessOrEqual(
    Math.abs(Number(second.getAttribute("aria-valuenow")) - 180),
    2,
    "the second dot turning to the bottom"
  );
  Assert.equal(accent.dataset.strength, String(strength), "the strength stays");

  // The accent dot reaches the wheel's rim: every color at full strength.
  EventUtils.synthesizeMouse(wheel(), middle, 1, { type: "mousedown" });
  EventUtils.synthesizeMouse(wheel(), middle, 1, { type: "mouseup" });
  Assert.greaterOrEqual(
    Number(accent.dataset.strength),
    98,
    "the rim giving the full strength"
  );
  AccessibilityUtils.resetEnv();

  await closeEditor();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_dialog_moves_by_its_title() {
  const tab = await openPage(STYLE_PAGE);
  await openFromSiteMenu();
  const before = editor().getOuterScreenRect();
  // The dialog is held by its title row, a surface with no control in it,
  // as the element picker's card is, so the press lands on no control.
  const head = editor().querySelector(".sval-prot-status");
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  const x = 100;
  const y = head.getBoundingClientRect().height / 2;
  // Each point is taken against the title where it stands then, and it
  // moves with the pointer: the release lands where the move left it.
  EventUtils.synthesizeMouse(head, x, y, { type: "mousedown" });
  EventUtils.synthesizeMouse(head, x - 80, y, { type: "mousemove" });
  await until(
    () => before.left - editor().getOuterScreenRect().left >= 79,
    "the dialog following the pointer"
  );
  EventUtils.synthesizeMouse(head, x, y, { type: "mouseup" });
  AccessibilityUtils.resetEnv();
  await until(() => {
    const after = editor().getOuterScreenRect();
    return Math.abs(before.left - after.left - 80) <= 2;
  }, "the dialog following the drag");
  Assert.equal(editor().state, "open", "and staying open");
  await closeEditor();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function forced_colours_keep_the_buttons_and_tracks_drawn() {
  const tab = await openPage(STYLE_PAGE);
  window.browsingContext.forcedColorsOverride = "active";
  registerCleanupFunction(() => {
    window.browsingContext.forcedColorsOverride = "none";
  });
  await until(
    () => window.matchMedia("(forced-colors)").matches,
    "forced colours on"
  );
  const edged = el => {
    const style = getComputedStyle(el);
    return style.borderTopStyle === "solid" && style.borderTopWidth !== "0px";
  };

  await menuReady();
  const menu = byId("sval-site-menu");
  const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  byId("sval-site-menu-button").click();
  await within(menuShown, 10_000, "Site settings showing");
  const zoomReset = menu.querySelector(".sval-site-zoom-reset");
  Assert.ok(edged(zoomReset), "Zoom's Reset has an edge");
  const menuHidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(menuHidden, 10_000, "Site settings closing");

  await openFromSiteMenu();
  Assert.ok(edged(byId("sval-style-cancel")), "Cancel has an edge");
  Assert.equal(
    getComputedStyle(byId("sval-style-brightness"), "::-moz-range-track")
      .borderTopStyle,
    "solid",
    "a slider's track is outlined"
  );
  await closeEditor();
  window.browsingContext.forcedColorsOverride = "none";
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_press_anywhere_on_the_row_opens_it() {
  SvalSiteStyles.setStyle("example.com", TINT);
  registerCleanupFunction(() => Services.prefs.clearUserPref(STYLES_PREF));
  const tab = await openPage(STYLE_PAGE);
  const menu = byId("sval-site-menu");
  // The row's whole area is its button: its name, the line under it and
  // the icon, the dot on it included.
  for (const id of [
    "sval-site-style",
    "sval-site-style-sub",
    "sval-site-style-dot",
  ]) {
    await menuReady();
    const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    byId("sval-site-menu-button").click();
    await within(menuShown, 10_000, "Site settings showing");
    const shown = BrowserTestUtils.waitForPopupEvent(editor(), "shown");
    let target = null;
    byId("sval-site-style").addEventListener(
      "click",
      event => (target = event.target.id),
      { once: true }
    );
    // A synthesized press dispatches its click before it returns.
    EventUtils.synthesizeMouseAtCenter(byId(id), {});
    Assert.equal(target, "sval-site-style", `a press on #${id} reaches it`);
    if (!target) {
      menu.hidePopup();
      continue;
    }
    await within(shown, 10_000, "the dialog showing");
    await closeEditor();
  }
  BrowserTestUtils.removeTab(tab);
});
