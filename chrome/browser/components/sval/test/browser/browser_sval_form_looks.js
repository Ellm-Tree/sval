/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Sval's form elements draw only from their own sheets: no rule of
 * Firefox's page sheets (`in-content/common.css`, `global.css` and the
 * sheets they import) reaches the native controls in their shadow roots,
 * in any state, so the controls look the same with those sheets on and off.
 * Their colours are the colour roles (`sval-roles.css`) in light and dark,
 * and the system's colours under forced colours. Settings is the page with
 * the most Firefox sheets, so the tasks build the elements there.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const PROPS = [
  "color",
  "background-color",
  "background-image",
  "border-top-color",
  "border-top-width",
  "border-top-style",
  "border-top-left-radius",
  "opacity",
  "min-width",
  "min-height",
  "width",
  "height",
  "padding-top",
  "padding-left",
  "margin-top",
  "margin-left",
  "font-size",
  "font-weight",
  "font-family",
  "line-height",
  "box-shadow",
  "outline-color",
  "outline-style",
  "outline-width",
  "outline-offset",
  "cursor",
  "appearance",
  "box-sizing",
  "accent-color",
];

/**
 * One of each element and size, in a Sval pane of `ui`'s page.
 *
 * @param {object} ui
 * @returns {Promise<Element[]>}
 */
async function samples(ui) {
  await showPane(ui.page, "svalSync");
  const doc = ui.page.document;
  const box = doc.createElement("div");
  box.className = "sval-actions";
  // A switch fades between its colours; read without the fade, a scheme's
  // colour is the one it ends on.
  box.style.setProperty("--sval-dur", "0s");
  const els = [
    ["sval-field", { value: "Laptop" }],
    ["sval-field", { size: "code", value: "ABCD" }],
    ["sval-field", { size: "code", value: "ABCD", readonly: "" }],
    ["sval-field", { size: "compact", mono: "", value: "/path" }],
    ["sval-field", { type: "search", size: "compact" }],
    ["sval-field", { type: "number", value: "4" }],
    ["sval-field", { type: "password", value: "secret" }],
    ["sval-field", { multiline: "", size: "compact", value: "{}" }],
    ["sval-field", { error: "Not a host" }],
    ["sval-select", {}],
    ["sval-switch", {}],
    ["sval-switch", { checked: "" }],
    ["sval-switch", { mixed: "" }],
    ["sval-checkbox", {}],
    ["sval-checkbox", { checked: "" }],
  ].map(([tag, attrs], i) => {
    const el = doc.createElement(tag);
    el.setAttribute("aria-label", `Sample ${i}`);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    if (tag === "sval-select") {
      el.options = [["1", "One"]];
    }
    return el;
  });
  box.append(...els);
  paneOf(ui.page, "svalSync").querySelector(".sval-card").append(box);
  atTaskEnd(() => box.remove());
  for (const el of els) {
    await fieldDrawn(el);
  }
  return els;
}

/**
 * `el`'s control's computed look in `state`.
 *
 * @param {Element} el
 * @param {string[]|"disabled"} state
 * @returns {Promise<object>}
 */
async function lookIn(el, state) {
  const inner = fieldInner(el);
  if (state === "disabled") {
    el.disabled = true;
    await fieldDrawn(el);
  } else {
    state.forEach(s => InspectorUtils.addPseudoClassLock(inner, s));
  }
  const cs = inner.documentGlobal.getComputedStyle(inner);
  const out = Object.fromEntries(PROPS.map(p => [p, cs.getPropertyValue(p)]));
  if (state === "disabled") {
    el.disabled = false;
    await fieldDrawn(el);
  } else {
    state.forEach(s => InspectorUtils.removePseudoClassLock(inner, s));
  }
  return out;
}

