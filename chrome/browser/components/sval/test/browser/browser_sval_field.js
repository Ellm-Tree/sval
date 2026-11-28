/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * `sval-field` (`elements/sval-field.mjs`) behaves as a native field: a label
 * names and focuses it; typing fires `input` as each key lands and `change`
 * once the edit is committed, and a value set from code fires nothing; its
 * form reads its value, resets it and refuses to submit while a required
 * one is empty; Enter submits the form exactly when Enter in a native field
 * would; `error` shows under it and reaches the accessible description.
 * The browser window registers the element (`SvalWindow.mount`), so the
 * tasks build their fields in it.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * A box over the window's content holding `children`, removed when the task
 * ends.
 *
 * @param {...Node} children
 * @returns {Element}
 */
function stage(...children) {
  const box = document.createElementNS(HTML_NS, "div");
  box.style.cssText =
    "position: fixed; inset-block-start: 120px; inset-inline-start: 120px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px; padding: 8px; width: 400px";
  box.append(...children);
  document.documentElement.append(box);
  atTaskEnd(() => box.remove());
  return box;
}

/**
 * A new element of `tag` in the HTML namespace with `attrs`.
 *
 * @param {string} tag
 * @param {object} [attrs]
 * @param {...Node|string} children
 * @returns {Element}
 */
function make(tag, attrs = {}, ...children) {
  const el = document.createElementNS(HTML_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, value);
  }
  el.append(...children);
  return el;
}

/**
 * Counts the `input` and `change` events `el` hears, in order.
 *
 * @param {Element} el
 * @returns {string[]}
 */
function eventsOf(el) {
  const seen = [];
  for (const type of ["input", "change"]) {
    el.addEventListener(type, event => {
      Assert.equal(event.target, el, `${type} comes from the element`);
      seen.push(type);
    });
  }
  return seen;
}

add_task(async function a_label_names_and_focuses_it() {
  const forLabel = make("label", { for: "probe-name" }, "Device name");
  const named = make("sval-field", { id: "probe-name" });
  const wrapped = make("sval-field", { size: "compact" });
  const wrapping = make("label", {}, make("span", {}, "Folder"), wrapped);
  const ariaNamed = make("sval-field", { "aria-label": "Search sites" });
  const heading = make("span", { id: "probe-heading" }, "Rate limit");
  const byId = make("sval-field", {
    type: "number",
    "aria-labelledby": "probe-heading",
  });
  const password = make("sval-field", {
    type: "password",
    "aria-label": "Password",
  });
  stage(forLabel, named, wrapping, ariaNamed, heading, byId, password);
  for (const el of [named, wrapped, ariaNamed, byId, password]) {
    await fieldDrawn(el);
  }
  Assert.equal(
    customElements.get("sval-field")?.name,
    "SvalField",
    "the window registers the element"
  );

  clickLabel(forLabel);
  Assert.equal(document.activeElement, named, "a <label for> click focuses it");
  Assert.equal(
    named.shadowRoot.activeElement,
    fieldInner(named),
    "and its native field"
  );
  clickLabel(wrapping.firstChild);
  Assert.equal(
    document.activeElement,
    wrapped,
    "a click on a label around it focuses it"
  );

  for (const [el, name, role] of [
    [named, "Device name", Ci.nsIAccessibleRole.ROLE_ENTRY],
    [wrapped, "Folder", Ci.nsIAccessibleRole.ROLE_ENTRY],
    [ariaNamed, "Search sites", Ci.nsIAccessibleRole.ROLE_ENTRY],
    [byId, "Rate limit", Ci.nsIAccessibleRole.ROLE_SPINBUTTON],
    [password, "Password", Ci.nsIAccessibleRole.ROLE_PASSWORD_TEXT],
  ]) {
    const acc = await accessibleOf(fieldInner(el));
    Assert.equal(acc.role, role, `"${name}" has its field's role`);
    Assert.equal(acc.name, name, `named "${name}"`);
  }
  Assert.ok(
    !ariaNamed.hasAttribute("aria-label"),
    "aria-label moves to the native field"
  );
  // The element can be a box of its own in the accessible tree, around the
  // one field.
  const host = await accessibleOf(named);
  Assert.notEqual(host.role, Ci.nsIAccessibleRole.ROLE_ENTRY, "no field");
  Assert.equal(host.childCount, 1, "around its one field");
});

