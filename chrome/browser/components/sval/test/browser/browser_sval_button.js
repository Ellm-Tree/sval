/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * `sval-button` (`elements/sval-button.mjs`) behaves as a native button: a
 * press, Enter and Space each click it once; `disabled` takes it out of the
 * tab order and stops presses; `aria-disabled` stops presses and keeps it in
 * the tab order; its label names it. Each type draws its fill and ink from
 * the colour roles (`sval-roles.css`). A `submit` one submits its form, and
 * Enter in the form's field does so through it exactly when a native submit
 * button would. The browser window registers the element
 * (`SvalWindow.mount`), so the tasks build their buttons in it.
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
    "position: fixed; inset-block-start: 120px; inset-inline-start: 120px; z-index: 2147483647; display: flex; gap: 8px; padding: 8px";
  box.append(...children);
  document.documentElement.append(box);
  atTaskEnd(() => box.remove());
  return box;
}

/**
 * A new `sval-button` with `attrs` and the label `text`.
 *
 * @param {object} attrs
 * @param {string} text
 * @returns {Element}
 */
function button(attrs = {}, text = "Press") {
  const el = document.createElementNS(HTML_NS, "sval-button");
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, value);
  }
  el.append(text);
  return el;
}

/**
 * @param {Element} el A `sval-button`.
 * @returns {HTMLButtonElement} The native button inside it.
 */
function inner(el) {
  return el.shadowRoot.querySelector("button");
}

/**
 * Counts the clicks `el` hears.
 *
 * @param {Element} el
 * @returns {{count: number}}
 */
function clicks(el) {
  const seen = { count: 0 };
  el.addEventListener("click", () => seen.count++);
  return seen;
}

/**
 * Resolves once `el` has drawn its last change.
 *
 * @param {Element} el A `sval-button`.
 */
async function drawn(el) {
  await within(el.updateComplete, 5_000, "the button drawing");
}

add_task(async function a_press_enter_and_space_each_click_once() {
  const el = await button();
  stage(el);
  await drawn(el);
  Assert.equal(
    customElements.get("sval-button")?.name,
    "SvalButton",
    "the window registers the element"
  );
  const seen = clicks(el);

  EventUtils.synthesizeMouseAtCenter(el, {});
  Assert.equal(seen.count, 1, "a press clicks it once");

  el.focus();
  Assert.equal(document.activeElement, el, "focus goes to it");
  Assert.equal(
    el.shadowRoot.activeElement,
    inner(el),
    "and to the native button in it"
  );
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(seen.count, 2, "Enter clicks it once");
  EventUtils.synthesizeKey(" ");
  Assert.equal(seen.count, 3, "Space clicks it once");

  el.click();
  Assert.equal(seen.count, 4, "click() clicks it once");
});

add_task(async function disabled_stops_presses_and_focus() {
  const before = await button({}, "Before");
  const el = await button({ disabled: "" });
  stage(before, el);
  await drawn(el);
  const seen = clicks(el);

  Assert.ok(inner(el).disabled, "the native button is disabled");
  EventUtils.synthesizeMouseAtCenter(el, {});
  el.click();
  Assert.equal(seen.count, 0, "neither a press nor click() clicks it");

  before.focus();
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.notEqual(document.activeElement, el, "Tab passes it by");
  el.focus();
  Assert.notEqual(document.activeElement, el, "focus() leaves it alone");

  el.disabled = false;
  await drawn(el);
  EventUtils.synthesizeMouseAtCenter(el, {});
  Assert.equal(seen.count, 1, "enabled again, a press clicks it");
});

add_task(async function aria_disabled_stops_presses_and_keeps_focus() {
  const before = await button({}, "Before");
  const el = await button({ "aria-disabled": "true" });
  stage(before, el);
  await drawn(el);
  const seen = clicks(el);

  Assert.equal(
    inner(el).getAttribute("aria-disabled"),
    "true",
    "the native button says it is disabled"
  );
  before.focus();
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(document.activeElement, el, "Tab reaches it");
  // The presses land on a control the accessibility API reports as
  // disabled, which is the state under test.
  AccessibilityUtils.setEnv({ mustBeEnabled: false });
  EventUtils.synthesizeKey("KEY_Enter");
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeMouseAtCenter(el, {});
  el.click();
  AccessibilityUtils.resetEnv();
  Assert.equal(seen.count, 0, "nothing clicks it");

  el.removeAttribute("aria-disabled");
  await drawn(el);
  Assert.ok(
    !inner(el).hasAttribute("aria-disabled"),
    "the native button follows"
  );
  EventUtils.synthesizeMouseAtCenter(el, {});
  Assert.equal(seen.count, 1, "enabled again, a press clicks it");
});

