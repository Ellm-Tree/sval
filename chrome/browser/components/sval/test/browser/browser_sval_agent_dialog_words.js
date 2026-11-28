/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_page_dialog_helpers.js */

/**
 * Whose words a dialog in an agent's tab speaks (agent-control spec §4.1): a
 * frame's alert is reported for its tab, and a dialog the agent may not read
 * the source of, a blocked site's frame, a blank, sandboxed or data: frame
 * such a site made, or a page since replaced, is reported with its words
 * withheld. A blank page is read as the site that wrote into it, and one
 * Sval opened for the agent as readable.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_page_dialog_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Adds an example.org frame to `browser`'s page.
 *
 * @param {object} browser
 * @returns {Promise<BrowsingContext>} The frame's.
 */
async function orgFrameIn(browser) {
  await SpecialPowers.spawn(browser, [ORG_PAGE], async src => {
    const frame = content.document.createElement("iframe");
    frame.src = src;
    const loaded = new Promise(resolve =>
      frame.addEventListener("load", resolve, { once: true })
    );
    content.document.body.append(frame);
    await loaded;
  });
  return browser.browsingContext.children.at(-1);
}

add_task(async function an_alert_from_a_frame_is_reported_for_its_tab() {
  const { call, store, agent, tab, browser } = await dialogsSetup();
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  const frame = await orgFrameIn(browser);
  Assert.notEqual(
    frame.currentWindowGlobal.documentPrincipal.origin,
    browser.browsingContext.currentWindowGlobal.documentPrincipal.origin,
    "the frame is another site's"
  );
  await alertFromTimer(frame, "from the frame");
  const result = await call("get_snapshot", { tab });
  Assert.deepEqual(result.dialog, { type: "alert", message: "from the frame" });
});

add_task(async function a_frame_from_a_blocked_site_keeps_its_words() {
  const { call, store, agent, tab, browser } = await dialogsSetup();
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  await alertFromTimer(await orgFrameIn(browser), "a secret");
  const result = await call("get_snapshot", { tab });
  Assert.deepEqual(
    result.dialog,
    { type: "withheld", message: "" },
    "the readable page does not speak for the blocked frame"
  );
});

add_task(async function a_blank_frame_speaks_for_the_site_that_made_it() {
  const { call, store, agent, tab, browser } = await dialogsSetup();
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  const frame = await orgFrameIn(browser);
  // An about:blank frame takes the origin of the page that made it, so its
  // address says nothing of whose words it shows.
  await SpecialPowers.spawn(frame, [], () => {
    content.setTimeout(() => {
      const child = content.document.createElement("iframe");
      content.document.body.append(child);
      child.contentWindow.alert("a secret");
      content.document.body.dataset.alerted = "yes";
    }, 0);
  });
  await alerted(frame);
  const result = await call("get_snapshot", { tab });
  Assert.deepEqual(result.dialog, { type: "withheld", message: "" });
});

add_task(async function a_sandboxed_frame_speaks_for_the_site_that_made_it() {
  const { call, store, agent, tab, browser } = await dialogsSetup();
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  const frame = await orgFrameIn(browser);
  // A sandboxed frame has a null principal, whose precursor is the page
  // that made it.
  await SpecialPowers.spawn(frame, [], () => {
    content.addEventListener("message", event => {
      if (event.data === "alerted") {
        content.document.body.dataset.alerted = "yes";
      }
    });
    const child = content.document.createElement("iframe");
    child.setAttribute("sandbox", "allow-scripts allow-modals");
    child.srcdoc =
      "<script>alert('a secret'); parent.postMessage('alerted', '*');</" +
      "script>";
    content.document.body.append(child);
  });
  await alerted(frame);
  const result = await call("get_snapshot", { tab });
  Assert.deepEqual(result.dialog, { type: "withheld", message: "" });
});

add_task(async function a_data_frame_speaks_for_the_site_that_loaded_it() {
  const { call, store, agent, tab, browser } = await dialogsSetup();
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  const frame = await orgFrameIn(browser);
  // A data: document has a null principal whose precursor is the page
  // that loaded it.
  await SpecialPowers.spawn(frame, [], () => {
    content.addEventListener("message", event => {
      if (event.data === "alerted") {
        content.document.body.dataset.alerted = "yes";
      }
    });
    const child = content.document.createElement("iframe");
    child.src =
      'data:text/html,<script>alert("a secret"); parent.postMessage("alerted", "*");</' +
      "script>";
    content.document.body.append(child);
  });
  await alerted(frame);
  const result = await call("get_snapshot", { tab });
  Assert.deepEqual(result.dialog, { type: "withheld", message: "" });
});

