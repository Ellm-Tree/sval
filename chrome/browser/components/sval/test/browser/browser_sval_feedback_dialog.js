/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_feedback_helpers.js */

/**
 * The Send Feedback form's card is Sval's dialog card (`sval-dialog`), its
 * answers and its rows' View `sval-button`s, and over a window that shows
 * what is behind it the card is frosted as a dialog's is
 * (`SvalDialogBox.frostLook`): the whole shape, the tab, the stem and the
 * card, blurs what lies under it, the shape wears the `blur` material's
 * colour, and the text is solved on it. Over a window at no transparency, or while the system
 * reduces transparency, the card is solid.
 *
 * The window shows what is behind it as it does on macOS, whatever the
 * platform the test runs on. Headless Gecko draws no backdrop filter in any
 * snapshot, so the blur is read from computed style.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_feedback_helpers.js",
  this
);

const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

const COLOR = "blue";
const TRANSPARENCY = 0.5;

add_setup(async function a_window_that_can_see_through() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
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
 * Gives the Workspace this window shows {@link COLOR} at `transparency`, as
 * its Edit dialog does. The file's end puts the document back.
 *
 * @param {number} transparency
 */
async function tintWindow(transparency) {
  await SvalPanel.engine.mutate({
    kind: "setAppearance",
    id: SvalWindowWorkspace.of(window).id,
    color: COLOR,
    emoji: null,
    transparency,
    now: Date.now(),
  });
  await within(SvalPanel.refresh(), 10_000, "the panel redrawing");
  await TestUtils.waitForCondition(
    () =>
      SvalPanel._tintArgs?.[0] === COLOR &&
      SvalPanel._tintArgs[1] === transparency,
    "the window wears the look"
  );
}

/**
 * Opens the form from the footer's button and waits for its report.
 *
 * @returns {Promise<{form: Element, card: Element, outline: Element}>}
 */
async function openForm() {
  await appDataInTemp();
  atTaskEnd(() => discardFeedbackDraft());
  feedbackButton().click();
  const form = await feedbackShown();
  return {
    form,
    card: form.querySelector(".sval-feedback-box"),
    outline: form.querySelector(":scope > .sval-stem-outline"),
  };
}

/**
 * @param {string} css
 * @returns {object} `InspectorUtils.colorToRGBA`'s reading.
 */
function rgba(css) {
  return InspectorUtils.colorToRGBA(css);
}

/**
 * Asserts the card draws solid, in the window's popover colour.
 *
 * @param {object} shown What {@link openForm} gave.
 * @param {Element} shown.form
 * @param {Element} shown.card
 * @param {Element} shown.outline
 * @param {string} what
 */
function assertSolid({ form, card, outline }, what) {
  Assert.ok(!form.hasAttribute("frosted"), `${what}: the popover is solid`);
  Assert.ok(!card.hasAttribute("frosted"), `${what}: and so is the card`);
  Assert.ok(
    !BrowserTestUtils.isVisible(form.querySelector(".sval-feedback-frost")),
    `${what}: nothing blurs what lies under it`
  );
  Assert.equal(
    getComputedStyle(card).backdropFilter,
    "none",
    `${what}: nor does the card`
  );
  Assert.equal(
    rgba(getComputedStyle(outline).fill).a,
    1,
    `${what}: the shape is opaque`
  );
}

add_task(async function the_form_is_a_dialog_card_with_sval_buttons() {
  await tintWindow(0);
  const { form, card } = await openForm();
  Assert.equal(card.localName, "sval-dialog", "the card is an sval-dialog");
  Assert.equal(
    form.querySelector(".sval-feedback-title").slot,
    "title",
    "with its title in the card's title"
  );
  Assert.equal(
    form.querySelector(".sval-feedback-context").slot,
    "body",
    "and the context line in its body"
  );
  const { cancel, send } = formParts(form);
  for (const [answer, name, type] of [
    [cancel, "Cancel", "secondary"],
    [send, "Send", "primary"],
  ]) {
    Assert.equal(answer.localName, "sval-button", `${name} is an sval-button`);
    Assert.equal(answer.slot, "actions", `${name} is one of the answers`);
    Assert.equal(answer.type, type, `${name} is ${type}`);
  }
  Assert.ok(
    [...form.querySelectorAll(".sval-feedback-view")].every(
      view => view.localName === "sval-button"
    ),
    "every row's View is an sval-button"
  );
  for (const field of [".sval-feedback-message", ".sval-feedback-email"]) {
    Assert.equal(
      getComputedStyle(form.querySelector(field)).appearance,
      "none",
      `${field} draws no native field`
    );
  }
  const tick = form.querySelector(".sval-feedback-tick");
  Assert.equal(
    getComputedStyle(tick).appearance,
    "none",
    "a row's tick draws no native checkbox"
  );

  cancel.click();
  Assert.ok(form.hidden, "Cancel closes the form");
});

