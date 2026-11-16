/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What an agent's tools say a tab shows (agent-control spec §5.2): never a
 * page whose site the agent may not read now, and always the page whose
 * site was judged.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Resolves once a load of `url` has passed the agent gate and is about to
 * connect. The gate decides a load at `http-on-modify-request`, and holds an
 * agent tab's first load there until its window files it (`holdForFiling`),
 * so a load that has begun can still be refused for a site blocked while it
 * waits. `http-on-before-connect` follows once every observer of that topic
 * has let the channel go (`nsHttpChannel::ContinuePrepareToConnect`).
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
function passedGate(url) {
  const { promise, resolve } = Promise.withResolvers();
  const observer = {
    observe(subject) {
      if (subject.QueryInterface(Ci.nsIChannel).URI.spec === url) {
        Services.obs.removeObserver(observer, "http-on-before-connect");
        resolve();
      }
    },
  };
  Services.obs.addObserver(observer, "http-on-before-connect");
  atTaskEnd(() => {
    try {
      Services.obs.removeObserver(observer, "http-on-before-connect");
    } catch {}
  });
  return promise;
}

/**
 * What a tool says a tab shows names the page only while the agent may read
 * its site: a site the user blocked after its page loaded is not named in
 * the tab list, after an input, or after a navigation.
 */
add_task(async function a_page_the_agent_may_not_read_is_never_named() {
  const { tabs, agent, store, call } = await agentSetup({
    sites: { "example.com": "full", "example.org": "full" },
  });
  const secret = ORG_PAGE + "?token=secret";
  const { tab } = await call("open_tab", { url: secret });
  const listed = async () =>
    (await tabs.listTabsFor(agent)).find(t => t.tab === tab);
  await TestUtils.waitForCondition(
    async () => (await listed())?.url === secret,
    "the tab list names the page"
  );
  Assert.equal((await listed()).title, "Second page");

  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  const item = await listed();
  Assert.strictEqual(item.url, null, "the tab list hides the address");
  Assert.strictEqual(item.title, null, "and the title");
  await store.setSiteLevel(agent.agentId, "example.org", "full");

  // The list names what the tab shows now, never an address its node has
  // yet to catch up from.
  const { browser } = await tabs.tabIn(agent, tab);
  await call("navigate_tab", { tab, to: LINKS });
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  Assert.equal((await listed()).url, LINKS, "the tab list names the new page");

  // Back into the blocked page. Gecko restores it from the back-forward
  // cache, which opens no channel for the gate to refuse, or loads it again,
  // which the gate refuses with about:agentblocked
  // (`CanonicalBrowsingContext::AllowedInBFCache` decides which). Either
  // way the click's result never names the page.
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  const ref = await refFor(call, tab, /button "Back" \[(e\d+)\]/);
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  const clicked = await call("click_element", { tab, ref });
  Assert.equal(browser.currentURI.spec, secret, "the click went back");
  Assert.notEqual(clicked.url, secret, "the click's result has no address");
  Assert.notEqual(clicked.title, "Second page", "or title");

  // A navigation whose site is blocked while it loads.
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  const slow =
    ROOT.replace("://example.com/", "://example.org/") + "sval_agent_slow.sjs";
  let through = passedGate(slow);
  const navigated = call("navigate_tab", { tab, to: slow });
  await within(through, 10_000, "the slow page loading");
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  const result = await navigated;
  Assert.equal(browser.currentURI.spec, slow, "the slow page loaded");
  Assert.ok(!("url" in result), "the navigation's result has no address");
  Assert.ok(!("title" in result), "or title");

  // An open whose site is blocked while it loads.
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  through = passedGate(slow);
  const opening = call("open_tab", { url: slow });
  await within(through, 10_000, "the slow page opening");
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  const opened = await opening;
  Assert.ok(opened.tab, "the tab opened");
  Assert.strictEqual(opened.url, null, "the open's result has no address");
  Assert.strictEqual(opened.title, null, "or title");
});

/**
 * A blank page a site's page opened and wrote into is that site's content,
 * whatever its address says. Its title is never listed, and once the site is
 * blocked the tab is judged by the page's principal, as `checkPage` judges
 * it.
 */
add_task(async function a_blank_page_a_site_wrote_is_never_named() {
  const { tabs, agent, store, call, win } = await agentSetup({
    sites: { "example.org": "full" },
  });
  const orgLinks = LINKS.replace("://example.com/", "://example.org/");
  const { tab } = await call("open_tab", { url: orgLinks });
  const { browser } = await tabs.tabIn(agent, tab);
  await SpecialPowers.spawn(browser, [], () => {
    const button = content.document.createElement("button");
    button.textContent = "Write a blank page";
    button.setAttribute(
      "onclick",
      "const w = window.open(''); w.document.title = 'Secret title';"
    );
    content.document.body.prepend(button);
  });
  const opened = tabsOpenedIn(win);
  const ref = await refFor(call, tab, /button "Write a blank page" \[(e\d+)\]/);
  await call("click_element", { tab, ref });
  await TestUtils.waitForCondition(
    () => opened.length,
    "the page opened a tab"
  );
  const observer = win.SvalPanel.observer;
  let node;
  await TestUtils.waitForCondition(async () => {
    await within(observer.settled(), 10_000, "observer settling");
    const popupTab = win.gBrowser.getTabForBrowser(opened[0]);
    node = popupTab && observer.nodeIdFor(popupTab);
    return (
      node &&
      (await tabs.listTabs(agent.workspaceId)).some(
        t => t.tab === node && t.title === "Secret title"
      )
    );
  }, "the tree holds the written title");

  const listed = async () =>
    (await tabs.listTabsFor(agent)).find(t => t.tab === node);
  Assert.strictEqual((await listed()).title, null, "a blank page has no title");
  Assert.equal((await listed()).url, "about:blank");

  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  Assert.strictEqual((await listed()).title, null);
  Assert.strictEqual(
    (await listed()).url,
    null,
    "a blocked site's blank page is not named at all"
  );
});

/**
 * A browser's title and address are updated on schedules of their own, and
 * can still name the page before the one its document holds. What a tool
 * names comes from the one document it judged: the window global's address
 * and title, never the browser's.
 */
add_task(async function a_page_is_named_from_the_document_it_was_judged_by() {
  const { tabs, agent, store, call } = await agentSetup({
    sites: { "example.com": "full", "example.org": "full" },
  });
  const { tab } = await call("open_tab", { url: ORG_PAGE + "?token=secret" });
  const { browser } = await tabs.tabIn(agent, tab);
  await call("navigate_tab", { tab, to: PAGE });
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");

  // The browser still names the blocked page, as it can in the moment
  // after the navigation.
  const staleURI = Services.io.newURI(ORG_PAGE + "?token=secret");
  Object.defineProperty(browser, "contentTitle", {
    configurable: true,
    get: () => "Second page",
  });
  Object.defineProperty(browser, "currentURI", {
    configurable: true,
    get: () => staleURI,
  });
  atTaskEnd(() => {
    delete browser.contentTitle;
    delete browser.currentURI;
  });

  const listed = (await tabs.listTabsFor(agent)).find(t => t.tab === tab);
  Assert.equal(listed.url, PAGE, "the list names the judged document");
  Assert.equal(listed.title, "Agent test page");
  const shot = await call("get_snapshot", { tab });
  Assert.equal(shot.url, PAGE, "so does a tool's result");
  Assert.equal(shot.title, "Agent test page");
});
