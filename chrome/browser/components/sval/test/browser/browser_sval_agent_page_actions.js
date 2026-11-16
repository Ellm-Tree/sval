/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_page_helpers.js */

/**
 * The page actor acting on an agent's page (agent-control spec §5.5):
 * clicking, typing, choosing, scrolling and screenshots, each refusing what a
 * person could not do.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_page_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

add_task(async function click_type_select_and_press_drive_the_page() {
  const { page, browser } = await openPage();
  let { text } = await page.snapshot();
  const ref = re => text.match(re)[1];
  const typed = await page.type({
    ref: ref(/textbox "Email" \[(e\d+)\]/),
    text: "me@x.com",
    clear: true,
  });
  Assert.equal(typed.value, "me@x.com", "type answers the field's value");
  await page.click({ ref: ref(/checkbox "Keep me signed in" \[(e\d+)\]/) });
  await page.select({ ref: ref(/combobox[^\[]*\[(e\d+)\]/), values: ["Pro"] });
  const state = await SpecialPowers.spawn(browser, [], () => ({
    email: content.document.getElementById("email").value,
    keep: content.document.getElementById("keep").checked,
    plan: content.document.getElementById("plan").value,
  }));
  Assert.deepEqual(state, {
    email: "me@x.com",
    keep: true,
    plan: "b",
  });
});

add_task(async function synthesized_clicks_are_trusted() {
  const { page, browser } = await openPage();
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("keep").addEventListener(
      "click",
      e => {
        content.document.body.dataset.trusted = String(e.isTrusted);
      },
      { once: true }
    );
  });
  const { text } = await page.snapshot();
  await page.click({
    ref: text.match(/checkbox "Keep me signed in" \[(e\d+)\]/)[1],
  });
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.body.dataset.trusted
    ),
    "true"
  );
});

add_task(async function a_screenshot_is_a_png_of_the_viewport() {
  const { browser } = await openPage();
  const { screenshot } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs"
  );
  const data = await screenshot(browser);
  Assert.ok(atob(data).startsWith("\x89PNG"));
});

/**
 * @param {string} data A base64 PNG.
 * @returns {number} Its width in pixels, from its IHDR chunk.
 */
function pngWidth(data) {
  const bytes = atob(data);
  return [16, 17, 18, 19].reduce((w, i) => w * 256 + bytes.charCodeAt(i), 0);
}

/**
 * A screenshot fits in one reply to the agent: it is drawn in CSS pixels
 * whatever the screen's density, drawn smaller when it would still not fit,
 * and refused when even the smallest would not.
 */
add_task(async function a_screenshot_fits_in_one_reply() {
  await SpecialPowers.pushPrefEnv({
    set: [["layout.css.devPixelsPerPx", "2"]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { browser } = await openPage();
  const { screenshot } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs"
  );
  const cssWidth = await SpecialPowers.spawn(
    browser,
    [],
    () => content.innerWidth
  );
  const full = await screenshot(browser);
  Assert.equal(pngWidth(full), cssWidth, "drawn in CSS pixels");

  const smaller = await screenshot(browser, { maxBytes: full.length - 1 });
  Assert.less(pngWidth(smaller), cssWidth, "drawn smaller to fit");
  Assert.lessOrEqual(smaller.length, full.length - 1);

  await Assert.rejects(
    screenshot(browser, { maxBytes: 10 }),
    e => e.code === "screenshot_too_large",
    "refused when nothing fits"
  );
});

add_task(async function typing_appends_masks_and_types_text_literally() {
  const { page, browser } = await openPage();
  const { text } = await page.snapshot();
  const ref = re => text.match(re)[1];
  const email = ref(/textbox "Email" \[(e\d+)\]/);
  await page.type({ ref: email, text: "ab", clear: true });
  Assert.equal(
    (await page.type({ ref: email, text: "cd", clear: false })).value,
    "abcd",
    "clear: false appends"
  );
  await page.press({ keys: ["Backspace", "Backspace", "z", "Space", "!"] });
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("email").value
    ),
    "abz !",
    "keys go to the focused field"
  );
  Assert.equal(
    (await page.type({ ref: email, text: "", clear: true })).value,
    "",
    "clearing with no text empties the field"
  );
  // U+E009 and U+E006 are WebDriver's Control and Enter. Typed text is
  // text, so they must not hold Control down or press Enter.
  await page.type({ ref: email, text: "xa", clear: true });
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("email").value
    ),
    "xa",
    "WebDriver's key code points are typed as characters"
  );
  const pw = await page.type({
    ref: ref(/textbox "Password" \[(e\d+)\]/),
    text: "s3cret",
    clear: true,
  });
  Assert.equal(pw.value, "••••", "a password's value is masked");
});

