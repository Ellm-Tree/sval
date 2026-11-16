/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Privacy and protection's blocking card (protections spec §1.5): the
 * levels, read-only curated lists, an edit that switches to Custom from the
 * level's lists with Undo, the confirmation that leaves Custom, allowing a
 * synced trusted list, and the allowed domains.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const {
  ALLOWED_DOMAIN_BRANCH,
  SvalBlocking,
  CUSTOM_LIST_BRANCH,
  USER_LIST_BRANCH,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);

const BLOCKING_PREFS = [
  "browser.sval.adblock.customFrom",
  "browser.sval.adblock.userListsConfirmed",
];

// The level, its lists and the prefs Sval and Firefox derive from them, as
// this file found them.
keepPrefs(
  "browser.sval.adblock.",
  "privacy.trackingprotection.",
  "privacy.query_stripping.",
  "browser.contentblocking.category"
);

/**
 * Starts each task at Balanced with no custom set and no allowed domains,
 * and puts the prefs back when it ends.
 */
async function atBalanced() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.adblock.level", "balanced"]],
    clear: BLOCKING_PREFS.map(name => [name]),
  });
  clearPrefBranches(
    CUSTOM_LIST_BRANCH,
    USER_LIST_BRANCH,
    ALLOWED_DOMAIN_BRANCH
  );
}

/**
 * Opens settings afresh at Privacy and protection.
 *
 * @returns {Promise<object>} the page, `byId`, and the blocking card.
 */
async function openBlocking() {
  const ui = await openPane(
    "privacy",
    ({ byId }) => byId("sval-blocking")?.checkVisibility(),
    "the blocking card is showing"
  );
  return { ...ui, card: ui.byId("sval-blocking") };
}

/**
 * @param {object} ui From `openBlocking`.
 * @param {string} value
 * @returns {HTMLInputElement} the level radio with that value.
 */
const levelRadio = (ui, value) =>
  ui.card.querySelector(`input[name="sval-blocking-level"][value="${value}"]`);

/**
 * @param {object} ui From `openBlocking`.
 * @returns {Element[]} the list rows drawn now.
 */
const listRows = ui => [
  ...ui
    .byId("sval-blocking-lists")
    .querySelectorAll('[role="listitem"][data-sval-list]'),
];

add_task(async function levels_render_and_curated_lists_are_read_only() {
  await atBalanced();
  const ui = await openBlocking();
  Assert.deepEqual(
    [...ui.card.querySelectorAll('input[name="sval-blocking-level"]')].map(
      radio => radio.value
    ),
    SvalBlocking.LEVELS,
    "every level has a radio"
  );
  Assert.ok(levelRadio(ui, "balanced").checked, "Balanced is the one shown");

  const rows = listRows(ui);
  Assert.deepEqual(
    rows.map(row => row.dataset.svalList).sort(),
    [...SvalBlocking.listsForLevel("balanced")].sort(),
    "the rows are Balanced's lists"
  );
  Assert.ok(
    rows.every(row => !row.querySelector('input[role="switch"]')),
    "and none can be switched"
  );
  Assert.ok(ui.byId("sval-blocking-customize"), "Customize lists is offered");
});

add_task(async function an_edit_under_balanced_switches_to_custom_with_undo() {
  await atBalanced();
  const balanced = SvalBlocking.listsForLevel("balanced");
  const ui = await openBlocking();

  ui.byId("sval-blocking-customize").click();
  await TestUtils.waitForCondition(
    () => SvalBlocking.level === "custom",
    "Customize lists switches to Custom"
  );
  Assert.deepEqual(
    [...SvalBlocking.listsForLevel("custom")].sort(),
    [...balanced].sort(),
    "starting from Balanced's lists"
  );
  await TestUtils.waitForCondition(
    () => levelRadio(ui, "custom").checked,
    "the Custom radio follows"
  );
  const lists = ui.byId("sval-blocking-lists");
  const status = ui.byId("sval-blocking-status");
  Assert.equal(
    status.dataset.customFrom,
    "balanced",
    "the card says where Custom started"
  );

  // Every list Sval knows is drawn now, each with a switch.
  const first = lists.querySelector(
    `input[role="switch"][data-sval-list="${balanced[0]}"]`
  );
  Assert.ok(first?.checked, "a Balanced list starts on");
  Assert.equal(
    lists.querySelectorAll('input[role="switch"]').length,
    SvalBlocking.catalog().length,
    "every known list has a switch"
  );
  first.click();
  await TestUtils.waitForCondition(
    () => !SvalBlocking.activeListIds().includes(balanced[0]),
    "switching a list off takes it out"
  );

  const undo = status.querySelector('[data-sval-key="blocking-undo"]');
  Assert.ok(!undo, "an edit inside Custom forgets the switch's Undo");
});