add_task(async function an_error_shows_and_describes_it() {
  const note = make("p", { id: "probe-note" }, "Letters and digits");
  const label = make("label", { for: "probe-code" }, "Code");
  const el = make("sval-field", {
    id: "probe-code",
    "aria-describedby": "probe-note",
  });
  stage(label, el, note);
  await fieldDrawn(el);
  let acc = await accessibleOf(fieldInner(el));
  Assert.equal(acc.description, "Letters and digits", "its note describes it");
  Assert.ok(
    !fieldInner(el).hasAttribute("aria-invalid"),
    "without an error it is not invalid"
  );
  const error = el.shadowRoot.getElementById("error");
  Assert.ok(!error.checkVisibility(), "no error shows");

  el.error = "That code has expired";
  await fieldDrawn(el);
  Assert.ok(error.checkVisibility(), "the error shows");
  Assert.equal(error.textContent, el.error, "under the field");
  Assert.equal(
    fieldInner(el).getAttribute("aria-invalid"),
    "true",
    "the field is marked invalid"
  );
  await TestUtils.waitForCondition(
    () =>
      accessibleOf(fieldInner(el)).then(
        a => a.description === "Letters and digits That code has expired"
      ),
    "the error joins the description"
  );
  acc = await accessibleOf(fieldInner(el));
  Assert.equal(acc.name, "Code", "the error stays out of its name");
  const state = {};
  acc.getState(state, {});
  Assert.ok(
    state.value & Ci.nsIAccessibleStates.STATE_INVALID,
    "the accessible is invalid"
  );
  Assert.ok(el.checkValidity(), "an error alone does not block a submit");

  el.error = "";
  await fieldDrawn(el);
  Assert.ok(!error.checkVisibility(), "cleared, the error goes");
  Assert.ok(
    !fieldInner(el).hasAttribute("aria-invalid"),
    "and the field is valid again"
  );
});

add_task(
  async function typing_fires_input_then_change_and_code_fires_nothing() {
    const el = make("sval-field", { "aria-label": "Name" });
    const after = make("sval-field", { "aria-label": "Next" });
    stage(el, after);
    await fieldDrawn(el);
    const seen = eventsOf(el);

    el.value = "set by code";
    await fieldDrawn(el);
    Assert.equal(fieldInner(el).value, "set by code", "the field shows it");
    Assert.deepEqual(seen, [], "a value set from code fires nothing");

    await typeInto(el, "Work");
    Assert.equal(el.value, "Work", "typing sets the value");
    Assert.deepEqual(
      seen.filter(t => t === "change"),
      [],
      "typing fires no change yet"
    );
    Assert.equal(
      seen.filter(t => t === "input").length,
      5,
      "an input for the deletion and each key"
    );
    seen.length = 0;
    after.focus();
    Assert.deepEqual(seen, ["change"], "leaving the field commits it once");

    seen.length = 0;
    el.focus();
    after.focus();
    Assert.deepEqual(seen, [], "leaving it unchanged fires nothing");

    // A native field fires `change` for a user's edit alone
    // (`HTMLInputElement::FireChangeEventIfNeeded`).
    el.focus();
    el.value = "From code";
    await fieldDrawn(el);
    after.focus();
    Assert.deepEqual(
      seen,
      [],
      "a value set from code while it has focus commits nothing"
    );
    el.value = "Unfocused";
    await fieldDrawn(el);
    el.focus();
    after.focus();
    Assert.deepEqual(seen, [], "nor one set while it has no focus");
    await typeInto(el, "Typed");
    el.value = "Grouped";
    await fieldDrawn(el);
    seen.length = 0;
    after.focus();
    Assert.deepEqual(
      seen,
      ["change"],
      "an edit, then a value code set over it, commits on leaving"
    );
    seen.length = 0;

    await typeInto(el, "Home");
    seen.length = 0;
    EventUtils.synthesizeKey("KEY_Enter");
    Assert.deepEqual(seen, ["change"], "Enter commits it once");
    after.focus();
    Assert.deepEqual(seen, ["change"], "and leaving after adds nothing");
  }
);

/**
 * A form holding `fields` and `buttons`, counting its submits.
 *
 * @param {Element[]} children
 * @returns {{form: Element, submits: {count: number}}}
 */
function formOf(...children) {
  const form = make("form", {}, ...children);
  const submits = { count: 0 };
  form.addEventListener("submit", event => {
    event.preventDefault();
    submits.count++;
  });
  stage(form);
  return { form, submits };
}