add_task(async function inputs_refuse_what_a_person_could_not_do() {
  const { page, browser } = await openPage();
  const { text } = await page.snapshot();
  const ref = re => text.match(re)[1];
  await Assert.rejects(
    page.type({
      ref: ref(/checkbox "Keep me signed in" \[(e\d+)\]/),
      text: "x",
      clear: true,
    }),
    e => e.code === "not_editable"
  );
  await Assert.rejects(
    page.select({ ref: ref(/combobox[^\[]*\[(e\d+)\]/), values: ["Gold"] }),
    e => e.code === "no_such_option"
  );
  await Assert.rejects(
    page.select({ ref: ref(/link "Next page" \[(e\d+)\]/), values: ["Pro"] }),
    e => e.code === "not_a_select"
  );
  await Assert.rejects(
    page.press({ keys: ["a", "Hyper"] }),
    e => e.code === "unknown_key"
  );
  const button = ref(/button "Alert" \[(e\d+)\]/);
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("alert").style.display = "none";
  });
  await Assert.rejects(
    page.click({ ref: button }),
    e => e.code === "not_visible"
  );
});

add_task(async function scrolling_moves_the_page() {
  const { page, browser } = await openPage();
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const tall = doc.createElement("div");
    tall.style.height = "5000px";
    doc.body.append(tall);
    const end = doc.createElement("button");
    end.textContent = "At the end";
    doc.body.append(end);
  });
  const { text } = await page.snapshot();
  const scrollY = () => SpecialPowers.spawn(browser, [], () => content.scrollY);
  await page.scroll({ direction: "down", amount: 2 });
  const height = await SpecialPowers.spawn(
    browser,
    [],
    () => content.innerHeight
  );
  Assert.less(
    Math.abs((await scrollY()) - height * 0.8 * 2),
    2,
    "two screens down, at once"
  );
  await page.scroll({ direction: "up" });
  Assert.less(await scrollY(), height, "and one back up");
  await page.scroll({ ref: text.match(/button "At the end" \[(e\d+)\]/)[1] });
  Assert.greater(await scrollY(), 4000, "a ref scrolls into view");
});

add_task(async function typing_never_lands_outside_its_field() {
  const { page, browser } = await openPage();
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const hidden = doc.createElement("input");
    hidden.setAttribute("aria-label", "Ghost");
    hidden.style.visibility = "hidden";
    const date = doc.createElement("input");
    date.type = "date";
    date.setAttribute("aria-label", "When");
    date.inert = true;
    doc.body.append(hidden, date);
  });
  await page.snapshot();
  // A hidden field has no line in the outline, so its ref comes from a
  // snapshot taken while it was shown.
  await SpecialPowers.spawn(browser, [], () => {
    content.document.querySelector("[aria-label=Ghost]").style.visibility = "";
  });
  const ghost = (await page.snapshot()).text.match(
    /textbox "Ghost" \[(e\d+)\]/
  )[1];
  await SpecialPowers.spawn(browser, [], () => {
    content.document.querySelector("[aria-label=Ghost]").style.visibility =
      "hidden";
  });
  await Assert.rejects(
    page.type({ ref: ghost, text: "boo", clear: true }),
    e => e.code === "not_focusable",
    "a hidden field cannot be typed into"
  );
  // An inert field may have no line in the outline, so its ref comes from a
  // snapshot taken before it went inert.
  await SpecialPowers.spawn(browser, [], () => {
    content.document.querySelector("[aria-label=When]").inert = false;
  });
  const when = (await page.snapshot()).text.match(
    /textbox "When" \[(e\d+)\]/
  )[1];
  await SpecialPowers.spawn(browser, [], () => {
    content.document.querySelector("[aria-label=When]").inert = true;
  });
  await Assert.rejects(
    page.type({ ref: when, text: "2026-01-01" }),
    e => e.code === "not_focusable",
    "an inert date field refuses"
  );
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.querySelector("[aria-label=When]").value
    ),
    "",
    "the inert date field is unchanged"
  );
});

add_task(async function disabled_options_are_never_chosen_or_cleared() {
  const { page, browser } = await openPage();
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const one = doc.createElement("select");
    one.setAttribute("aria-label", "One");
    one.innerHTML =
      "<option>Open</option><option disabled>Shut</option>" +
      "<optgroup label='G' disabled><option>Grouped</option></optgroup>";
    const many = doc.createElement("select");
    many.id = "many";
    many.multiple = true;
    many.setAttribute("aria-label", "Many");
    many.innerHTML =
      "<option>A</option><option>B</option><option disabled selected>Locked</option>";
    doc.body.append(one, many);
  });
  const { text } = await page.snapshot();
  const one = text.match(/listbox "One" \[(e\d+)\]|combobox "One" \[(e\d+)\]/);
  const oneRef = one[1] ?? one[2];
  for (const value of ["Shut", "Grouped"]) {
    await Assert.rejects(
      page.select({ ref: oneRef, values: [value] }),
      e => e.code === "no_such_option",
      `${value} cannot be chosen`
    );
  }
  const many = text.match(
    /listbox "Many" \[(e\d+)\]|combobox "Many" \[(e\d+)\]/
  );
  await page.select({ ref: many[1] ?? many[2], values: ["B"] });
  Assert.deepEqual(
    await SpecialPowers.spawn(browser, [], () =>
      [...content.document.getElementById("many").selectedOptions].map(
        o => o.label
      )
    ),
    ["B", "Locked"],
    "a disabled option keeps its state"
  );
});