add_task(async function busy_shows_a_spinner_and_stops_presses() {
  const before = await button({}, "Before");
  const el = await button({ busy: "" }, "Sending…");
  stage(before, el);
  await drawn(el);
  const seen = clicks(el);

  Assert.equal(
    inner(el).getAttribute("aria-busy"),
    "true",
    "the native button says it is busy"
  );
  const spinner = el.shadowRoot.querySelector(".spinner");
  Assert.ok(BrowserTestUtils.isVisible(spinner), "a spinner shows");
  Assert.equal(
    spinner.getAttribute("aria-hidden"),
    "true",
    "and is left out of its name"
  );
  before.focus();
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(document.activeElement, el, "Tab reaches it");
  EventUtils.synthesizeKey("KEY_Enter");
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeMouseAtCenter(el, {});
  el.click();
  Assert.equal(seen.count, 0, "nothing clicks it");

  el.busy = false;
  await drawn(el);
  Assert.ok(
    !inner(el).hasAttribute("aria-busy") &&
      !el.shadowRoot.querySelector(".spinner"),
    "done, the spinner and the busy state go"
  );
  EventUtils.synthesizeMouseAtCenter(el, {});
  Assert.equal(seen.count, 1, "and a press clicks it");
});

/**
 * The colour a role resolves to at `el`.
 *
 * @param {Element} el
 * @param {string} name A role's name without `--sval-`.
 * @returns {object} `InspectorUtils.colorToRGBA`'s reading.
 */
function role(el, name) {
  const value = getComputedStyle(el).getPropertyValue(`--sval-${name}`).trim();
  Assert.ok(value, `the role --sval-${name} is set`);
  return InspectorUtils.colorToRGBA(value);
}

function rgba(color) {
  return InspectorUtils.colorToRGBA(color);
}

add_task(async function each_type_draws_from_the_roles() {
  const types = {
    secondary: { ink: "ink", border: "border-strong" },
    primary: { fill: "action", ink: "action-text", border: "action" },
    danger: { fill: "problem", ink: "inverse" },
    quiet: { ink: "ink-muted" },
  };
  const els = {};
  for (const type of Object.keys(types)) {
    els[type] = await button({ type }, type);
  }
  stage(...Object.values(els));
  for (const [type, roles] of Object.entries(types)) {
    const el = els[type];
    await drawn(el);
    const look = getComputedStyle(inner(el));
    if (roles.fill) {
      Assert.deepEqual(
        rgba(look.backgroundColor),
        role(el, roles.fill),
        `${type}'s fill is --sval-${roles.fill}`
      );
    }
    Assert.deepEqual(
      rgba(look.color),
      role(el, roles.ink),
      `${type}'s ink is --sval-${roles.ink}`
    );
    if (roles.border) {
      Assert.deepEqual(
        rgba(look.borderTopColor),
        role(el, roles.border),
        `${type}'s border is --sval-${roles.border}`
      );
    }
  }
});

add_task(async function its_label_names_it() {
  const slotted = await button({}, "Save a backup");
  const labelled = await button({ label: "Sync now" }, "");
  const named = await button({ "aria-label": "Remove rule for example.com" });
  stage(slotted, labelled, named);
  for (const [el, name] of [
    [slotted, "Save a backup"],
    [labelled, "Sync now"],
    [named, "Remove rule for example.com"],
  ]) {
    await drawn(el);
    const acc = await accessibleOf(inner(el));
    Assert.equal(acc.role, Ci.nsIAccessibleRole.ROLE_PUSHBUTTON, "a button");
    Assert.equal(acc.name, name, `named "${name}"`);
  }
  Assert.ok(
    !named.hasAttribute("aria-label"),
    "aria-label moves to the native button"
  );
});

/**
 * A form holding one field and a `submit` button, counting its submits.
 *
 * @returns {Promise<object>}
 */
async function submitForm() {
  const form = document.createElementNS(HTML_NS, "form");
  const field = document.createElementNS(HTML_NS, "input");
  field.type = "text";
  const el = await button({ type: "primary", submit: "" }, "Join");
  form.append(field, el);
  const submits = { count: 0 };
  form.addEventListener("submit", event => {
    event.preventDefault();
    submits.count++;
  });
  stage(form);
  await drawn(el);
  return { form, field, el, submits };
}