add_task(async function its_form_reads_resets_and_validates_it() {
  const el = make("sval-field", {
    name: "device",
    value: "Laptop",
    "aria-label": "Device",
  });
  const code = make("sval-field", {
    name: "code",
    required: "",
    "aria-label": "Code",
  });
  const submit = make("button", { type: "submit" }, "Join");
  const { form, submits } = formOf(el, code, submit);
  await fieldDrawn(el);
  await fieldDrawn(code);

  Assert.equal(el.value, "Laptop", "the value attribute is its first value");
  Assert.equal(el.form, form, "its form owns it");
  await typeInto(el, "Desk");
  Assert.equal(
    new FormData(form).get("device"),
    "Desk",
    "the form reads what was typed"
  );

  Assert.ok(!code.checkValidity(), "the empty required field is invalid");
  Assert.ok(code.validity.valueMissing, "for want of a value");
  Assert.equal(
    code.validationMessage,
    fieldInner(code).validationMessage,
    "with the native field's message"
  );
  Assert.ok(!form.checkValidity(), "and so is its form");

  await typeInto(code, "ABCD");
  Assert.ok(code.checkValidity(), "typed in, it is valid");
  EventUtils.synthesizeMouseAtCenter(submit, {});
  Assert.equal(submits.count, 1, "and the form submits");
  Assert.equal(new FormData(form).get("code"), "ABCD");

  form.reset();
  await fieldDrawn(el);
  Assert.equal(el.value, "Laptop", "a reset puts the first value back");
  Assert.equal(fieldInner(el).value, "Laptop", "and shows it");
  Assert.equal(code.value, "", "and empties the field with none");
});

add_task(async function a_required_field_left_empty_stops_a_submit() {
  // A form refuses an invalid submit where the form validation actor runs
  // (`FormValidationChild`, which cancels `MozInvalidForm`): in a page such
  // as Settings, and in no chrome window, where a native field's form
  // submits too.
  const ui = await openSettings();
  await showPane(ui.page, "svalSync");
  const doc = ui.page.document;
  const code = doc.createElement("sval-field");
  code.setAttribute("required", "");
  code.setAttribute("aria-label", "Code");
  const submit = doc.createElement("button");
  submit.type = "submit";
  submit.textContent = "Join";
  const form = doc.createElement("form");
  form.append(code, submit);
  const submits = { count: 0 };
  form.addEventListener("submit", event => {
    event.preventDefault();
    submits.count++;
  });
  paneOf(ui.page, "svalSync").querySelector(".sval-card").append(form);
  atTaskEnd(() => form.remove());
  await fieldDrawn(code);

  EventUtils.synthesizeMouseAtCenter(submit, {}, ui.page);
  Assert.equal(submits.count, 0, "a required field left empty stops a submit");
  Assert.equal(
    doc.activeElement,
    code,
    "and the refused submit takes the focus to it"
  );
  Assert.equal(
    code.shadowRoot.activeElement,
    fieldInner(code),
    "its native field, which the form's message points at"
  );
  await typeInto(code, "ABCD");
  EventUtils.synthesizeMouseAtCenter(submit, {}, ui.page);
  Assert.equal(submits.count, 1, "filled in, the form submits");
});

add_task(async function enter_submits_as_from_a_native_field() {
  // A default button, Sval's own: one submit, through its click.
  const name = make("sval-field", { "aria-label": "Name" });
  const other = make("sval-field", { "aria-label": "Other" });
  const join = make("sval-button", { type: "primary", submit: "" }, "Join");
  const withButton = formOf(name, other, join);
  await fieldDrawn(join);
  const clicks = { count: 0 };
  join.addEventListener("click", () => clicks.count++);
  await typeInto(name, "x");
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(withButton.submits.count, 1, "Enter submits once");
  Assert.equal(clicks.count, 1, "through a click of the default button");

  join.disabled = true;
  await fieldDrawn(join);
  name.focus();
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(
    withButton.submits.count,
    1,
    "while the default button is disabled, Enter submits nothing"
  );

  // One field and no button.
  const alone = make("sval-field", { "aria-label": "Alone" });
  const single = formOf(alone);
  await typeInto(alone, "y");
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(single.submits.count, 1, "one field alone submits once");

  // Two fields and no button: a native form submits nothing.
  const first = make("sval-field", { "aria-label": "First" });
  const second = make("input", { type: "text", "aria-label": "Second" });
  const pair = formOf(first, second);
  await typeInto(first, "z");
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(pair.submits.count, 0, "two fields and no button: nothing");

  // A textarea takes Enter as a new line.
  const notes = make("sval-field", { multiline: "", "aria-label": "Notes" });
  const notesButton = make("button", { type: "submit" }, "Send");
  const multi = formOf(notes, notesButton);
  await typeInto(notes, "line");
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(multi.submits.count, 0, "Enter in a textarea submits nothing");
  Assert.equal(notes.value, "line\n", "it adds a line");

  // A listener that takes the key keeps the form.
  alone.addEventListener("keypress", event => event.preventDefault(), {
    once: true,
  });
  alone.focus();
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(single.submits.count, 1, "a cancelled Enter submits nothing");
});

