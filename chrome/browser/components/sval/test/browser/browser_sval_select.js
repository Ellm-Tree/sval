/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * `sval-select` (`elements/sval-select.mjs`) behaves as a native select: its
 * choices come from `options` or from the `<option>` elements in it, which
 * it follows as they are added, removed and relabelled; its value is
 * reflected to `data-value`; a pick fires `input` then `change`, and a value
 * set from code fires nothing; its form reads, resets and validates it; a
 * label names and focuses it. The browser window registers the element
 * (`SvalWindow.mount`), so the tasks build their selects in it.
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
 * The choices the native select in `el` offers, as `[value, label]`.
 *
 * @param {Element} el
 * @returns {Array<[string, string]>}
 */
function drawnChoices(el) {
  return [...fieldInner(el).options].map(o => [o.value, o.textContent]);
}

add_task(async function its_choices_follow_its_options() {
  const el = make(
    "sval-select",
    { "aria-label": "Lines" },
    make("option", { value: "1" }, "One"),
    make("option", { value: "2", selected: "" }, "Two"),
    make("option", { value: "3" }, "Three")
  );
  stage(el);
  await fieldDrawn(el);
  Assert.equal(
    customElements.get("sval-select")?.name,
    "SvalSelect",
    "the window registers the element"
  );
  Assert.deepEqual(
    drawnChoices(el),
    [
      ["1", "One"],
      ["2", "Two"],
      ["3", "Three"],
    ],
    "the native select offers its options"
  );
  Assert.equal(el.value, "2", "the selected option is chosen");
  Assert.equal(el.dataset.value, "2", "and reflected to data-value");
  Assert.equal(fieldInner(el).value, "2", "and shown");
  Assert.ok(
    [...el.querySelectorAll("option")].every(o => !o.checkVisibility()),
    "its own options draw nothing"
  );

  el.append(make("option", { value: "4" }, "Four"));
  await TestUtils.waitForCondition(
    () => drawnChoices(el).length === 4,
    "an added option shows"
  );
  el.querySelector("option[value='1']").remove();
  await TestUtils.waitForCondition(
    () => drawnChoices(el)[0][0] === "2",
    "a removed one goes"
  );
  el.querySelector("option[value='3']").textContent = "Three rows";
  await TestUtils.waitForCondition(
    () => drawnChoices(el).some(([, label]) => label === "Three rows"),
    "a relabelled one changes its words"
  );
  el.querySelector("option[value='4']").setAttribute("disabled", "");
  await TestUtils.waitForCondition(
    () => fieldInner(el).options[2]?.disabled,
    "a disabled one is disabled"
  );
  Assert.equal(el.value, "2", "and the choice stays through all of it");

  const fromList = make("sval-select", { "aria-label": "Wait" });
  fromList.options = [
    ["300", "5 minutes"],
    ["900", "15 minutes", true],
  ];
  stage(fromList);
  await fieldDrawn(fromList);
  Assert.deepEqual(drawnChoices(fromList), [
    ["300", "5 minutes"],
    ["900", "15 minutes"],
  ]);
  Assert.ok(fieldInner(fromList).options[1].disabled, "a disabled choice");
  Assert.equal(fromList.value, "300", "the first choice is chosen");
});

add_task(
  async function a_pick_fires_input_then_change_and_code_fires_nothing() {
    const el = make("sval-select", { "aria-label": "When" });
    el.options = [
      ["all", "In every window"],
      ["private", "Only in private windows"],
      ["off", "Off"],
    ];
    stage(el);
    await fieldDrawn(el);
    const seen = [];
    for (const type of ["input", "change"]) {
      el.addEventListener(type, event => {
        Assert.equal(event.target, el, `${type} comes from the element`);
        seen.push(type);
      });
    }

    el.value = "off";
    await fieldDrawn(el);
    Assert.equal(fieldInner(el).value, "off", "a value set from code shows");
    Assert.equal(el.dataset.value, "off", "reflected");
    Assert.deepEqual(seen, [], "and fires nothing");

    await pickOption(el, "private");
    Assert.deepEqual(
      seen,
      ["input", "change"],
      "a pick fires input, then change"
    );
    Assert.equal(el.value, "private", "and sets the value");
    Assert.equal(el.dataset.value, "private", "reflected");

    el.value = "gone";
    await fieldDrawn(el);
    Assert.equal(
      fieldInner(el).selectedIndex,
      -1,
      "a value no option has shows no choice"
    );
  }
);