add_task(async function enter_in_the_form_presses_it_as_a_native_one() {
  const { field, el, submits } = await submitForm();
  const seen = clicks(el);

  field.focus();
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(submits.count, 1, "Enter in the field submits once");
  Assert.equal(seen.count, 1, "through a click of the button");

  EventUtils.synthesizeMouseAtCenter(el, {});
  Assert.equal(submits.count, 2, "a press submits once");

  el.disabled = true;
  await drawn(el);
  field.focus();
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(
    submits.count,
    2,
    "while it is disabled, Enter in the field does nothing"
  );

  el.disabled = false;
  el.setAttribute("aria-disabled", "true");
  await drawn(el);
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(submits.count, 2, "nor while it is aria-disabled");
});

add_task(async function a_cancelled_click_submits_nothing() {
  const { el, submits } = await submitForm();
  el.addEventListener("click", event => event.preventDefault());
  EventUtils.synthesizeMouseAtCenter(el, {});
  Assert.equal(submits.count, 0, "the form stays");
});

add_task(async function new_children_keep_it_submitting() {
  const { field, el, submits } = await submitForm();
  el.textContent = "Joining";
  await TestUtils.waitForCondition(
    () => el.querySelector(":scope > button[type='submit']"),
    "the element puts its form button back"
  );
  field.focus();
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(submits.count, 1, "Enter in the field submits once");
  Assert.equal(el.textContent.trim(), "Joining", "under the new label");
});

/**
 * Every way a click reaches the element: a press at its centre and at its
 * edge, Enter and Space on it, `click()`, and a click dispatched at it.
 *
 * @param {Element} el
 */
function pressEveryWay(el) {
  // The presses land on a control the accessibility API reports as
  // disabled, and on the element's edge, which has no accessible of its own:
  // both are the states under test.
  AccessibilityUtils.setEnv({
    mustBeEnabled: false,
    mustHaveAccessibleRule: false,
  });
  const rect = el.getBoundingClientRect();
  EventUtils.synthesizeMouseAtCenter(el, {});
  EventUtils.synthesizeMouse(el, 1, rect.height / 2, {});
  inner(el).focus();
  EventUtils.synthesizeKey("KEY_Enter");
  EventUtils.synthesizeKey(" ");
  el.click();
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  AccessibilityUtils.resetEnv();
}

/**
 * A held button (`held`, `hold()`) is disabled while its fill sweeps across
 * it: no press, key, `click()` or dispatched click reaches a listener, and
 * the accessibility API reports it unavailable. Once the hold ends, one
 * press clicks it once.
 */
add_task(async function held_stops_every_click_until_the_hold_ends() {
  const el = await button({ type: "primary" });
  stage(el);
  await drawn(el);
  const seen = clicks(el);
  el.hold(60_000);
  await drawn(el);
  Assert.ok(el.hasAttribute("held"), "the element says it is held");
  Assert.ok(inner(el).disabled, "the native button is disabled");
  const sweep = inner(el).getAnimations();
  Assert.ok(
    !matchMedia("(prefers-reduced-motion: reduce)").matches
      ? sweep.length === 1 && sweep[0].animationName === "sval-button-hold"
      : !sweep.length,
    "its fill sweeps across it unless motion is reduced"
  );
  const accessible = await accessibleOf(inner(el));
  const state = {};
  accessible.getState(state, {});
  Assert.ok(
    state.value & Ci.nsIAccessibleStates.STATE_UNAVAILABLE,
    "the accessibility API reports it unavailable"
  );
  pressEveryWay(el);
  Assert.equal(seen.count, 0, "nothing clicks it while held");

  el.hold(60_000);
  Assert.equal(
    inner(el).getAnimations()[0]?.currentTime ?? 0,
    0,
    "hold() starts the sweep over"
  );

  el.held = false;
  await drawn(el);
  Assert.ok(!inner(el).disabled, "the hold over, it enables");
  EventUtils.synthesizeMouseAtCenter(el, {});
  Assert.equal(seen.count, 1, "and one press clicks it once");
});

/**
 * A disabled button swallows a click that reaches the element without its
 * inner button, dispatched at it or pressed on its edge, as it does a press.
 */
add_task(async function disabled_stops_clicks_that_miss_its_button() {
  const el = await button({ disabled: "disabled" });
  stage(el);
  await drawn(el);
  const seen = clicks(el);
  pressEveryWay(el);
  Assert.equal(seen.count, 0, "nothing clicks it");
});