add_task(async function send_is_busy_while_the_report_goes() {
  await tintWindow(0);
  const { SvalFeedback } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFeedback.sys.mjs"
  );
  const { promise: answered, resolve: answer } = Promise.withResolvers();
  const asked = Promise.withResolvers();
  const send = SvalFeedback.send;
  SvalFeedback.send = () => {
    asked.resolve();
    return answered;
  };
  atTaskEnd(() => {
    SvalFeedback.send = send;
  });
  const { form } = await openForm();
  const parts = formParts(form);
  parts.message.focus();
  EventUtils.sendString("Tabs vanish when I switch workspaces.", window);
  await TestUtils.waitForCondition(() => !parts.send.disabled, "Send can go");
  parts.send.click();
  await within(asked.promise, 5_000, "the send starting");
  Assert.ok(parts.send.busy, "Send is busy while the report goes");
  Assert.equal(
    parts.send.shadowRoot.querySelector("button").getAttribute("aria-busy"),
    "true",
    "and says so"
  );
  answer({ ok: true, reference: "F-0042" });
  await TestUtils.waitForCondition(
    () => form.dataset.state === "sent",
    "the report is sent"
  );
  Assert.ok(!parts.send.busy, "Send is no longer busy");
  parts.close.click();
});

add_task(async function over_a_see_through_window_the_card_is_frosted() {
  await tintWindow(TRANSPARENCY);
  Assert.ok(
    document.documentElement.hasAttribute("data-sval-see-through"),
    "the window shows what is behind it"
  );
  const { form, card, outline } = await openForm();
  Assert.ok(form.hasAttribute("frosted"), "the popover is frosted");
  Assert.ok(card.hasAttribute("frosted"), "and so is its card");
  const frost = form.querySelector(".sval-feedback-frost");
  Assert.ok(BrowserTestUtils.isVisible(frost), "a layer frosts the shape");
  Assert.equal(
    getComputedStyle(frost).backdropFilter,
    "blur(24px)",
    "blurring what lies under it"
  );
  Assert.ok(
    outline.querySelector("path").getAttribute("d") &&
      getComputedStyle(frost).clipPath.startsWith("path("),
    "clipped to the shape's path"
  );
  const layer = frost.getBoundingClientRect();
  for (const [el, name] of [
    [form.querySelector(".sval-feedback-tab"), "the tab"],
    [card, "the card"],
  ]) {
    const r = el.getBoundingClientRect();
    Assert.ok(
      r.left >= layer.left - 0.5 &&
        r.right <= layer.right + 0.5 &&
        r.top >= layer.top - 0.5 &&
        r.bottom <= layer.bottom + 0.5,
      `which spans ${name}, and the stem between them`
    );
  }
  Assert.ok(
    frost.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING,
    "under the shape's fill"
  );
  Assert.equal(
    getComputedStyle(card).backdropFilter,
    "none",
    "the card blurs nothing again over the layer"
  );
  Assert.equal(
    getComputedStyle(form).filter,
    "none",
    "with no filter over them to stop the blur"
  );
  const look = SvalColor.windowLook(
    { color: COLOR, transparency: TRANSPARENCY },
    {
      scheme: matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
      more: matchMedia("(prefers-contrast: more)").matches,
      seeThrough: "blur",
    }
  );
  Assert.deepEqual(
    rgba(getComputedStyle(outline).fill),
    rgba(look.accent),
    "the shape wears what the blur material's root wears"
  );
  Assert.less(
    rgba(getComputedStyle(outline).fill).a,
    1,
    "which lets the blur through"
  );
  Assert.equal(
    rgba(getComputedStyle(card).backgroundColor).a,
    0,
    "the card itself is clear"
  );

  const targets = SvalColor.requirements(
    matchMedia("(prefers-contrast: more)").matches
  );
  for (const [token, kind] of [
    ["--sval-dialog-text", "body"],
    ["--sval-dialog-body", "body"],
    ["--sval-dialog-muted", "muted"],
  ]) {
    const probe = document.createElement("div");
    probe.style.color = `var(${token})`;
    card.append(probe);
    const { r, g, b } = rgba(getComputedStyle(probe).color);
    probe.remove();
    const { w, lc } = SvalColor.contrast(
      [r / 255, g / 255, b / 255],
      look.tint
    );
    Assert.greaterOrEqual(
      Math.round(w * 100) / 100,
      targets[kind].w,
      `${token} is ${w.toFixed(2)}:1 on the frosted card`
    );
    Assert.greaterOrEqual(
      Math.round(Math.abs(lc)),
      targets[kind].lc,
      `${token} is Lc ${lc.toFixed(1)} on the frosted card`
    );
  }

  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  Assert.ok(form.hidden, "Esc closes the frosted form");
});