add_task(async function a_blank_page_a_blocked_page_wrote_is_not_read() {
  const setup = await dialogsSetup();
  const { call, store, agent, gate, win } = setup;
  const ref = await buttonRunning(
    setup,
    // Written as innerHTML: document.write would give the blank page its
    // opener's address.
    "const w = window.open('about:blank'); w.document.body.innerHTML = '<p>A secret</p>';"
  );
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  await call("click_element", { tab: setup.tab, ref });
  const popupTab = (await within(opened, 10_000, "the TabOpen event")).target;
  const popup = popupTab.linkedBrowser;
  await TestUtils.waitForCondition(
    () => gate.agentOf(popup)?.agentId === agent.agentId,
    "the page's new tab is the agent's"
  );
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  const popupId = win.SvalPanel.observer.nodeIdFor(popupTab);
  Assert.ok(popupId, "it is filed in the agent's workspace");
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(popup, [], () =>
        content.document.body?.textContent.includes("A secret")
      ),
    "the page wrote into it"
  );
  Assert.equal(popup.currentURI.spec, "about:blank");
  const before = await call("get_snapshot", { tab: popupId });
  Assert.ok(before.snapshot.includes("A secret"), "readable while allowed");

  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  await Assert.rejects(
    call("get_snapshot", { tab: popupId }),
    e => e.code === "policy_denied",
    "a blank page holding a blocked site's words is that site's"
  );
});

add_task(async function a_blank_tab_sval_opened_is_readable() {
  const { call, gate, tabs, agent } = await dialogsSetup();
  const { tab } = await call("open_tab", { url: "about:blank" });
  const { browser } = await tabs.tabIn(agent, tab);
  const principal =
    browser.browsingContext.currentWindowGlobal.documentPrincipal;
  info(
    `a blank agent tab: null ${principal.isNullPrincipal}, content ${principal.isContentPrincipal}, precursor ${!!principal.precursorPrincipal}`
  );
  Assert.ok(!principal.precursorPrincipal, "it has no precursor");
  Assert.strictEqual(gate.checkPage(agent, browser), true, "it is readable");

  await call("navigate_tab", { tab, to: PAGE });
  await call("navigate_tab", { tab, to: "about:blank" });
  const again = browser.browsingContext.currentWindowGlobal.documentPrincipal;
  info(
    `navigated to blank: null ${again.isNullPrincipal}, precursor ${!!again.precursorPrincipal}`
  );
  Assert.strictEqual(
    gate.checkPage(agent, browser),
    true,
    "a blank page the agent loaded is readable"
  );
});

add_task(async function a_page_the_agent_may_no_longer_read_keeps_its_words() {
  const { call, store, agent, tab, browser } = await dialogsSetup();
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  await alertFromTimer(browser.browsingContext, "an account number");
  // navigate_tab moves a tab on from a page the agent may not read, so it
  // reads nothing of the page, the dialog's words included.
  const result = await call("navigate_tab", { tab, to: ORG_PAGE });
  Assert.equal(result.url, ORG_PAGE);
  Assert.deepEqual(result.dialog, { type: "withheld", message: "" });
});

/**
 * A dialog speaks for the document that raised it. One whose context shows
 * another document by the time it opens, as when a navigation commits
 * meanwhile, is no page's: its words are withheld.
 */
add_task(async function a_dialog_from_a_page_since_replaced_keeps_its_words() {
  const { raw, dialogs, store, agent, tab, browser, win } =
    await dialogsSetup();
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  const { PromptUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PromptUtils.sys.mjs"
  );
  // What `PromptParent` opens for a confirm an example.org page raised, in
  // a tab that has since committed the example.com page.
  const args = {
    promptType: "confirm",
    title: "",
    text: "a secret",
    checkLabel: "",
    checked: false,
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
    owningBrowsingContext: browser.browsingContext,
    promptPrincipal:
      Services.scriptSecurityManager.createContentPrincipalFromOrigin(
        "https://example.org"
      ),
  };
  const { closedPromise } = win.gBrowser
    .getTabDialogBox(browser)
    .open(
      "chrome://browser/content/sval/prompt-dialog.xhtml",
      { features: "resizable=no", modalType: args.modalType },
      PromptUtils.objectToPropBag(args)
    );
  await TestUtils.waitForCondition(
    () => dialogs.openDialog(browser),
    "the confirm waits for the agent"
  );
  const refused = JSON.parse(
    (await raw("get_snapshot", { tab })).content[0].text
  );
  Assert.equal(refused.error, "dialog_open");
  Assert.deepEqual(refused.dialog, { type: "withheld", message: "" });
  dialogs.answer(browser, { accept: false });
  await closedPromise;
});
