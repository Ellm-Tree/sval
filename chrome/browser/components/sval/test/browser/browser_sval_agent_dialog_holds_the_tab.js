/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_answer_dialog_helpers.js */

/**
 * What a page's open `confirm` or `prompt` holds back (agent-control spec
 * §4.1): every other tool on the tab fails with `dialog_open`, input that
 * reaches the page is refused there, an upload stops, and a dialog nobody
 * answers stays up for the user. `browser_sval_agent_answers_dialogs.js` covers
 * answering one.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { pageActor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs"
);

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_answer_dialog_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

add_task(async function every_other_tool_waits_for_the_answer() {
  const setup = await dialogsSetup();
  const { call, raw, tabs, agent, tab, browser } = setup;
  const ref = await buttonRunning(setup, CONFIRM);
  await call("click_element", { tab, ref });
  for (const [name, args] of [
    ["get_snapshot", { tab }],
    ["get_screenshot", { tab }],
    ["get_page_source", { tab }],
    ["get_page_text", { tab }],
    ["click_element", { tab, ref }],
    ["type_text", { tab, ref, text: "x" }],
    ["fill_form", { tab, fields: [{ ref, text: "x" }] }],
    ["select_option", { tab, ref, values: ["a"] }],
    ["press_keys", { tab, keys: ["a"] }],
    ["scroll_page", { tab, direction: "down" }],
    ["wait_for_text", { tab, text: "Sign in", timeout_ms: 100 }],
    ["navigate_tab", { tab, to: PAGE2 }],
    ["upload_file", { tab, ref, paths: ["/nonexistent"] }],
  ]) {
    const result = await raw(name, args);
    Assert.strictEqual(result.isError, true, `${name} fails`);
    const body = bodyOf(result);
    Assert.equal(body.error, "dialog_open", name);
    Assert.ok(body.message.startsWith("dialog_open: "), name);
    Assert.deepEqual(
      body.dialog,
      { type: "confirm", message: "Delete everything?" },
      `${name} carries the dialog`
    );
  }
  Assert.equal(browser.currentURI.spec, PAGE, "nothing moved the tab");
  Assert.deepEqual(
    (await tabs.listTabsFor(agent)).map(t => t.tab),
    [tab],
    "the tab is still listed"
  );
  await call("answer_dialog", { tab, accept: false });
  const after = await call("get_snapshot", { tab });
  Assert.equal(after.error, undefined, "the tab answers again");
});

/**
 * An input that reaches the page while a dialog holds it is refused there:
 * the page's events are suppressed until the dialog closes, and would then
 * arrive late, as nobody meant them.
 */
add_task(async function the_page_refuses_input_while_a_dialog_holds_it() {
  const setup = await dialogsSetup();
  const { browser } = setup;
  const ref = await buttonRunning(setup, "document.body.dataset.clicks = 'x'");
  await SpecialPowers.spawn(browser, [], () => {
    const field = content.document.createElement("input");
    field.setAttribute("aria-label", "Held field");
    field.addEventListener("focus", () => {
      content.document.body.dataset.focused = "yes";
    });
    content.document.body.prepend(field);
  });
  const { snapshot } = await setup.call("get_snapshot", { tab: setup.tab });
  const field = snapshot.match(/textbox "Held field" \[(e\d+)\]/)[1];
  await SpecialPowers.spawn(browser, [], () => {
    content.setTimeout(() => content.confirm("Wait"), 0);
  });
  await TestUtils.waitForCondition(
    () => setup.dialogs.openDialog(browser),
    "the confirm is up"
  );
  for (const [what, query] of [
    ["a click", () => pageActor(browser).click({ ref })],
    ["keys", () => pageActor(browser).press({ keys: ["a"] })],
    ["typing", () => pageActor(browser).type({ ref: field, text: "a" })],
  ]) {
    await Assert.rejects(
      query(),
      e => e.code === "dialog_open",
      `${what} is refused in the page`
    );
  }
  await setup.call("answer_dialog", { tab: setup.tab, accept: true });
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.body.dataset.clicks
    ),
    undefined,
    "and nothing arrived after the answer"
  );
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.body.dataset.focused
    ),
    undefined,
    "no field was focused in the held page"
  );
});

add_task(
  async function a_dialog_opened_while_the_user_decides_stops_an_upload() {
    const setup = await dialogsSetup();
    const { raw, call, win, tab, browser } = setup;
    const dir = await makeTempDir("sval-agent-upload");
    atTaskEnd(() => IOUtils.remove(dir, { recursive: true }));
    const path = PathUtils.join(dir, "a.txt");
    await IOUtils.writeUTF8(path, "a");
    await SpecialPowers.spawn(browser, [], () => {
      const input = content.document.createElement("input");
      input.type = "file";
      input.id = "up";
      input.setAttribute("aria-label", "Up");
      content.document.body.prepend(input);
    });
    const { snapshot } = await call("get_snapshot", { tab });
    const ref = snapshot.match(/"Up" \[(e\d+)\]/)[1];
    const uploading = raw("upload_file", { tab, ref, paths: [path] });
    const doc = await alertIn(win);
    await SpecialPowers.spawn(browser, [], () => {
      content.setTimeout(() => content.confirm("Meanwhile"), 0);
    });
    await TestUtils.waitForCondition(
      () => setup.dialogs.openDialog(browser),
      "the page's confirm is up"
    );
    // The confirm took focus, and the alert's grants wait for it again.
    win.gDialogBox.dialog._frame.contentWindow.focus();
    await choose(doc, "allow");
    const result = JSON.parse((await uploading).content[0].text);
    Assert.equal(result.error, "dialog_open", "the upload stops");
    await call("answer_dialog", { tab, accept: true });
    Assert.equal(
      await SpecialPowers.spawn(
        browser,
        [],
        () => content.document.getElementById("up").files.length
      ),
      0,
      "no file reached the page"
    );
  }
);

/** A dialog nobody answers stays up for the user, even with access off. */
add_task(async function an_unanswered_dialog_stays_for_the_user() {
  const setup = await dialogsSetup();
  const { call, tab, browser } = setup;
  const ref = await buttonRunning(setup, CONFIRM);
  await call("click_element", { tab, ref });
  await agentAccessOff();
  // Access going off closes the dialog handling and the gate at once. A
  // dialog answered by either, through its buttons as `modal.Dialog`
  // answers one, is marked no longer active as it is pressed.
  Assert.equal(dialogsUp(browser), 1, "the confirm is still up");
  const dialog = browser.documentGlobal.gBrowser
    .getTabDialogBox(browser)
    .getContentDialogManager().dialogs[0];
  Assert.notStrictEqual(
    dialog.frameContentWindow.Dialog.args.promptActive,
    false,
    "and nobody has answered it"
  );
  dialog.frameContentWindow.Dialog.ui.button0.click();
  Assert.equal(await nextAnswerIn(browser), "true", "the user answered it");
});