add_task(async function undo_restores_balanced() {
  await atBalanced();
  const ui = await openBlocking();
  ui.byId("sval-blocking-customize").click();
  const status = ui.byId("sval-blocking-status");
  let undo;
  await TestUtils.waitForCondition(() => {
    undo = status.querySelector('[data-sval-key="blocking-undo"]');
    return undo;
  }, "Undo is offered after the switch");
  undo.click();
  await TestUtils.waitForCondition(
    () => SvalBlocking.level === "balanced",
    "Undo goes back to Balanced"
  );
  await TestUtils.waitForCondition(
    () => levelRadio(ui, "balanced").checked,
    "and the radio follows"
  );
});

add_task(async function leaving_custom_for_strict_confirms() {
  await atBalanced();
  await SvalBlocking.customize();
  const ui = await openBlocking();
  const dialog = ui.byId("sval-blocking-dialog");

  levelRadio(ui, "strict").click();
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens");
  Assert.equal(
    dialog.dataset.confirm,
    "level:strict",
    "it asks to switch to Strict"
  );
  Assert.equal(SvalBlocking.level, "custom", "nothing changes before it");

  await closeDialog(
    dialog,
    () => ui.byId("sval-blocking-dialog-cancel").click(),
    "Cancel closes it"
  );
  Assert.equal(SvalBlocking.level, "custom", "and keeps Custom");
  Assert.ok(levelRadio(ui, "custom").checked, "with its radio");

  levelRadio(ui, "strict").click();
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens again");
  ui.byId("sval-blocking-dialog-confirm").click();
  await TestUtils.waitForCondition(
    () => SvalBlocking.level === "strict",
    "confirming switches to Strict"
  );
  Assert.deepEqual(
    [...SvalBlocking.activeListIds()].sort(),
    [...SvalBlocking.listsForLevel("strict")].sort(),
    "with Strict's lists"
  );
});

add_task(async function an_allowed_domain_is_kept() {
  await atBalanced();
  const ui = await openBlocking();
  const allowed = ui.byId("sval-allowed");
  allowed.querySelector('[data-sval-key="add-domain"]').click();
  const input = allowed.querySelector(".sval-agent-add-input");
  Assert.ok(input, "the add row opens");
  input.value = "cdn.example.com";
  input.dispatchEvent(new ui.page.Event("input"));
  allowed.querySelector('[data-sval-key="adding-domain-add"]').click();
  await TestUtils.waitForCondition(
    () => SvalBlocking.allowedDomains().includes("cdn.example.com"),
    "the domain is allowed"
  );
  await TestUtils.waitForCondition(
    () => allowed.querySelector('[data-sval-domain="cdn.example.com"]'),
    "and listed"
  );
});

/**
 * Each add row's field keeps a label above it while the user types: the
 * list address, the allowed domain and the site. The label is the name a
 * screen reader gives the field.
 */
add_task(async function each_add_row_labels_its_field() {
  await atBalanced();
  const ui = await openBlocking();
  const rows = [
    ["privacy", "sval-blocking-lists", "add-list"],
    ["privacy", "sval-allowed", "add-domain"],
    ["svalSites", "sval-sites", "add-site"],
  ];
  for (const [category, id, button] of rows) {
    await showPane(ui.page, category);
    ui.byId(id).querySelector(`[data-sval-key="${button}"]`).click();
    const input = await TestUtils.waitForCondition(
      () => ui.byId(id).querySelector(".sval-agent-add-input"),
      `${button} opens its row`
    );
    input.value = "a";
    input.dispatchEvent(new ui.page.Event("input"));
    Assert.notEqual(
      input.placeholder,
      input.labels[0]?.textContent.trim(),
      "the placeholder is an example"
    );
    await assertShownLabel(input);
  }
});

