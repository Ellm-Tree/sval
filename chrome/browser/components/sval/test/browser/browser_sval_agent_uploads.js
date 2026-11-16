/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * No file picker opens in a tab an agent controls (agent-control spec §4.4):
 * files reach its pages only through `upload_file`.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * No file picker opens in an agent's tab (spec §4.4), however the page asks
 * for one: an input that becomes a file input as it is pressed, a label in a
 * shadow tree, a click handler's `click()` or `showPicker()`, or a `click()`
 * the page makes later on the activation the agent's click gave it. A tab
 * the user took back opens pickers again.
 */
add_task(async function no_file_picker_opens_in_an_agents_tab() {
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  let shown = 0;
  MockFilePicker.showCallback = () => {
    shown++;
  };
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  atTaskEnd(() => MockFilePicker.cleanup());

  const { tabs, agent, gate, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const holder = doc.createElement("div");
    holder.innerHTML =
      "<input id=morph aria-label=Morph onmousedown=\"this.type='file'\">" +
      "<div id=host></div>" +
      "<input type=file id=f style='position:absolute;left:-9999px'>" +
      "<button onclick=\"document.getElementById('f').click()\">Click it</button>" +
      "<button onclick=\"document.getElementById('f').showPicker()\">Show it</button>" +
      "<button onclick=\"setTimeout(() => document.getElementById('f').click(), 1000)\">Later</button>" +
      "<input type=file id=vis aria-label=Visible>";
    doc.body.prepend(holder);
    const shadow = doc.getElementById("host").attachShadow({ mode: "closed" });
    shadow.innerHTML =
      "<label><span role=button>Shadow pick</span>" +
      "<input type=file style='position:absolute;opacity:0;width:1px'></label>";
    // A file input fires `cancel` when its picker comes back with nothing,
    // which is what a refused picker does.
    doc.body.dataset.cancels = "0";
    const counted = () => doc.body.dataset.cancels++;
    for (const input of [
      doc.getElementById("morph"),
      doc.getElementById("f"),
      shadow.querySelector("input"),
    ]) {
      input.addEventListener("cancel", counted);
    }
  });
  const cancels = () =>
    SpecialPowers.spawn(browser, [], () =>
      Number(content.document.body.dataset.cancels)
    );
  // These two never reach the picker: Gecko starts no picker for an input
  // that turns into a file input under the press, and a label for a file
  // input is refused before the click is sent. They are checked again with
  // the rest below, after the time the later cases take.
  await call("click_element", {
    tab,
    ref: await refFor(call, tab, /textbox "Morph" \[(e\d+)\]/),
  });
  await Assert.rejects(
    call("click_element", {
      tab,
      ref: await refFor(call, tab, /button "Shadow pick" \[(e\d+)\]/),
    }),
    e => e.code === "not_clickable",
    "a label for a file input is refused"
  );
  // These ask for a picker, and each is refused with a cancel.
  for (const [what, pattern] of [
    ["a handler's click()", /button "Click it" \[(e\d+)\]/],
    ["a handler's showPicker()", /button "Show it" \[(e\d+)\]/],
    ["a click() a second later", /button "Later" \[(e\d+)\]/],
  ]) {
    const before = await cancels();
    await call("click_element", {
      tab,
      ref: await refFor(call, tab, pattern),
    });
    await TestUtils.waitForCondition(
      async () => (await cancels()) > before,
      `${what} asked for a picker and was turned down`
    );
    Assert.equal(shown, 0, `${what} opened no file picker`);
  }

  const found = await tabs.tabIn(agent, tab);
  const userWin = await newWindowAfter(() =>
    found.win.gBrowser.replaceTabWithWindow(found.tab)
  );
  const taken = userWin.gBrowser.selectedTab;
  await TestUtils.waitForCondition(
    () => gate.agentOf(taken.linkedBrowser) === null,
    "the tab is let go"
  );
  await within(SimpleTest.promiseFocus(userWin), 10_000, "the window's focus");
  const before = shown;
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#vis",
    {},
    taken.linkedBrowser
  );
  await TestUtils.waitForCondition(
    () => shown > before,
    "the user's own click opens the picker"
  );
});

/**
 * The gate's own record of the tabs an agent controls decides, regardless of
 * the mark that exposes WebMCP: a tab it holds whose mark is not set, as a
 * tab can be until its window draws it again, still opens no picker.
 */
add_task(async function an_unmarked_agent_tab_opens_no_picker() {
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  let shown = 0;
  MockFilePicker.showCallback = () => {
    shown++;
  };
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  atTaskEnd(() => MockFilePicker.cleanup());

  const { tabs, agent, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const holder = doc.createElement("div");
    holder.innerHTML =
      "<input type=file id=f style='position:absolute;left:-9999px'>" +
      "<button onclick=\"document.getElementById('f').showPicker()\">Show it</button>";
    doc.body.prepend(holder);
    doc.body.dataset.cancels = "0";
    doc
      .getElementById("f")
      .addEventListener("cancel", () => doc.body.dataset.cancels++);
  });
  browser.browsingContext.svalAgentTab = false;
  await call("click_element", {
    tab,
    ref: await refFor(call, tab, /button "Show it" \[(e\d+)\]/),
  });
  await TestUtils.waitForCondition(
    async () =>
      (await SpecialPowers.spawn(browser, [], () =>
        Number(content.document.body.dataset.cancels)
      )) > 0,
    "the page's picker was turned down"
  );
  Assert.equal(shown, 0, "and no file picker opened");
});