add_task(async function enter_while_composing_submits_nothing() {
  const el = make("sval-field", { "aria-label": "Name" });
  const { submits } = formOf(el, make("button", { type: "submit" }, "Go"));
  await fieldDrawn(el);
  el.focus();
  EventUtils.synthesizeCompositionChange({
    composition: {
      string: "か",
      clauses: [{ length: 1, attr: Ci.nsITextInputProcessor.ATTR_RAW_CLAUSE }],
    },
    caret: { start: 1, length: 0 },
    key: { key: "KEY_Enter" },
  });
  Assert.equal(
    submits.count,
    0,
    "Enter that an input method takes submits nothing"
  );
  EventUtils.synthesizeComposition({
    type: "compositioncommitasis",
    key: { key: "KEY_Enter" },
  });
  Assert.equal(submits.count, 0, "nor the Enter that commits the composition");
  Assert.equal(el.value, "か", "which lands in the field");
});

add_task(async function disabled_and_readonly_take_no_typing() {
  const before = make("sval-field", { "aria-label": "Before" });
  const off = make("sval-field", {
    disabled: "",
    value: "kept",
    "aria-label": "Off",
  });
  const fixed = make("sval-field", {
    readonly: "",
    value: "ABCD-EFGH",
    "aria-label": "Fixed",
  });
  const inFieldset = make("sval-field", { "aria-label": "In fieldset" });
  const fieldset = make("fieldset", {}, inFieldset);
  stage(before, off, fixed, fieldset);
  for (const el of [before, off, fixed, inFieldset]) {
    await fieldDrawn(el);
  }

  Assert.ok(fieldInner(off).disabled, "the native field is disabled");
  before.focus();
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.notEqual(document.activeElement, off, "Tab passes a disabled one by");
  off.focus();
  Assert.notEqual(document.activeElement, off, "focus() leaves it alone");

  fixed.focus();
  Assert.equal(document.activeElement, fixed, "a read-only one takes focus");
  EventUtils.sendString("x");
  Assert.equal(fixed.value, "ABCD-EFGH", "and no typing");

  fieldset.disabled = true;
  await fieldDrawn(inFieldset);
  Assert.ok(fieldInner(inFieldset).disabled, "a disabled fieldset disables it");
  fieldset.disabled = false;
  await fieldDrawn(inFieldset);
  Assert.ok(!fieldInner(inFieldset).disabled, "and enabling it enables it");
});

add_task(async function autoselect_selects_its_text_on_focus() {
  const before = make("sval-field", { "aria-label": "Before" });
  const el = make("sval-field", {
    autoselect: "",
    readonly: "",
    value: "ABCD-EFGH",
    "aria-label": "Code",
  });
  stage(before, el);
  await fieldDrawn(el);
  before.focus();
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(document.activeElement, el, "Tab reaches it");
  Assert.deepEqual(
    [el.selectionStart, el.selectionEnd],
    [0, 9],
    "Tab selects all of it"
  );
  before.focus();
  EventUtils.synthesizeMouse(fieldInner(el), 10, 10, {});
  Assert.deepEqual(
    [el.selectionStart, el.selectionEnd],
    [0, 9],
    "a click into it selects all of it"
  );
  EventUtils.synthesizeMouse(fieldInner(el), 10, 10, {});
  Assert.equal(
    el.selectionStart,
    el.selectionEnd,
    "a second click puts the caret"
  );
});

add_task(async function the_selection_api_acts_on_its_field() {
  const el = make("sval-field", { value: "pairing", "aria-label": "Word" });
  stage(el);
  await fieldDrawn(el);
  el.focus();
  el.setSelectionRange(2, 5);
  Assert.deepEqual(
    [el.selectionStart, el.selectionEnd],
    [2, 5],
    "setSelectionRange selects"
  );
  Assert.deepEqual(
    [fieldInner(el).selectionStart, fieldInner(el).selectionEnd],
    [2, 5],
    "in the native field"
  );
  el.select();
  Assert.deepEqual([el.selectionStart, el.selectionEnd], [0, 7], "select()");
  el.selectionStart = 3;
  el.selectionEnd = 3;
  EventUtils.sendString("_");
  Assert.equal(el.value, "pai_ring", "typing lands at the caret set");
});