add_task(async function the_breach_warnings_switch_sets_the_pref() {
  await SpecialPowers.pushPrefEnv({
    clear: [["browser.sval.breachWarnings"]],
  });
  const ui = await openBlocking();
  const toggle = ui.byId("sval-breach-warnings");
  ok(toggle.checkVisibility(), "shown outside any Advanced");
  ok(toggle.checked, "on by default");
  toggle.click();
  ok(
    !Services.prefs.getBoolPref("browser.sval.breachWarnings"),
    "turning it off turns breach warnings off"
  );
  toggle.click();
  ok(Services.prefs.getBoolPref("browser.sval.breachWarnings"), "and back on");
  await SpecialPowers.popPrefEnv();
});

add_task(async function the_page_rules_switch_is_advanced_and_sets_the_pref() {
  await atBalanced();
  await SpecialPowers.pushPrefEnv({
    clear: [["browser.sval.adblock.pageRules"]],
  });
  const ui = await openBlocking();
  const toggle = ui.byId("sval-page-rules");
  ok(!toggle.checkVisibility(), "tucked away in the card's Advanced");
  ui.byId("sval-blocking-advanced").querySelector("summary").click();
  ok(toggle.checkVisibility(), "shown once Advanced opens");
  ok(toggle.checked, "on by default");
  toggle.click();
  ok(
    !Services.prefs.getBoolPref("browser.sval.adblock.pageRules"),
    "turning it off turns page rules off"
  );
  toggle.click();
  ok(
    Services.prefs.getBoolPref("browser.sval.adblock.pageRules"),
    "and back on"
  );
});

add_task(async function allowing_a_synced_trusted_list_says_it_is_trusted() {
  await atBalanced();
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.adblock.updates.enabled", false]],
  });
  const urls = [
    "https://lists.example.com/kept.txt",
    "https://lists.example.com/declined.txt",
  ];
  // As sync delivers them: trusted on another device, never allowed here.
  for (const url of urls) {
    Services.prefs.setStringPref(
      USER_LIST_BRANCH + SvalBlockingLists.userListId(url),
      JSON.stringify({ url, category: "ads", trusted: true })
    );
  }
  const [kept, declined] = urls.map(url => SvalBlockingLists.userListId(url));
  SvalBlocking.setListEnabled(kept, true);
  SvalBlocking.setListEnabled(declined, true);
  SvalBlocking.flush();
  const listed = id => SvalBlocking.catalog().find(list => list.id == id);
  const ui = await openBlocking();
  const dialog = ui.byId("sval-blocking-dialog");
  const alt = ui.byId("sval-blocking-dialog-alt");
  const allow = id =>
    ui
      .byId("sval-blocking-lists")
      .querySelector(`[data-sval-key="allow-list:${id}"]`);

  await TestUtils.waitForCondition(() => allow(kept), "Allow is offered");
  allow(kept).click();
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens");
  Assert.equal(dialog.dataset.confirm, "allow", "it asks to allow and trust");
  Assert.ok(alt.checkVisibility(), "and offers to allow it untrusted");
  await closeDialog(
    dialog,
    () => ui.byId("sval-blocking-dialog-cancel").click(),
    "Cancel closes it"
  );
  Assert.ok(!SvalBlockingLists.isConfirmed(urls[0]), "leaving it waiting");
  await TestUtils.waitForCondition(
    () => !alt.checkVisibility(),
    "and Allow untrusted goes"
  );

  allow(kept).click();
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens again");
  await closeDialog(
    dialog,
    () => ui.byId("sval-blocking-dialog-confirm").click(),
    "confirming closes it"
  );
  await TestUtils.waitForCondition(
    () => SvalBlockingLists.isConfirmed(urls[0]),
    "confirming allows the list"
  );
  Assert.ok(listed(kept).trusted, "and keeps it trusted");

  allow(declined).click();
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens");
  alt.click();
  await TestUtils.waitForCondition(
    () => SvalBlockingLists.isConfirmed(urls[1]),
    "Allow untrusted allows the list"
  );
  await TestUtils.waitForCondition(
    () => !listed(declined).trusted,
    "without its trust"
  );
  Assert.ok(!dialog.open, "and closes the dialog");
  SvalBlocking.flush();
});

/**
 * @param {object} ui From `openBlocking`.
 * @returns {Promise<void>} once the page has the keyboard.
 */
function focusPage(ui) {
  return within(SimpleTest.promiseFocus(ui.page), 10_000, "the page's focus");
}

/**
 * A keyboard user keeps their place while the card redraws: Customize
 * lists hands focus to the Undo it offers, a list's switch keeps it when
 * pressed, and Undo hands it to the level it went back to.
 */
