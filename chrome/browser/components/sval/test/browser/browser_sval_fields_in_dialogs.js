/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * Sval's dialogs draw their fields as `sval-field` in the dialog's own
 * palette (`sval-dialog.css`), over a solid window, a Workspace's tinted
 * window and a see-through window, where the dialog is frosted: the field's
 * fill and edge are the dialog's field colours, its edge lights in the
 * dialog's focus colour under the pointer, an error draws in the dialog's
 * error colour, and no rule of the in-content sheet `SubDialog` puts in the
 * page reaches it. A dialog that opens with a field focuses it with its text
 * selected (decision 2713).
 *
 * The window shows what is behind it here as it does on macOS, whatever the
 * platform the test runs on, as in `browser_sval_dialog_frosted.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

const { openSvalDialog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDialog.sys.mjs"
);
const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

const COLOR = "green";

add_setup(async function a_window_that_can_be_see_through() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  registerCleanupFunction(closeLeftoverDialog);
  const own = Object.getOwnPropertyDescriptor(SvalPanel, "seeThrough");
  SvalPanel.seeThrough = () =>
    SvalColor.seeThroughMaterial("macosx", query => matchMedia(query).matches);
  registerCleanupFunction(() => {
    if (own) {
      Object.defineProperty(SvalPanel, "seeThrough", own);
    } else {
      delete SvalPanel.seeThrough;
    }
    return within(SvalPanel.refresh(), 10_000, "the panel redrawing");
  });
});

/**
 * Gives the Workspace this window shows {@link COLOR} at `transparency`, or
 * no colour at all for `null`. The file's end puts the document back.
 *
 * @param {number|null} transparency
 */
async function lookOfWindow(transparency) {
  const color = transparency === null ? null : COLOR;
  await SvalPanel.engine.mutate({
    kind: "setAppearance",
    id: SvalWindowWorkspace.of(window).id,
    color,
    emoji: null,
    transparency: transparency ?? 0,
    now: Date.now(),
  });
  await within(SvalPanel.refresh(), 10_000, "the panel redrawing");
  await TestUtils.waitForCondition(
    () => (SvalPanel._tintArgs?.[0] ?? null) === color,
    "the window wears the look"
  );
}

/**
 * The colour `value` resolves to in `doc`'s root.
 *
 * @param {Document} doc
 * @param {string} value A colour or `var(--…)`.
 * @returns {object}
 */
function colourIn(doc, value) {
  const probe = doc.createElement("span");
  probe.style.color = value;
  doc.body.append(probe);
  const seen = InspectorUtils.colorToRGBA(
    doc.defaultView.getComputedStyle(probe).color
  );
  probe.remove();
  return seen;
}

/**
 * The colour of `prop` on `el`'s native control while `locks` hold.
 *
 * @param {Element} el
 * @param {string} prop
 * @param {string[]} [locks]
 * @returns {object}
 */
function drawn(el, prop, locks = []) {
  const inner = fieldInner(el);
  locks.forEach(l => InspectorUtils.addPseudoClassLock(inner, l));
  const seen = InspectorUtils.colorToRGBA(
    inner.documentGlobal.getComputedStyle(inner)[prop]
  );
  locks.forEach(l => InspectorUtils.removePseudoClassLock(inner, l));
  return seen;
}

const LOOK = [
  "color",
  "background-color",
  "border-top-color",
  "border-top-width",
  "border-top-left-radius",
  "min-height",
  "padding-left",
  "font-size",
  "font-family",
  "box-shadow",
  "outline-style",
  "opacity",
  "appearance",
];

/**
 * Asserts that `el` looks the same with every sheet in its page that is not
 * Sval's on and off, at rest, under the pointer and focused.
 *
 * @param {Element} el
 * @param {string} what
 */
function assertNoFirefoxSheet(el, what) {
  const doc = el.ownerDocument;
  const sheets = InspectorUtils.getAllStyleSheets(doc, true).filter(
    s => s.href && !s.href.startsWith("chrome://browser/content/sval/")
  );
  const inner = fieldInner(el);
  const look = () =>
    [[], [":hover"], [":focus-visible"]].map(locks => {
      locks.forEach(l => InspectorUtils.addPseudoClassLock(inner, l));
      const cs = inner.documentGlobal.getComputedStyle(inner);
      const out = Object.fromEntries(
        LOOK.map(p => [p, cs.getPropertyValue(p)])
      );
      locks.forEach(l => InspectorUtils.removePseudoClassLock(inner, l));
      return out;
    });
  const withSheets = look();
  sheets.forEach(s => (s.disabled = true));
  const without = look();
  sheets.forEach(s => (s.disabled = false));
  Assert.deepEqual(
    without,
    withSheets,
    `${what}: no rule of Firefox's sheets reaches the field`
  );
}