add_task(async function a_moved_field_keeps_what_was_typed() {
  const el = make("sval-field", { value: "first", "aria-label": "Name" });
  const box = stage(el);
  await typeInto(el, "typed");
  const other = make("div");
  box.append(other);
  other.append(el);
  await fieldDrawn(el);
  Assert.equal(el.value, "typed", "moving the field keeps its value");
  Assert.equal(fieldInner(el).value, "typed", "and shows it");
});

add_task(async function focus_selects_its_text() {
  const el = make("sval-field", { value: "Work", "aria-label": "Name" });
  stage(el);
  await fieldDrawn(el);
  el.focus();
  Assert.equal(document.activeElement, el, "focus() focuses it");
  Assert.deepEqual(
    [el.selectionStart, el.selectionEnd],
    [0, 4],
    "with all of its text selected"
  );
  EventUtils.sendString("Home");
  Assert.equal(el.value, "Home", "so typing replaces the text");

  el.blur();
  EventUtils.synthesizeMouse(fieldInner(el), 10, 10, {});
  Assert.equal(document.activeElement, el, "a click into it focuses it");
  Assert.equal(
    el.selectionStart,
    el.selectionEnd,
    "with the caret where the click put it"
  );
});

/**
 * The user agent's own part of `inner` that implements `pseudo`, as
 * `forms.css` draws it.
 *
 * @param {Element} inner A native field.
 * @param {string} pseudo
 * @returns {Element|null}
 */
function nativePart(inner, pseudo) {
  const walk = node => {
    for (const child of InspectorUtils.getChildrenForNode(node, true, false)) {
      if (child.implementedPseudoElement === pseudo) {
        return child;
      }
      const found = child.nodeType === Node.ELEMENT_NODE && walk(child);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return walk(inner);
}

add_task(async function a_search_draws_its_own_clear_button() {
  const el = make("sval-field", { type: "search", "aria-label": "Find" });
  stage(el);
  await fieldDrawn(el);
  const clear = el.shadowRoot.getElementById("clear");
  Assert.ok(el.shadowRoot.querySelector(".magnifier"), "it draws a magnifier");
  Assert.ok(!clear.checkVisibility(), "and no clear button while empty");
  const native = nativePart(fieldInner(el), "::-moz-search-clear-button");
  Assert.ok(native, "the native field has the user agent's clear button");
  Assert.equal(getComputedStyle(native).display, "none", "which never draws");

  const seen = eventsOf(el);
  await typeInto(el, "ebay");
  await fieldDrawn(el);
  Assert.ok(clear.checkVisibility(), "typing shows the clear button");
  seen.length = 0;
  // The clear button stays out of the Tab order, because Escape empties a
  // search from the keyboard.
  AccessibilityUtils.setEnv({ focusableRule: false });
  EventUtils.synthesizeMouseAtCenter(clear, {});
  AccessibilityUtils.resetEnv();
  await fieldDrawn(el);
  Assert.equal(el.value, "", "its press empties the field");
  Assert.deepEqual(seen, ["input"], "and fires input, as typing does");
  Assert.equal(document.activeElement, el, "the focus stays in the field");
  Assert.ok(!clear.checkVisibility(), "and the button goes");

  await typeInto(el, "ebay");
  EventUtils.synthesizeKey("KEY_Escape");
  await fieldDrawn(el);
  Assert.equal(el.value, "", "Escape empties it too");

  el.value = "kept";
  el.disabled = true;
  await fieldDrawn(el);
  Assert.ok(!clear.checkVisibility(), "a disabled search has no clear button");
  el.disabled = false;
  el.readOnly = true;
  await fieldDrawn(el);
  Assert.ok(!clear.checkVisibility(), "nor has a read-only one");
});

add_task(async function a_number_draws_no_spinner() {
  const number = make("sval-field", {
    type: "number",
    value: "4",
    "aria-label": "Rate",
  });
  const text = make("sval-field", { value: "4", "aria-label": "Text" });
  stage(number, text);
  for (const el of [number, text]) {
    await fieldDrawn(el);
    // The editor and its root exist once the field has been focused.
    el.focus();
  }
  const editable = el =>
    (el.shadowRoot
      ? fieldInner(el)
      : el
    ).editor.rootElement.getBoundingClientRect().width;
  const native = make("input", { type: "number", value: "4" });
  const nativeText = make("input", { value: "4" });
  stage(native, nativeText);
  native.focus();
  nativeText.focus();
  Assert.less(
    editable(native),
    editable(nativeText),
    "a native number field gives its spinner room"
  );
  Assert.equal(
    editable(number),
    editable(text),
    "the number's text has the whole field, with no spinner beside it"
  );
  number.focus();
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.equal(number.value, "5", "the arrow keys still step it");
});