add_task(async function no_firefox_sheet_reaches_the_controls() {
  const ui = await openSettings();
  const els = await samples(ui);
  const doc = ui.page.document;
  const sheets = InspectorUtils.getAllStyleSheets(doc, true).filter(s =>
    /\/(in-content\/common|global)(-shared)?\.css$/.test(s.href ?? "")
  );
  Assert.ok(
    sheets.some(s => s.href.endsWith("in-content/common.css")),
    "the page has Firefox's in-content sheet"
  );
  const states = [
    [],
    [":hover"],
    [":hover", ":active"],
    [":focus-visible"],
    "disabled",
  ];
  const withSheets = new Map();
  for (const el of els) {
    const looks = [];
    for (const s of states) {
      looks.push(await lookIn(el, s));
    }
    withSheets.set(el, looks);
  }
  for (const s of sheets) {
    s.disabled = true;
  }
  atTaskEnd(() => sheets.forEach(s => (s.disabled = false)));
  for (const el of els) {
    for (const [i, s] of states.entries()) {
      const without = await lookIn(el, s);
      const differs = PROPS.filter(
        p => without[p] !== withSheets.get(el)[i][p]
      ).map(
        p => `${p}: ${withSheets.get(el)[i][p]} with, ${without[p]} without`
      );
      Assert.deepEqual(
        differs,
        [],
        `${el.localName} ${el.ariaLabel} looks the same in ${s === "disabled" ? s : s.join("") || "rest"} without Firefox's sheets`
      );
    }
  }
});

/**
 * The colour a role resolves to at `el`.
 *
 * @param {Element} el
 * @param {string} name A role's name without `--sval-`.
 * @returns {object}
 */
function role(el, name) {
  const value = el.documentGlobal
    .getComputedStyle(el)
    .getPropertyValue(`--sval-${name}`)
    .trim();
  Assert.ok(value, `the role --sval-${name} is set`);
  return InspectorUtils.colorToRGBA(value);
}

/**
 * The colour `value` (a system colour, say) resolves to in `doc`.
 *
 * @param {Document} doc
 * @param {string} value
 * @returns {object}
 */
function systemColour(doc, value) {
  const probe = doc.createElement("span");
  probe.style.color = value;
  doc.body.append(probe);
  const rgba = InspectorUtils.colorToRGBA(
    doc.defaultView.getComputedStyle(probe).color
  );
  probe.remove();
  return rgba;
}

const rgba = color => InspectorUtils.colorToRGBA(color);

/**
 * Checks each element's colours against the roles it reads.
 *
 * @param {Element[]} els As `samples` makes them.
 * @param {string} scheme
 */
function assertRoles(els, scheme) {
  const [field, , readonlyCode, compact] = els;
  const select = els.find(el => el.localName === "sval-select");
  const [off, on] = els.filter(el => el.localName === "sval-switch");
  const checked = els.filter(el => el.localName === "sval-checkbox")[1];
  const cs = el =>
    fieldInner(el).documentGlobal.getComputedStyle(fieldInner(el));
  for (const [el, prop, name] of [
    [field, "background-color", "sunken"],
    [field, "color", "ink"],
    [field, "border-top-color", "control-edge"],
    [compact, "background-color", "sunken"],
    [readonlyCode, "border-top-color", "accent"],
    [select, "background-color", "sunken"],
    [select, "color", "ink"],
    [off, "background-color", "control-edge"],
    [on, "background-color", "action"],
    [checked, "background-color", "action"],
  ]) {
    Assert.deepEqual(
      rgba(cs(el)[prop.replace(/-./g, m => m[1].toUpperCase())]),
      role(el, name),
      `${scheme}: ${el.localName} ${el.ariaLabel} draws its ${prop} from --sval-${name}`
    );
  }
  const errored = els.find(el => el.error);
  Assert.deepEqual(
    rgba(cs(errored).borderTopColor),
    role(errored, "problem"),
    `${scheme}: an error draws the field's edge from --sval-problem`
  );
  Assert.deepEqual(
    rgba(
      errored.documentGlobal.getComputedStyle(
        errored.shadowRoot.getElementById("error")
      ).color
    ),
    role(errored, "problem"),
    `${scheme}: and its words`
  );
}

add_task(async function every_field_is_a_pill() {
  const ui = await openSettings();
  const els = await samples(ui);
  for (const el of els.filter(
    e => ["sval-field", "sval-select"].includes(e.localName) && !e.multiline
  )) {
    const inner = fieldInner(el);
    const cs = inner.documentGlobal.getComputedStyle(inner);
    Assert.greaterOrEqual(
      parseFloat(cs.borderTopLeftRadius),
      inner.getBoundingClientRect().height / 2,
      `${el.localName} ${el.ariaLabel} is a pill`
    );
  }
});