add_task(async function a_window_at_no_transparency_keeps_the_card_solid() {
  await tintWindow(0);
  const shown = await openForm();
  assertSolid(shown, "no transparency");
  formParts(shown.form).cancel.click();
});

add_task(async function reduced_transparency_keeps_the_card_solid() {
  await SpecialPowers.pushPrefEnv({
    set: [["ui.prefersReducedTransparency", 1]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await TestUtils.waitForCondition(
    () => matchMedia("(prefers-reduced-transparency: reduce)").matches,
    "the system reduces transparency"
  );
  await tintWindow(TRANSPARENCY);
  const shown = await openForm();
  assertSolid(shown, "reduced transparency");
  formParts(shown.form).cancel.click();
});

/**
 * The colour `value` resolves to at `el`.
 *
 * @param {Element} el
 * @param {string} value A colour or `var(--…)`.
 * @returns {object}
 */
function colourAt(el, value) {
  const probe = el.ownerDocument.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "span"
  );
  probe.style.color = value;
  el.append(probe);
  const seen = rgba(getComputedStyle(probe).color);
  probe.remove();
  return seen;
}

/**
 * Checks the message, the email and a tick draw in the form's own colours,
 * and that no rule of Firefox's sheets in the window reaches them.
 *
 * @param {Element} form
 * @param {string} what
 */
async function checkFields(form, what) {
  const { message, email } = formParts(form);
  const tick = form.querySelector(".sval-feedback-tick");
  for (const el of [message, email, tick]) {
    await fieldDrawn(el);
  }
  // A ticked box fills with the action colour; its edge shows unticked.
  tick.checked = false;
  await fieldDrawn(tick);
  const at = (el, prop, locks = []) => {
    const inner = fieldInner(el);
    locks.forEach(l => InspectorUtils.addPseudoClassLock(inner, l));
    const seen = rgba(getComputedStyle(inner)[prop]);
    locks.forEach(l => InspectorUtils.removePseudoClassLock(inner, l));
    return seen;
  };
  for (const [el, name] of [
    [message, "the message"],
    [email, "the email"],
  ]) {
    Assert.equal(
      el.localName,
      "sval-field",
      `${what}: ${name} is a sval-field`
    );
    Assert.deepEqual(
      at(el, "backgroundColor"),
      colourAt(form, "var(--sval-pill-bg)"),
      `${what}: ${name} fills with the form's field colour`
    );
    Assert.deepEqual(
      at(el, "borderTopColor"),
      colourAt(form, "var(--sval-pill-border)"),
      `${what}: ${name}'s edge is the form's`
    );
    Assert.deepEqual(
      at(el, "borderTopColor", [":hover"]),
      colourAt(form, "var(--sval-focus)"),
      `${what}: and lights in the form's focus colour under the pointer`
    );
  }
  Assert.equal(
    tick.localName,
    "sval-checkbox",
    `${what}: a tick is a sval-checkbox`
  );
  Assert.deepEqual(
    at(tick, "borderTopColor", [":hover"]),
    colourAt(form, "var(--sval-focus)"),
    `${what}: whose edge lights alike`
  );

  const sheets = InspectorUtils.getAllStyleSheets(document, true).filter(s =>
    /\/(in-content\/common|global)(-shared)?\.css$/.test(s.href ?? "")
  );
  Assert.ok(sheets.length, "the window has Firefox's sheets");
  const looks = () =>
    [message, email, tick].map(el => {
      const cs = getComputedStyle(fieldInner(el));
      return [
        "color",
        "background-color",
        "border-top-color",
        "border-top-width",
        "font-size",
        "font-family",
        "appearance",
        "outline-style",
      ].map(p => cs.getPropertyValue(p));
    });
  const withSheets = looks();
  sheets.forEach(s => (s.disabled = true));
  const without = looks();
  sheets.forEach(s => (s.disabled = false));
  Assert.deepEqual(
    without,
    withSheets,
    `${what}: no rule of Firefox's sheets reaches the fields`
  );
}

add_task(async function the_fields_draw_in_the_forms_colours_when_solid() {
  await tintWindow(0);
  const { form } = await openForm();
  Assert.ok(!form.hasAttribute("frosted"), "the popover is solid");
  await checkFields(form, "tinted");
  formParts(form).cancel.click();
});

add_task(async function the_fields_draw_in_the_frosted_colours() {
  await tintWindow(TRANSPARENCY);
  const { form } = await openForm();
  Assert.ok(form.hasAttribute("frosted"), "the popover is frosted");
  await checkFields(form, "frosted");
  formParts(form).cancel.click();
});