add_task(async function a_value_draws_the_ink_its_sheet_gives_it() {
  const sheet = make(
    "style",
    {},
    `.probe-select[data-value="deny"] { --sval-field-select-ink: rgb(200, 50, 31); }`
  );
  const el = make("sval-select", {
    class: "probe-select",
    "aria-label": "Uploads",
  });
  el.options = [
    ["", "Ask"],
    ["deny", "Never"],
  ];
  stage(sheet, el);
  await fieldDrawn(el);
  const ink = () => getComputedStyle(fieldInner(el)).color;
  const asked = ink();
  await pickOption(el, "deny");
  Assert.equal(
    ink(),
    "rgb(200, 50, 31)",
    "a value's own ink reaches the select"
  );
  await pickOption(el, "");
  Assert.equal(ink(), asked, "and goes with the value");
});

add_task(async function its_form_reads_resets_and_validates_it() {
  const el = make(
    "sval-select",
    { name: "after", "aria-label": "After" },
    make("option", { value: "7" }, "7 days"),
    make("option", { value: "30", selected: "" }, "30 days")
  );
  const required = make(
    "sval-select",
    { name: "scope", required: "", "aria-label": "Scope" },
    make("option", { value: "" }, "Choose…"),
    make("option", { value: "site" }, "This site")
  );
  const form = make("form", {}, el, required);
  stage(form);
  await fieldDrawn(el);
  await fieldDrawn(required);
  Assert.equal(el.form, form, "its form owns it");
  Assert.equal(new FormData(form).get("after"), "30", "the form reads it");
  await pickOption(el, "7");
  Assert.equal(new FormData(form).get("after"), "7", "and the pick");
  Assert.ok(!required.checkValidity(), "a required one on no value is invalid");
  Assert.ok(required.validity.valueMissing, "for want of a value");
  Assert.ok(!form.checkValidity(), "and so is its form");
  await pickOption(required, "site");
  Assert.ok(required.checkValidity(), "picked, it is valid");
  form.reset();
  await fieldDrawn(el);
  Assert.equal(el.value, "30", "a reset chooses the selected option again");
  Assert.equal(fieldInner(el).value, "30", "and shows it");
});

add_task(async function a_label_names_and_focuses_it() {
  const label = make("label", { for: "probe-lines" }, "Rows of pins");
  const el = make(
    "sval-select",
    { id: "probe-lines" },
    make("option", { value: "1" }, "1")
  );
  const wrapped = make(
    "sval-select",
    {},
    make("option", { value: "a" }, "Always")
  );
  const wrapping = make("label", {}, make("span", {}, "Ask"), wrapped);
  const off = make(
    "sval-select",
    { disabled: "", "aria-label": "Off" },
    make("option", { value: "x" }, "x")
  );
  stage(label, el, wrapping, off);
  for (const s of [el, wrapped, off]) {
    await fieldDrawn(s);
  }
  clickLabel(label);
  Assert.equal(document.activeElement, el, "a <label for> click focuses it");
  for (const [s, name] of [
    [el, "Rows of pins"],
    [wrapped, "Ask"],
  ]) {
    const acc = await accessibleOf(fieldInner(s));
    Assert.equal(acc.role, Ci.nsIAccessibleRole.ROLE_COMBOBOX, "a combobox");
    Assert.equal(acc.name, name, `named "${name}"`);
  }
  Assert.ok(fieldInner(off).disabled, "disabled reaches the native select");
  off.focus();
  Assert.notEqual(document.activeElement, off, "which takes no focus");
});

add_task(async function a_value_set_with_its_options_stays() {
  // As Settings builds its selects: the options, then the value, in one task.
  const el = make("sval-select", { "aria-label": "Rows" });
  stage(el);
  for (const n of ["1", "2", "3"]) {
    el.append(make("option", { value: n }, n));
  }
  el.value = "3";
  await TestUtils.waitForCondition(
    () => fieldInner(el)?.options.length === 3,
    "the options drawn"
  );
  await fieldDrawn(el);
  Assert.equal(el.value, "3", "the value set stays");
  Assert.equal(fieldInner(el).value, "3", "and shows");
});
