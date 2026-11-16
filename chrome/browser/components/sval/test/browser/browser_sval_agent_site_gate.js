/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_sites_helpers.js */

/**
 * Site policy (agent-control spec §5.2), enforced: every top-level load in an
 * agent's tabs is checked, whoever starts it, a page on a site now blocked is
 * refused to the tools, and the user's own tabs are never gated. A PDF, an
 * error page and a blob are read as the site they belong to, or not at all.
 *
 * Site policy's other files are `browser_sval_agent_site_alert.js`,
 * `browser_sval_agent_watched_tabs.js` and `browser_sval_agent_tab_filing.js`;
 * their shared helpers are in `sval_agent_sites_helpers.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_sites_helpers.js",
  this
);
const { politeRules } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * A page's own navigation to a Blocked site is refused, and the tab shows
 * about:agentblocked at the address, which the agent may read.
 */
add_task(async function a_page_cannot_go_to_a_blocked_site() {
  const { tabs, agent, call, win, alerts } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  await clickIn(browser, "#blocked");
  await refused(stops, browser, ORG_PAGE);
  const text = await blockedPage(browser);
  const reason = text.split("\n").find(line => line.includes("example.org"));
  Assert.ok(reason, "the page names the blocked site");
  Assert.equal(browser.currentURI.spec, ORG_PAGE, "at the refused address");
  const { snapshot } = await call("get_snapshot", { tab });
  Assert.ok(snapshot.includes(reason.trim()), "and the agent reads it");
  Assert.equal(alerts.opened, 0);
});

/**
 * The agent's own load of a Blocked site shows the same page, and answers
 * with it and HTTP's Forbidden.
 */
add_task(async function the_agents_load_of_a_blocked_site_answers_403() {
  const { tabs, agent, call, alerts } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const moved = await call("navigate_tab", { tab, to: ORG_PAGE });
  Assert.equal(moved.status, 403);
  Assert.equal(moved.url, "about:agentblocked", "named without its query");
  const { browser } = await tabs.tabIn(agent, tab);
  await blockedPage(browser);

  const opened = await call("open_tab", { url: ORG_PAGE });
  Assert.equal(opened.status, 403, "open_tab answers the same");
  Assert.equal(alerts.opened, 0);
});