/**
 * Opens the general dialog with a name field holding "Reading".
 *
 * @returns {Promise<{answer: Promise, doc: Document, field: Element}>}
 */
async function openedWithField() {
  const answer = openSvalDialog(window, {
    title: "Rename this group",
    primary: "Rename",
    field: { label: "Name", value: "Reading" },
  });
  const { doc } = await openedSvalDialog();
  const field = doc.getElementById("sval-dialog-input");
  await fieldDrawn(field);
  return { answer, doc, field };
}

/**
 * Checks the general dialog's field in the window as it is.
 *
 * @param {string} what The window's look.
 */
async function checkTheField(what) {
  const { answer, doc, field } = await openedWithField();
  Assert.equal(field.localName, "sval-field", `${what}: a sval-field`);
  Assert.equal(doc.activeElement, field, `${what}: it has the focus`);
  Assert.deepEqual(
    [field.selectionStart, field.selectionEnd],
    [0, field.value.length],
    `${what}: with its text selected`
  );
  // At rest and under the pointer, away from the focus.
  doc.querySelector('[data-button="cancel"]').focus();
  Assert.deepEqual(
    drawn(field, "backgroundColor"),
    colourIn(doc, "var(--sval-dialog-field)"),
    `${what}: its fill is the dialog's field colour`
  );
  Assert.deepEqual(
    drawn(field, "borderTopColor"),
    colourIn(doc, "var(--sval-dialog-field-border)"),
    `${what}: and its edge`
  );
  Assert.deepEqual(
    drawn(field, "borderTopColor", [":hover"]),
    colourIn(doc, "var(--sval-dialog-focus)"),
    `${what}: the edge lights in the dialog's focus colour under the pointer`
  );
  Assert.deepEqual(
    drawn(field, "borderTopColor", [":focus-visible"]),
    colourIn(doc, "var(--sval-dialog-focus)"),
    `${what}: and when focused`
  );
  assertNoFirefoxSheet(field, what);

  field.focus();
  EventUtils.synthesizeKey("KEY_Backspace", {}, doc.defaultView);
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  await fieldDrawn(field);
  Assert.ok(field.error, `${what}: an empty name shows an error`);
  Assert.equal(
    fieldInner(field).ariaInvalid,
    "true",
    `${what}: which marks the field invalid`
  );
  Assert.deepEqual(
    drawn(field, "borderTopColor"),
    colourIn(doc, "var(--sval-dialog-error)"),
    `${what}: and draws its edge in the dialog's error colour`
  );
  Assert.deepEqual(
    drawn(field, "borderTopColor", [":hover"]),
    colourIn(doc, "var(--sval-dialog-error)"),
    `${what}: under the pointer too`
  );
  Assert.deepEqual(
    drawn(field, "borderTopColor", [":focus-visible"]),
    colourIn(doc, "var(--sval-dialog-error)"),
    `${what}: and while focused`
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the dialog's answer");
}

add_task(async function a_dialog_field_over_a_solid_window() {
  await lookOfWindow(null);
  await checkTheField("solid");
});

add_task(async function a_dialog_field_over_a_tinted_window() {
  await lookOfWindow(0);
  await checkTheField("tinted");
});

add_task(async function a_dialog_field_over_a_see_through_window() {
  await lookOfWindow(0.5);
  Assert.ok(
    document.documentElement.hasAttribute("data-sval-see-through"),
    "the window shows what is behind it"
  );
  await checkTheField("frosted");
});

add_task(async function the_dialog_puts_back_the_caret_it_refits_around() {
  let page = null;
  const answer = openSvalDialog(window, {
    title: "Rename this group",
    primary: "Rename",
    field: { label: "Name", value: "Reading" },
    onOpen: p => (page = p),
  });
  const { doc } = await openedSvalDialog();
  const field = doc.getElementById("sval-dialog-input");
  field.setSelectionRange(2, 2);
  page.update({ body: "Its tabs stay where they are." });
  await TestUtils.waitForCondition(
    () => doc.getElementById("sval-dialog-body").checkVisibility(),
    "the body shows"
  );
  Assert.equal(doc.activeElement, field, "the field keeps the focus");
  Assert.deepEqual(
    [field.selectionStart, field.selectionEnd],
    [2, 2],
    "and the caret where the user had it"
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the dialog's answer");
});

add_task(async function the_edit_dialog_selects_the_name() {
  const { ids } = await withFreshPanel();
  await chooseOnRow(ids.groupA, "edit");
  const doc = await dialogDocument(".sval-nw-name");
  const name = doc.querySelector(".sval-nw-name");
  await fieldDrawn(name);
  Assert.equal(name.localName, "sval-field", "the name is a sval-field");
  await TestUtils.waitForCondition(
    () => doc.activeElement === name,
    "the name has the focus"
  );
  Assert.deepEqual(
    [name.selectionStart, name.selectionEnd],
    [0, name.value.length],
    "with the group's name selected"
  );
  assertNoFirefoxSheet(name, "the name");
  EventUtils.synthesizeKey("KEY_Backspace", {}, doc.defaultView);
  doc.querySelector(".sval-nw-create").click();
  await fieldDrawn(name);
  Assert.ok(name.error, "an empty name shows its error on the field");
  Assert.equal(fieldInner(name).ariaInvalid, "true", "which marks it invalid");
  doc.querySelector(".sval-nw-cancel").click();
  await dialogGone(doc);
});

add_task(async function the_emoji_search_clears_with_its_own_button() {
  const { ids } = await withFreshPanel();
  await chooseOnRow(ids.groupA, "edit");
  const doc = await dialogDocument(".sval-nw-name");
  doc.querySelector(".sval-nw-emoji").click();
  const picker = await dialogDocument(".sval-emoji-choice");
  const search = picker.querySelector(".sval-emoji-search");
  await fieldDrawn(search);
  Assert.equal(search.localName, "sval-field", "the search is a sval-field");
  Assert.equal(search.type, "search", "of the search kind");
  await TestUtils.waitForCondition(
    () => picker.activeElement === search,
    "the search has the focus"
  );
  assertNoFirefoxSheet(search, "the emoji search");
  const shown = () =>
    [...picker.querySelectorAll(".sval-emoji-choice")].filter(b =>
      b.checkVisibility()
    ).length;
  const all = shown();
  EventUtils.sendString("fish", picker.defaultView);
  await TestUtils.waitForCondition(
    () => shown() < all,
    "typing narrows the emoji"
  );
  const clear = search.shadowRoot.getElementById("clear");
  await fieldDrawn(search);
  Assert.ok(clear.checkVisibility(), "the clear button shows");
  // The clear button stays out of the Tab order, because Escape empties a
  // search from the keyboard.
  AccessibilityUtils.setEnv({ focusableRule: false });
  EventUtils.synthesizeMouseAtCenter(clear, {}, picker.defaultView);
  AccessibilityUtils.resetEnv();
  await TestUtils.waitForCondition(
    () => shown() === all,
    "its press shows every emoji again"
  );
  Assert.equal(search.value, "", "with the search empty");
  Assert.equal(picker.activeElement, search, "and the focus in it");
  picker.defaultView.close();
  const reopened = await dialogDocument(".sval-nw-name");
  reopened.querySelector(".sval-nw-cancel").click();
  await dialogGone(reopened);
});
