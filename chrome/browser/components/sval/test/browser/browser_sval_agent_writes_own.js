/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * The write gate holds only the agent's writes (agent-control spec §5.3):
 * what the document its input went to sends, with that document's frames
 * and what it opened. A page a navigation committed sends its own, and a
 * beacon or a ping is never held.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

const FETCH = /button "Send by fetch" \[(e\d+)\]/;

/** The page that reports its own load, on another site than `PAGE`'s. */
const ORG_ANALYTICS = ORG_PAGE.replace(
  "sval_agent_page2.html",
  "sval_agent_analytics.html"
);

/**
 * A paired agent whose tab shows the test page, at `level` on example.com
 * and example.org.
 *
 * @param {string} [level]
 * @returns {Promise<object>} `agentSetup`'s, with the tab, its browser, and
 *   `ref`, which finds a ref in a fresh snapshot.
 */
async function ownSetup(level = "ask-before-writes") {
  const setup = await agentSetup({
    sites: { "example.com": level, "example.org": level },
  });
  const { call, tabs, agent } = setup;
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const ref = async re =>
    (await call("get_snapshot", { tab })).snapshot.match(re)[1];
  return { ...setup, tab, browser, ref };
}

/**
 * Only the agent's own writes are held (spec §5.3): a click that moves the
 * tab to another page holds nothing that page sends once it has loaded,
 * such as its own analytics.
 */
add_task(async function a_page_the_click_moved_to_writes_on_its_own() {
  const { call, alerts, tab, browser } = await ownSetup();
  await SpecialPowers.spawn(browser, [], () => {
    const link = content.document.createElement("a");
    link.href = "sval_agent_analytics.html";
    link.textContent = "Article";
    content.document.body.prepend(link);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const article = snapshot.match(/link "Article" \[(e\d+)\]/)[1];
  const seen = requestsTo("/sval-analytics");
  const result = await call("click_element", { tab, ref: article });
  await TestUtils.waitForCondition(
    () => browser.currentURI.filePath.endsWith("/sval_agent_analytics.html"),
    "the click moved the tab"
  );
  await stopped(seen);
  Assert.ok(
    Components.isSuccessCode(seen.stopped[0]),
    "the new page's own write went out"
  );
  Assert.equal(alerts.opened, 0, "nobody was asked about it");
  Assert.equal(result.writes, "none", "and it is not the agent's");
});

/**
 * A beacon gets no answer a page can act on, and sites send them for
 * analytics, so one is never held (spec §5.3).
 */
add_task(async function a_beacon_the_click_sends_is_never_held() {
  const { call, alerts, tab, browser, ref } = await ownSetup();
  await SpecialPowers.spawn(browser, [], () => {
    const button = content.document.getElementById("fetch");
    button.onclick = null;
    button.addEventListener("click", () =>
      content.navigator.sendBeacon("https://example.com/sval-beacon", "x")
    );
  });
  const seen = requestsTo("/sval-beacon");
  const result = await call("click_element", { tab, ref: await ref(FETCH) });
  await stopped(seen);
  Assert.ok(Components.isSuccessCode(seen.stopped[0]), "the beacon went out");
  Assert.equal(alerts.opened, 0, "unasked");
  Assert.equal(result.writes, "allowed");
});

add_task(async function a_read_only_site_still_refuses_a_beacon() {
  const { call, alerts, tab, browser, ref } = await ownSetup("read-only");
  await SpecialPowers.spawn(browser, [], () => {
    const button = content.document.getElementById("fetch");
    button.onclick = null;
    button.addEventListener("click", () =>
      content.navigator.sendBeacon("https://example.com/sval-beacon", "x")
    );
  });
  const seen = requestsTo("/sval-beacon");
  const result = await call("click_element", { tab, ref: await ref(FETCH) });
  Assert.equal(result.writes, "refused_read_only");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT]);
  Assert.equal(alerts.opened, 0);
});

/**
 * A frame of the page the agent's input went to is that page's: a write it
 * sends is held like the page's own.
 */
