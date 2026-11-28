/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * `sval-switch` and `sval-checkbox` (`elements/sval-switch.mjs`,
 * `elements/sval-checkbox.mjs`) behave as a native checkbox: a click, Space,
 * or a click on a label toggles them and fires `input` then `change`;
 * `checked` set from code fires nothing; `mixed` shows until a click clears
 * it; disabled ones take neither focus nor clicks; their form reads, resets
 * and validates them, and Enter submits it as from a native checkbox. The
 * switch is a switch and the checkbox a checkbox to assistive technology.
 * The browser window registers both (`SvalWindow.mount`).
 */

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
    "position: fixed; inset-block-start: 120px; inset-inline-start: 120px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px; padding: 8px";
  box.append(...children);
  document.documentElement.append(box);
  atTaskEnd(() => box.remove());
  return box;
}

/**
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
 * The `input` and `change` events `el` hears, in order.
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

/**
 * Whether the accessible of `el`'s checkbox reads as checked, and mixed.
 *
 * @param {Element} el
 * @returns {Promise<{checked: boolean, mixed: boolean}>}
 */
async function readState(el) {
  await fieldDrawn(el);
  const acc = await accessibleOf(fieldInner(el));
  const state = {};
  acc.getState(state, {});
  return {
    checked: !!(state.value & Ci.nsIAccessibleStates.STATE_CHECKED),
    mixed: !!(state.value & Ci.nsIAccessibleStates.STATE_MIXED),
  };
}

for (const [tag, role] of [
  ["sval-switch", Ci.nsIAccessibleRole.ROLE_SWITCH],
  ["sval-checkbox", Ci.nsIAccessibleRole.ROLE_CHECKBUTTON],
]) {
  add_task(async function a_click_space_and_label_toggle_it() {
    const label = make("label", { for: `probe-${tag}` }, "Show favorites");
    const el = make(tag, { id: `probe-${tag}` });
    const wrapped = make(tag);
    const row = make("label", {}, make("span", {}, "Warn me"), wrapped);
    stage(label, el, row);
    await fieldDrawn(el);
    await fieldDrawn(wrapped);
    Assert.ok(customElements.get(tag), `the window registers ${tag}`);
    const seen = eventsOf(el);

    for (const [s, name] of [
      [el, "Show favorites"],
      [wrapped, "Warn me"],
    ]) {
      const acc = await accessibleOf(fieldInner(s));
      Assert.equal(acc.role, role, `${tag} has its role`);
      Assert.equal(acc.name, name, `named "${name}"`);
    }

    el.checked = true;
    await fieldDrawn(el);
    Assert.ok(fieldInner(el).checked, "checked set from code shows");
    Assert.deepEqual(seen, [], "and fires nothing");
    Assert.ok((await readState(el)).checked, "and reads as checked");

    EventUtils.synthesizeMouseAtCenter(fieldInner(el), {});
    Assert.ok(!el.checked, "a click turns it off");
    Assert.deepEqual(seen, ["input", "change"], "firing input, then change");
    Assert.ok(!(await readState(el)).checked, "it reads as off");

    // A click focuses a checkbox where the platform's does, which macOS's
    // does not, so the keyboard reaches it through focus().
    seen.length = 0;
    el.focus();
    Assert.equal(document.activeElement, el, "focus() reaches it");
    EventUtils.synthesizeKey(" ");
    Assert.ok(el.checked, "Space turns it on");
    Assert.deepEqual(seen, ["input", "change"]);

    seen.length = 0;
    clickLabel(label);
    Assert.ok(!el.checked, "a click on its <label for> toggles it");
    Assert.deepEqual(seen, ["input", "change"], "once");

    clickLabel(row.firstChild);
    Assert.ok(wrapped.checked, "a click on a label around it toggles it");

    seen.length = 0;
    el.click();
    Assert.ok(el.checked, "click() toggles it");
    Assert.deepEqual(seen, ["input", "change"], "once");
  });

  add_task(async function mixed_shows_until_a_click() {
    const el = make(tag, { mixed: "", "aria-label": "Some lists" });
    stage(el);
    let state = await readState(el);
    Assert.ok(fieldInner(el).indeterminate, `${tag}'s checkbox is mixed`);
    Assert.ok(state.mixed, "and reads as mixed");
    EventUtils.synthesizeMouseAtCenter(fieldInner(el), {});
    await fieldDrawn(el);
    Assert.ok(!el.mixed, "a click clears mixed");
    Assert.ok(el.checked, "and turns it on");
    state = await readState(el);
    Assert.ok(!state.mixed && state.checked, "it reads as on");
  });

  add_task(async function disabled_takes_no_focus_or_click() {
    const before = make(tag, { "aria-label": "Before" });
    const el = make(tag, { disabled: "", "aria-label": "Off" });
    const label = make("label", { for: `probe-off-${tag}` }, "Off too");
    const labelled = make(tag, { id: `probe-off-${tag}`, disabled: "" });
    stage(before, el, label, labelled);
    await fieldDrawn(el);
    await fieldDrawn(labelled);
    const seen = eventsOf(el);
    Assert.ok(fieldInner(el).disabled, `${tag}'s checkbox is disabled`);
    // The presses land on a control the accessibility API reports as
    // disabled and unfocusable, which is the state under test.
    AccessibilityUtils.setEnv({
      mustBeEnabled: false,
      focusableRule: false,
      mustHaveAccessibleRule: false,
    });
    EventUtils.synthesizeMouseAtCenter(fieldInner(el), {});
    EventUtils.synthesizeMouseAtCenter(label, {});
    AccessibilityUtils.resetEnv();
    el.click();
    Assert.ok(!el.checked && !labelled.checked, "nothing toggles it");
    Assert.deepEqual(seen, [], "nor fires");
    before.focus();
    EventUtils.synthesizeKey("KEY_Tab");
    Assert.notEqual(document.activeElement, el, "Tab passes it by");
  });

  add_task(async function its_form_reads_resets_and_validates_it() {
    const el = make(tag, { name: "history", checked: "", "aria-label": "H" });
    const agree = make(tag, { name: "agree", required: "", "aria-label": "A" });
    const field = make("input", { type: "text", "aria-label": "Name" });
    const submit = make("button", { type: "submit" }, "Export");
    const form = make("form", {}, el, agree, field, submit);
    const submits = { count: 0 };
    form.addEventListener("submit", event => {
      event.preventDefault();
      submits.count++;
    });
    stage(form);
    await fieldDrawn(el);
    await fieldDrawn(agree);
    Assert.ok(el.checked, "the checked attribute is its first state");
    Assert.equal(el.form, form, "its form owns it");
    Assert.equal(new FormData(form).get("history"), "on", "the form reads it");
    Assert.ok(!agree.checkValidity(), "a required one left off is invalid");
    Assert.ok(agree.validity.valueMissing, "for want of a check");

    EventUtils.synthesizeMouseAtCenter(fieldInner(agree), {});
    Assert.ok(agree.checkValidity(), "checked, it is valid");
    EventUtils.synthesizeMouseAtCenter(fieldInner(el), {});
    Assert.ok(
      !new FormData(form).has("history"),
      "off, the form leaves it out"
    );

    agree.focus();
    EventUtils.synthesizeKey("KEY_Enter");
    Assert.equal(submits.count, 1, "Enter on it submits once, as natively");

    form.reset();
    await fieldDrawn(el);
    Assert.ok(el.checked && fieldInner(el).checked, "a reset puts it back");
    Assert.ok(!agree.checked, "and the other off");
  });
}