add_task(async function the_keyboard_keeps_its_place_in_the_lists() {
  await atBalanced();
  const ui = await openBlocking();
  const doc = ui.page.document;
  await focusPage(ui);

  ui.byId("sval-blocking-customize").focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, ui.page);
  await TestUtils.waitForCondition(
    () =>
      SvalBlocking.level === "custom" &&
      doc.activeElement.dataset.svalKey === "blocking-undo",
    "Customize lists hands focus to its Undo"
  );
  Assert.ok(
    ui.byId("sval-blocking-status").contains(doc.activeElement),
    "the Undo in the card's status line"
  );

  const id = SvalBlocking.listsForLevel("balanced")[0];
  const switchOf = () =>
    ui
      .byId("sval-blocking-lists")
      .querySelector(`input[role="switch"][data-sval-list="${id}"]`);
  switchOf().focus();
  EventUtils.synthesizeKey(" ", {}, ui.page);
  await TestUtils.waitForCondition(
    () => !SvalBlocking.activeListIds().includes(id),
    "Space turns the list off"
  );
  await TestUtils.waitForCondition(
    () => !switchOf().checked,
    "and the redrawn switch says so"
  );
  Assert.equal(doc.activeElement, switchOf(), "focus stays on the switch");
});

add_task(async function undo_hands_focus_to_the_level_it_restored() {
  await atBalanced();
  const ui = await openBlocking();
  const doc = ui.page.document;
  await focusPage(ui);
  ui.byId("sval-blocking-customize").click();
  let undo;
  await TestUtils.waitForCondition(
    () => (undo = ui.byId("sval-blocking-status").querySelector("button")),
    "Undo is offered"
  );
  undo.focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, ui.page);
  await TestUtils.waitForCondition(
    () => SvalBlocking.level === "balanced",
    "Undo goes back to Balanced"
  );
  await TestUtils.waitForCondition(
    () => doc.activeElement === levelRadio(ui, "balanced"),
    "and focus goes to Balanced's radio"
  );
});

/**
 * Removing an allowed domain from the keyboard puts focus on its Undo, and
 * Undo puts it on the domain's Remove again. The card's status line is in
 * the accessibility tree before it says anything, so what it says is
 * announced.
 */
add_task(async function removing_a_domain_hands_focus_to_undo_and_back() {
  await atBalanced();
  await SvalBlocking.addAllowedDomain("cdn.example.com");
  const ui = await openBlocking();
  const doc = ui.page.document;
  const status = ui.byId("sval-allowed-status");
  Assert.ok(!status.hasChildNodes(), "nothing to say yet");
  const acc = await accessibleOf(status);
  Assert.equal(acc.role, Ci.nsIAccessibleRole.ROLE_STATUSBAR, "as a status");

  await focusPage(ui);
  const remove = () =>
    ui
      .byId("sval-allowed")
      .querySelector('[data-sval-key="remove-domain:cdn.example.com"]');
  remove().focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, ui.page);
  await TestUtils.waitForCondition(
    () => !SvalBlocking.allowedDomains().includes("cdn.example.com"),
    "the domain is removed"
  );
  await TestUtils.waitForCondition(
    () => doc.activeElement === status.querySelector("button"),
    "focus is on Undo"
  );
  Assert.ok(
    status.textContent.includes("cdn.example.com"),
    "beside what happened, naming the domain"
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, ui.page);
  await TestUtils.waitForCondition(
    () => SvalBlocking.allowedDomains().includes("cdn.example.com"),
    "Undo allows it again"
  );
  await TestUtils.waitForCondition(
    () => doc.activeElement === remove(),
    "and focus is on its Remove"
  );
});

/**
 * At twice the text size each add row stays usable: its label, field,
 * choice and buttons show their text whole, inside the row, wrapping as
 * they need to, and each category still fits the window's width.
 */
add_task(async function the_add_rows_fit_twice_the_text_size() {
  await atBalanced();
  const ui = await openBlocking();
  atTwiceTheText(ui);
  for (const [category, id, button] of [
    ["privacy", "sval-blocking-lists", "add-list"],
    ["privacy", "sval-allowed", "add-domain"],
    ["svalSites", "sval-sites", "add-site"],
  ]) {
    await showPane(ui.page, category);
    ui.byId(id).querySelector(`[data-sval-key="${button}"]`).click();
    const row = await TestUtils.waitForCondition(
      () => ui.byId(id).querySelector(".sval-agent-adding"),
      `${button} opens its row`
    );
    assertRowFits(row, button);
    assertPaneFits(ui, category);
  }
});