add_task(async function a_write_from_a_frame_of_the_agents_page_is_held() {
  const { call, win, tab, browser } = await ownSetup();
  await SpecialPowers.spawn(browser, [PAGE2], async src => {
    const doc = content.document;
    const frame = doc.createElement("iframe");
    frame.src = src;
    const loaded = new Promise(resolve =>
      frame.addEventListener("load", resolve, { once: true })
    );
    doc.body.append(frame);
    await loaded;
    const button = doc.createElement("button");
    button.textContent = "Tell the frame";
    button.setAttribute(
      "onclick",
      "document.querySelector('iframe').contentWindow.postMessage('go', '*')"
    );
    doc.body.prepend(button);
  });
  await SpecialPowers.spawn(browser.browsingContext.children[0], [], () => {
    const script = content.document.createElement("script");
    script.textContent = `addEventListener("message", () =>
      fetch("https://example.com/sval-fetch", { method: "POST", body: "x" }));`;
    content.document.body.append(script);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Tell the frame" \[(e\d+)\]/)[1];
  const seen = requestsTo("/sval-fetch");
  const clicked = call("click_element", { tab, ref });
  const doc = await alertIn(win);
  Assert.deepEqual(heldRequests(doc), [
    { method: "POST", target: "example.com", path: "/sval-fetch" },
  ]);
  await choose(doc, "deny");
  Assert.equal((await clicked).writes, "denied");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT]);
});

/**
 * A write the page's own document sends as it navigates away is the
 * agent's: the document the input went to sent it. It is a keepalive fetch,
 * the one kind of request a page's own navigation does not cancel.
 */
add_task(async function a_write_the_old_page_sends_as_it_leaves_is_held() {
  const { call, win, tab, browser } = await ownSetup();
  await SpecialPowers.spawn(browser, [], () => {
    const button = content.document.createElement("button");
    button.textContent = "Send and leave";
    button.setAttribute(
      "onclick",
      `fetch("https://example.com/sval-fetch",
         { method: "POST", body: "x", keepalive: true });
       location.href = "sval_agent_page2.html";`
    );
    content.document.body.prepend(button);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Send and leave" \[(e\d+)\]/)[1];
  const clicked = call("click_element", { tab, ref });
  const doc = await alertIn(win);
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-fetch" }],
    "the old page's write is held"
  );
  await choose(doc, "deny");
  Assert.equal((await clicked).writes, "denied");
});

/**
 * A popup the input opened is the agent's, and stays a popup in its
 * workspace, but a page of another site it loads is not the agent's input:
 * the opener cannot script it, so what that page sends as it loads is its
 * own, as a page the click moved a tab to sends its own, and nobody is
 * asked about it (spec §5.3). What the agent's own input in the popup sends
 * is still held.
 */
add_task(async function a_popup_of_another_sites_page_writes_on_its_own() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.disable_open_during_load", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { call, agent, alerts, win, tab, browser } = await ownSetup();
  await SpecialPowers.spawn(browser, [ORG_ANALYTICS], src => {
    const button = content.document.createElement("button");
    button.textContent = "Open the article";
    button.setAttribute(
      "onclick",
      `window.open(${JSON.stringify(src)}, "_blank", "popup")`
    );
    content.document.body.prepend(button);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Open the article" \[(e\d+)\]/)[1];
  const seen = requestsTo("/sval-analytics");
  let clicked;
  const popupWin = await newWindowAfter(async () => {
    clicked = await call("click_element", { tab, ref });
  });
  Assert.ok(!popupWin.toolbar.visible, "the popup stays a popup");
  Assert.equal(
    popupWin.SvalPanel.workspaceId,
    agent.workspaceId,
    "in the agent's workspace"
  );
  await stopped(seen);
  Assert.ok(
    Components.isSuccessCode(seen.stopped[0]),
    "the popup's page's own write went out"
  );
  Assert.equal(alerts.opened, 0, "nobody was asked about it");
  Assert.equal(clicked.writes, "none", "and it is not the agent's");

  const popupTab = popupWin.gBrowser.selectedTab;
  let popupNode;
  await TestUtils.waitForCondition(() => {
    popupNode = popupWin.SvalPanel.observer?.nodeIdFor(popupTab);
    return popupNode;
  }, "the popup's tab is filed");
  await SpecialPowers.spawn(popupTab.linkedBrowser, [], () => {
    const button = content.document.createElement("button");
    button.textContent = "Send";
    button.setAttribute(
      "onclick",
      `fetch("https://example.com/sval-fetch", { method: "POST", body: "x" })`
    );
    content.document.body.prepend(button);
  });
  const send = await refFor(call, popupNode, /button "Send" \[(e\d+)\]/);
  const sent = requestsTo("/sval-fetch");
  const input = call("click_element", { tab: popupNode, ref: send });
  const doc = await alertIn(win);
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-fetch" }],
    "the agent's own write in the popup is held"
  );
  await choose(doc, "deny");
  Assert.equal((await input).writes, "denied");
  await stopped(sent);
  Assert.deepEqual(sent.stopped, [Cr.NS_ERROR_ABORT]);
});

/**
 * A form the agent's click posts into a new window is the agent's write,
 * though it opens a window to send it: the load that opens the window is
 * judged as the click's (spec §5.3).
 */
add_task(async function a_form_posted_into_a_new_window_is_held() {
  const { call, win, tab, browser } = await ownSetup();
  await SpecialPowers.spawn(browser, [], () => {
    const form = content.document.createElement("form");
    form.method = "post";
    form.target = "_blank";
    form.action = "https://example.com/sval-form";
    const button = content.document.createElement("button");
    button.textContent = "Post it";
    form.append(button);
    content.document.body.prepend(form);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Post it" \[(e\d+)\]/)[1];
  const seen = requestsTo("/sval-form");
  const clicked = call("click_element", { tab, ref });
  const doc = await alertIn(win);
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-form" }],
    "the posted form is held"
  );
  await choose(doc, "deny");
  Assert.equal((await clicked).writes, "denied");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT]);
});