add_task(async function hover_lights_the_edge_as_on_an_outline_button() {
  const ui = await openSettings();
  const els = await samples(ui);
  const doc = ui.page.document;
  const button = doc.createElement("sval-button");
  button.textContent = "Outline";
  els[0].after(button);
  await fieldDrawn(button);
  const edge = (el, inner = fieldInner(el)) =>
    rgba(inner.documentGlobal.getComputedStyle(inner).borderTopColor);
  const hovered = (el, inner = fieldInner(el)) => {
    InspectorUtils.addPseudoClassLock(inner, ":hover");
    const seen = edge(el, inner);
    InspectorUtils.removePseudoClassLock(inner, ":hover");
    return seen;
  };
  const buttonInner = button.shadowRoot.querySelector("button");
  const lit = hovered(button, buttonInner);
  Assert.deepEqual(
    lit,
    role(button, "control-hover-edge"),
    "an outline button's edge under the pointer is --sval-control-hover-edge"
  );
  const [field, code, readonlyCode] = els;
  const select = els.find(el => el.localName === "sval-select");
  const box = els.filter(el => el.localName === "sval-checkbox")[0];
  for (const el of [field, code, select, box]) {
    Assert.notDeepEqual(edge(el), lit, `${el.ariaLabel} rests on its edge`);
    Assert.deepEqual(
      hovered(el),
      lit,
      `${el.localName} ${el.ariaLabel} lights as the button does`
    );
  }
  const errored = els.find(el => el.error);
  Assert.deepEqual(
    hovered(errored),
    role(errored, "problem"),
    "an invalid field keeps its error edge under the pointer"
  );
  Assert.deepEqual(
    hovered(readonlyCode),
    edge(readonlyCode),
    "a read-only field keeps its edge"
  );
  field.disabled = true;
  await fieldDrawn(field);
  Assert.deepEqual(hovered(field), edge(field), "and so does a disabled one");
  field.disabled = false;
  await fieldDrawn(field);
});

add_task(async function light_and_dark_draw_from_the_roles() {
  const ui = await openSettings();
  const els = await samples(ui);
  for (const [scheme, dark] of [
    ["light", 0],
    ["dark", 1],
  ]) {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["ui.systemUsesDarkTheme", dark],
        ["layout.css.prefers-color-scheme.content-override", dark ? 0 : 1],
      ],
    });
    await TestUtils.waitForCondition(
      () =>
        ui.page.matchMedia("(prefers-color-scheme: dark)").matches === !!dark,
      `the page in ${scheme}`
    );
    assertRoles(els, scheme);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function forced_colours_draw_in_system_colours() {
  const ui = await openSettings();
  const els = await samples(ui);
  const bc = ui.tab.linkedBrowser.browsingContext;
  bc.forcedColorsOverride = "active";
  atTaskEnd(() => (bc.forcedColorsOverride = "none"));
  await TestUtils.waitForCondition(
    () => ui.page.matchMedia("(forced-colors)").matches,
    "the page in forced colours"
  );
  const doc = ui.page.document;
  const cs = el => ui.page.getComputedStyle(fieldInner(el));
  const [field] = els;
  const select = els.find(el => el.localName === "sval-select");
  const [off, on] = els.filter(el => el.localName === "sval-switch");
  const checked = els.filter(el => el.localName === "sval-checkbox")[1];
  for (const [el, prop, colour] of [
    [field, "backgroundColor", "Field"],
    [field, "color", "FieldText"],
    [field, "borderTopColor", "FieldText"],
    [select, "backgroundColor", "ButtonFace"],
    [select, "color", "ButtonText"],
    [off, "borderTopColor", "ButtonText"],
    [off, "backgroundColor", "ButtonFace"],
    [on, "backgroundColor", "Highlight"],
    [checked, "backgroundColor", "Highlight"],
  ]) {
    Assert.deepEqual(
      rgba(cs(el)[prop]),
      systemColour(doc, colour),
      `${el.localName} ${el.ariaLabel} draws its ${prop} in ${colour}`
    );
  }
  off.disabled = true;
  await fieldDrawn(off);
  Assert.deepEqual(
    rgba(cs(off).borderTopColor),
    systemColour(doc, "GrayText"),
    "a disabled switch draws its edge in GrayText"
  );
});