/** A redirect is a load of its own, and is checked as one. */
add_task(async function a_redirect_to_a_blocked_site_is_cancelled() {
  const { tabs, agent, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  await clickIn(browser, "#redirect");
  await refused(stops, browser, ROOT + "sval_agent_redirect.sjs");
  await blockedPage(browser);
});

/**
 * A new tab is watched before it loads anything, so a redirect its first
 * load takes is checked as well.
 */
add_task(async function a_new_tabs_first_redirect_is_checked() {
  const { tabs, agent, call } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const opened = await call("open_tab", {
    url: ROOT + "sval_agent_redirect.sjs?" + encodeURIComponent(ORG_PAGE),
  });
  Assert.equal(opened.status, 403, "the redirect to the blocked site");
  const { browser } = await tabs.tabIn(agent, opened.tab);
  await blockedPage(browser);
});

add_task(async function a_page_going_to_a_new_site_waits_for_allow() {
  const { tabs, agent, store, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, NET_PAGE);
  await clickIn(browser, "#new");
  const doc = await alertIn(win);
  Assert.equal(doc.querySelector(".sval-aa").dataset.kind, "site");
  Assert.ok(
    doc.getElementById("sval-aa-question").textContent.includes("example.net"),
    "the alert names the site"
  );
  // The alert is up, so the load is held: the page is still the one that
  // asked.
  Assert.equal(browser.currentURI.spec, LINKS, "the load waits");
  Assert.equal(await documentURL(browser), LINKS);
  await choose(doc, "allow");
  await within(loaded, 10_000, "the tab's load");
  Assert.equal(browser.currentURI.spec, NET_PAGE);
  Assert.equal(
    store.policyOf(agent.agentId).sites["example.net"],
    "ask-before-writes"
  );
});

add_task(async function a_page_going_to_a_new_site_is_stopped_by_deny() {
  const { tabs, agent, store, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  await clickIn(browser, "#new");
  await choose(await alertIn(win), "deny");
  await refused(stops, browser, NET_PAGE);
  await blockedPage(browser);
  Assert.equal(browser.currentURI.spec, NET_PAGE);
  Assert.equal(store.policyOf(agent.agentId).sites["example.net"], "blocked");
});

add_task(async function a_users_load_in_an_agent_tab_is_checked() {
  const { tabs, agent, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  loadPastLayer(browser, ORG_PAGE);
  await refused(stops, browser, ORG_PAGE);
  await blockedPage(browser);
});

add_task(async function a_load_after_the_call_returned_is_checked() {
  const { tabs, agent, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const shot = await call("get_snapshot", { tab });
  const late = shot.snapshot.match(/button "Blocked site later" \[(e\d+)\]/)[1];
  const clicked = await call("click_element", { tab, ref: late });
  Assert.equal(clicked.url, LINKS, "the click itself loaded nothing");
  const { browser } = await tabs.tabIn(agent, tab);
  await goOn(browser);
  await refused(stops, browser, ORG_PAGE);
  await blockedPage(browser);
});

/**
 * A tab showing a site the agent may no longer open cannot be read or acted
 * in, however it came to show it. It can still be navigated away or closed.
 */
add_task(async function tools_refuse_a_page_on_a_site_now_blocked() {
  const { agent, store, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  for (const [name, args] of [
    ["get_snapshot", { tab }],
    ["get_screenshot", { tab }],
    ["get_page_source", { tab }],
    ["get_page_text", { tab }],
    ["click_element", { tab, ref: "e1" }],
    ["type_text", { tab, ref: "e1", text: "x" }],
    ["fill_form", { tab, fields: [{ ref: "e1", text: "x" }] }],
    ["select_option", { tab, ref: "e1", values: ["a"] }],
    ["press_keys", { tab, keys: ["a"] }],
    ["scroll_page", { tab, direction: "down" }],
    ["wait_for_text", { tab, text: "Links", timeout_ms: 100 }],
  ]) {
    await Assert.rejects(
      call(name, args),
      e => e.code === "policy_denied" && e.message.includes("example.com"),
      `${name} is refused`
    );
  }
  const away = await call("navigate_tab", { tab, to: "about:blank" });
  Assert.equal(away.url, "about:blank");
  Assert.deepEqual(await call("close_tab", { tab }), { closed: tab });
});

/**
 * The back-forward cache puts a page back with no load for the gate to
 * check, so a change to the agent's site rules drops the pages its tabs
 * keep there: a back to a site blocked since is a load, and is refused.
 * The cache is read in the parent as the page is left and as the rules
 * change. Gecko drops every cached page on its own when memory runs low
 * (`nsSHistoryObserver::Observe`), so a back made to prove the page was
 * cached could find it gone for a reason of Gecko's.
 */
add_task(async function a_back_to_a_site_blocked_since_is_refused() {
  const { tabs, agent, store, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "full" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: ORG_PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await pageReady(browser, ORG_PAGE);
  // The page goes on itself. A load the parent starts, as `navigate_tab`'s
  // does (`CanonicalBrowsingContext::AttemptSpeculativeLoadInParent`), has
  // no channel id until the page's process claims it
  // (`DocumentLoadListener::ClaimParentLoad`), and that process reports the
  // load as a request in the old page's load group first
  // (`DocumentChannelChild::AsyncOpen`). A response that comes in between
  // keeps the old page out of the cache
  // (`CanonicalBrowsingContext::AllowedInBFCache`). A load the page starts
  // carries its channel id from its open.
  await SpecialPowers.spawn(browser, [LINKS], url =>
    content.location.assign(url)
  );
  await pageReady(browser, LINKS);
  const left = () => {
    const history = browser.browsingContext.sessionHistory;
    return history.getEntryAtIndex(history.index - 1);
  };
  Assert.equal(left().URI.spec, ORG_PAGE, "the page left is the one before");
  Assert.ok(left().isInBFCache, "the page left is cached");

  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  Assert.ok(!left().isInBFCache, "the rule change dropped the cached page");
  // The window's back is refused under the agent's overlay
  // (`SvalAgentMarking`), so the page goes back itself.
  await SpecialPowers.spawn(browser, [], () => content.history.back());
  await refused(stops, browser, ORG_PAGE);
  await blockedPage(browser);
});

/**
 * An input that waited its turn on its tab is judged as it goes: one the
 * user blocked the site for while it waited is refused, and the page never
 * gets it.
 */
add_task(async function an_input_that_waited_meets_the_site_as_it_is_now() {
  const { tabs, agent, store, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  // Each click counts, and starts a read that keeps the click's window
  // open, and its tab's next input waiting, until the test releases it.
  const slow = ROOT + "sval_agent_slow.sjs";
  const key = crypto.randomUUID();
  const started = requestsTo(new URL(slow).pathname);
  await SpecialPowers.spawn(browser, [slow, key], (url, held) => {
    const doc = content.document;
    doc.body.dataset.clicks = "0";
    const button = doc.getElementById("fetch");
    button.onclick = null;
    button.addEventListener("click", () => {
      doc.body.dataset.clicks = String(Number(doc.body.dataset.clicks) + 1);
      content.fetch(`${url}?hold=${held}`).catch(() => {});
    });
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Send by fetch" \[(e\d+)\]/)[1];
  const first = call("click_element", { tab, ref });
  await TestUtils.waitForCondition(() => started.started, "the read started");
  const sent = performance.now();
  const second = call("click_element", { tab, ref });
  second.catch(() => {});
  // The second click checks the page once its turn on the site comes, an
  // interval after the first's (Be polite); then it waits for the first
  // click's window.
  await timePassed(
    sent,
    2 * politeRules(agent.agentId).interval_ms,
    "the second click's turn comes"
  );
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  await fetch(`${slow}?release=${key}`);
  await first;
  await Assert.rejects(
    second,
    e => e.code === "policy_denied",
    "the click that waited is refused"
  );
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.body.dataset.clicks
    ),
    "1",
    "the page got the first click alone"
  );
});

/**
 * The user's own tabs are never governed by an agent's policy, whatever
 * agents are paired and working.
 */
add_task(async function a_users_own_tab_is_never_gated() {
  const { agent, store, gate, call } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  await call("open_tab", { url: LINKS });
  const alerts = countAlerts(window);
  const before = structuredClone(store.policyOf(agent.agentId));
  await BrowserTestUtils.withNewTab({ gBrowser, url: LINKS }, async browser => {
    Assert.equal(gate.agentOf(browser), null);
    // A tab and a window the user's page opens are the user's too.
    const watchers = [...Services.wm.getEnumerator("navigator:browser")].map(
      w => tabsOpenedIn(w)
    );
    await clickIn(browser, "#allowed-tab");
    let newTab;
    await TestUtils.waitForCondition(() => {
      newTab = watchers.flat()[0];
      return newTab;
    }, "a tab opens");
    Assert.equal(gate.agentOf(newTab), null, "its new tab is not gated");
    const popupWin = await newWindowAfter(() => clickIn(browser, "#popup"));
    await within(popupWin.SvalPanel.started, 10_000, "the panel's startup");
    Assert.equal(
      gate.agentOf(popupWin.gBrowser.selectedBrowser),
      null,
      "its popup is not gated"
    );
    Assert.notEqual(popupWin.SvalPanel.workspaceId, agent.workspaceId);
    BrowserTestUtils.removeTab(
      newTab.documentGlobal.gBrowser.getTabForBrowser(newTab)
    );

    const loaded = BrowserTestUtils.browserLoaded(browser, false, NET_PAGE);
    await clickIn(browser, "#new");
    await within(loaded, 10_000, "the tab's load");
    const blocked = BrowserTestUtils.browserLoaded(browser, false, ORG_PAGE);
    loadPastLayer(browser, ORG_PAGE);
    await within(blocked, 10_000, "the tab's load");
  });
  Assert.equal(alerts.opened, 0, "no agent alert");
  Assert.deepEqual(store.policyOf(agent.agentId), before, "policy unchanged");
});

/**
 * A page can move itself to a blob: address. The gate cannot tell that load
 * from a download of a file the page made until the response is in, so the
 * load goes ahead, and the page it shows is never the agent's: no tool reads
 * or acts in it, and no tab list names it.
 */
add_task(async function a_page_the_tab_turned_into_a_blob_is_not_read() {
  const { tabs, agent, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url =>
    url.startsWith("blob:")
  );
  await clickIn(browser, "#blob");
  await within(loaded, 10_000, "the tab's load");
  for (const name of [
    "get_snapshot",
    "get_page_source",
    "get_page_text",
    "click_element",
  ]) {
    await Assert.rejects(
      call(name, { tab, ref: "e1" }),
      e => e.code === "unsupported_url",
      `${name} refuses the blob: page`
    );
  }
  const listed = (await tabs.listTabsFor(agent)).find(t => t.tab === tab);
  Assert.deepEqual(
    [listed.title, listed.url],
    [null, null],
    "the tab list does not name it"
  );
});

/**
 * PDF.js shows a PDF under a principal of its own, resource://pdf.js, at the
 * PDF's address. The tab is the site the PDF came from.
 */
add_task(async function a_pdf_is_the_site_it_came_from() {
  const { call, store, agent, tabs, gate } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: ROOT + "sval_agent_doc.pdf" });
  const { browser } = await tabs.tabIn(agent, tab);
  let windowGlobal;
  await TestUtils.waitForCondition(() => {
    windowGlobal = browser.browsingContext.currentWindowGlobal;
    return (
      windowGlobal?.documentPrincipal.originNoSuffix === "resource://pdf.js"
    );
  }, "PDF.js shows the PDF");
  Assert.equal(windowGlobal.documentURI.spec, ROOT + "sval_agent_doc.pdf");
  Assert.strictEqual(gate.checkPage(agent, browser), true);
  const shot = await call("get_snapshot", { tab });
  Assert.equal(shot.tab, tab, "an allowed site's PDF can be read");

  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  await Assert.rejects(
    call("get_snapshot", { tab }),
    e => e.code === "policy_denied",
    "a blocked site's PDF cannot"
  );
});

/**
 * A network error page is docshell's report on an address the agent was
 * allowed to load, so the agent may read it as that address's site.
 */
add_task(async function an_error_page_reads_as_the_address_that_failed() {
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  server.init(-1, true, -1);
  server.asyncListen({
    onSocketAccepted(socket, transport) {
      transport.close(Cr.NS_OK);
    },
    onStopListening() {},
  });
  atTaskEnd(() => server.close());
  // eslint-disable-next-line sdl/no-insecure-url
  const url = `http://127.0.0.1:${server.port}/`;
  const { call, tabs, agent, gate } = await agentSetup({
    sites: { "example.com": "full", "127.0.0.1": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const errorPage = BrowserTestUtils.waitForErrorPage(browser);
  await Assert.rejects(
    call("navigate_tab", { tab, to: url }),
    e => e.code === "navigation_failed",
    "the load failed"
  );
  await within(errorPage, 10_000, "the error page");
  const windowGlobal = browser.browsingContext.currentWindowGlobal;
  const principal = windowGlobal.documentPrincipal;
  info(
    `error page: ${windowGlobal.documentURI.spec.split("?")[0]}, content ${principal.isContentPrincipal}, null ${principal.isNullPrincipal}, origin ${principal.origin}, precursor ${principal.precursorPrincipal?.origin}`
  );
  Assert.strictEqual(gate.checkPage(agent, browser), true, "it is readable");
  const { snapshot } = await call("get_snapshot", { tab });
  Assert.ok(snapshot.length, "and read");
});

/**
 * Only an error page docshell made for a failed load reads as that load's
 * site. A document at about:neterror with no failed load behind it names
 * whatever address its own URL says, so it is refused.
 */
add_task(async function a_crafted_error_page_is_not_read() {
  const { call, tabs, agent } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const crafted =
    "about:neterror?e=netReset&u=" +
    encodeURIComponent("https://example.com/") +
    "&d=a%20secret";

  // A page cannot point a frame at it: about:neterror is not linkable
  // (`nsAboutRedirector`), so the load is refused before any document.
  const linkRefused = new Promise(resolve => {
    const listener = {
      observe(message) {
        if (
          message.message?.includes("may not load or link to about:neterror")
        ) {
          Services.console.unregisterListener(listener);
          resolve();
        }
      },
    };
    Services.console.registerListener(listener);
  });
  await SpecialPowers.spawn(browser, [crafted], src => {
    const frame = content.document.createElement("iframe");
    frame.src = src;
    content.document.body.append(frame);
  });
  await linkRefused;
  Assert.ok(
    browser.browsingContext.children.every(
      c =>
        !c.currentWindowGlobal?.documentURI?.spec.startsWith("about:neterror")
    ),
    "no frame shows the crafted page"
  );

  // A page loaded at it, which only chrome can do.
  const { siteOfDocument } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs"
  );
  const loaded = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, crafted),
    10_000,
    "a new tab's load"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(loaded));
  const windowGlobal = loaded.linkedBrowser.browsingContext.currentWindowGlobal;
  Assert.equal(windowGlobal.documentURI.spec, crafted);
  Assert.throws(
    () => siteOfDocument(windowGlobal),
    e => e.code === "unsupported_url",
    "an error page with no failed load is refused"
  );
});