/**
 * Opens a popup from the agent's page with a click whose handler is
 * `onclick`, and waits for the write it makes there to be asked about.
 *
 * @param {string} onclick The button's handler, which opens a popup and
 *   writes through it.
 * @param {string} [path] The path the write goes to.
 * @returns {Promise<{doc: Document, clicked: Promise<object>, seen: object}>}
 *   The alert, the click's call, and the writes to `path`.
 */
async function writeThroughPopup(onclick, path = "/sval-fetch") {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.disable_open_during_load", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { call, agent, win, tab, browser } = await ownSetup();
  await SpecialPowers.spawn(browser, [onclick], handler => {
    const button = content.document.createElement("button");
    button.textContent = "Open and write";
    button.setAttribute("onclick", handler);
    content.document.body.prepend(button);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Open and write" \[(e\d+)\]/)[1];
  const seen = requestsTo(path);
  let clicked;
  const popupWin = await newWindowAfter(async () => {
    clicked = call("click_element", { tab, ref });
  });
  Assert.equal(
    popupWin.SvalPanel.workspaceId,
    agent.workspaceId,
    "the popup is in the agent's workspace"
  );
  return { doc: await alertIn(win), clicked, seen };
}

/**
 * A page the agent's input reached can script a page of its own site in a
 * popup it opened, so a write it makes that page send is the agent's
 * (spec §5.3): it is held, and Deny cancels it.
 */
add_task(async function a_write_through_a_popups_page_is_held() {
  const { doc, clicked, seen } = await writeThroughPopup(
    `const popup = window.open("sval_agent_page2.html", "_blank", "popup");
     popup.addEventListener("load", () => {
       const script = popup.document.createElement("script");
       script.textContent =
         'fetch("https://example.com/sval-fetch", { method: "POST", body: "x" })';
       popup.document.body.append(script);
     });`
  );
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-fetch" }],
    "the write the opener made the popup send is held"
  );
  await choose(doc, "deny");
  await clicked;
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT], "Deny cancelled it");
});

/**
 * A popup the agent's page opened stays the agent's once that page is
 * destroyed: a write a page of the same site sends there after the opener's
 * tab has moved on is still held (spec §5.3).
 */
add_task(async function a_popups_write_after_its_opener_is_gone_is_held() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.disable_open_during_load", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { call, win, tab, browser } = await ownSetup();
  await SpecialPowers.spawn(browser, [], () => {
    const button = content.document.createElement("button");
    button.textContent = "Open";
    button.setAttribute(
      "onclick",
      'window.open("sval_agent_page2.html", "_blank", "popup")'
    );
    content.document.body.prepend(button);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Open" \[(e\d+)\]/)[1];
  let clicked;
  const popupWin = await newWindowAfter(async () => {
    clicked = call("click_element", { tab, ref });
  });
  const popup = popupWin.gBrowser.selectedBrowser;
  await pageReady(popup, PAGE2);
  await clicked;

  const opener = browser.browsingContext.currentWindowGlobal.innerWindowId;
  const loaded = BrowserTestUtils.browserLoaded(browser, false, ORG_PAGE);
  loadPastLayer(browser, ORG_PAGE);
  await within(loaded, 10_000, "the opener's tab's load");
  await TestUtils.waitForCondition(() => {
    const page = WindowGlobalParent.getByInnerWindowId(opener);
    return !page || page.isClosed;
  }, "the opener's page is destroyed");

  const seen = requestsTo("/sval-fetch");
  await SpecialPowers.spawn(popup, [], () => {
    content.fetch("https://example.com/sval-fetch", {
      method: "POST",
      body: "x",
    });
  });
  const doc = await alertIn(win);
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-fetch" }],
    "the popup's write is held"
  );
  await choose(doc, "deny");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT], "Deny cancelled it");
});

/**
 * A blank popup the agent's page opened is its own document to write, and
 * stays so after `document.open` replaces its content: a write the written
 * page sends is the agent's (spec §5.3).
 */
add_task(async function a_write_from_a_blank_popup_the_page_wrote_is_held() {
  const { doc, clicked, seen } = await writeThroughPopup(
    `const popup = window.open("", "_blank", "popup");
     popup.document.open();
     popup.document.write('<p>Written<\\/p><script>' +
       'fetch("https://example.com/sval-fetch", { method: "POST", body: "x" })' +
       '<\\/script>');
     popup.document.close();`
  );
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-fetch" }],
    "the written page's write is held"
  );
  await choose(doc, "deny");
  await clicked;
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT], "Deny cancelled it");
});

/**
 * Opens a popup of the agent's page's own site and, once it has loaded,
 * puts `frame` into it, as the opener can.
 *
 * @param {string} frame Statements that set up `iframe`, a new iframe.
 * @returns {string} The handler.
 */
function framedPopup(frame) {
  return `const popup = window.open("sval_agent_page2.html", "_blank", "popup");
    popup.addEventListener("load", () => {
      const iframe = popup.document.createElement("iframe");
      ${frame}
      popup.document.body.append(iframe);
    });`;
}

/**
 * A frame of another site in a popup the agent's page can script is that
 * popup page's, as a frame is its tab's page's: what it sends is held
 * (spec §5.3).
 */
add_task(
  async function a_write_from_another_sites_frame_in_its_popup_is_held() {
    const { doc, clicked, seen } = await writeThroughPopup(
      framedPopup(`iframe.src = ${JSON.stringify(ORG_ANALYTICS)};`),
      "/sval-analytics"
    );
    Assert.deepEqual(
      heldRequests(doc),
      [{ method: "POST", target: "example.com", path: "/sval-analytics" }],
      "the frame's write is held"
    );
    await choose(doc, "deny");
    await clicked;
    await stopped(seen);
    Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT], "Deny cancelled it");
  }
);

/**
 * A sandboxed frame the opener writes into a popup it can script has an
 * origin of its own, and is still that popup page's: its write is held
 * (spec §5.3).
 */
add_task(async function a_write_from_a_sandboxed_frame_in_its_popup_is_held() {
  const { doc, clicked, seen } = await writeThroughPopup(
    framedPopup(`iframe.sandbox = "allow-scripts";
      iframe.srcdoc = '<script>fetch("https://example.com/sval-fetch",' +
        ' { method: "POST", body: "x" })<\\/script>';`)
  );
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-fetch" }],
    "the sandboxed frame's write is held"
  );
  await choose(doc, "deny");
  await clicked;
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT], "Deny cancelled it");
});
