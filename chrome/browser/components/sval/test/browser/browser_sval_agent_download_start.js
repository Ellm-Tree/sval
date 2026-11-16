/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * An agent's download is decided by the site of the page that started it
 * (agent-control spec §5.2), through frames, redirects and a tab that moves
 * on.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * A download is decided by the site of the page that started it, even if
 * the tab moves on before the download reaches its transfer.
 */
add_task(async function a_download_is_decided_by_where_it_started() {
  const { call, store, agent, browser } = await downloadsSetup({
    downloads: "allow",
  });
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  await store.setFilePermission(
    agent.agentId,
    "downloads",
    "example.org",
    "deny"
  );
  const preferred = Downloads.getPreferredDownloadsDirectory;
  const released = Promise.withResolvers();
  let asked = false;
  Downloads.getPreferredDownloadsDirectory = async (...args) => {
    asked = true;
    await released.promise;
    return preferred.apply(Downloads, args);
  };
  atTaskEnd(() => (Downloads.getPreferredDownloadsDirectory = preferred));
  await pageRuns(browser, download("started.txt"));
  await TestUtils.waitForCondition(() => asked, "the download started");
  const loaded = BrowserTestUtils.browserLoaded(browser, false, ORG_PAGE);
  loadPastLayer(browser, ORG_PAGE);
  await within(loaded, 10_000, "the tab's load");
  released.resolve();
  await listedAs(call, "started.txt", "done");
});

/**
 * Puts a frame of `framePage` in the agent's page.
 *
 * @param {object} browser
 * @param {string} framePage
 * @returns {Promise<BrowsingContext>} The frame.
 */
async function frameOf(browser, framePage) {
  const frame = await SpecialPowers.spawn(browser, [framePage], async src => {
    const iframe = content.document.createElement("iframe");
    const loaded = new Promise(resolve =>
      iframe.addEventListener("load", resolve, { once: true })
    );
    iframe.src = src;
    content.document.body.append(iframe);
    await loaded;
    return iframe.browsingContext;
  });
  return frame;
}

/**
 * Clicks a link to `url` in `frame` that loads in the whole tab, with the
 * frame's page holding the user's activation such a load needs.
 *
 * @param {BrowsingContext} frame
 * @param {string} url
 */
async function clickTopLinkIn(frame, url) {
  await SpecialPowers.spawn(frame, [url], href => {
    const a = content.document.createElement("a");
    a.href = href;
    a.target = "_top";
    content.document.body.append(a);
    SpecialPowers.wrap(content.document).notifyUserGestureActivation();
    a.click();
  });
}

/**
 * A download another site starts from inside an allowed site's tab is that
 * site's: a frame of a site whose downloads are denied downloads nothing,
 * whatever the page around it may.
 */
add_task(async function a_frame_of_a_denied_site_downloads_nothing() {
  const { call, store, agent, dir, browser, list, alerts } =
    await downloadsSetup({ downloads: "allow" });
  await store.setFilePermission(
    agent.agentId,
    "downloads",
    "example.org",
    "deny"
  );
  const frameDownload = `${DOWNLOAD_SJS.replace(
    "://example.com/",
    "://example.org/"
  )}?name=framed.txt`;
  const frame = await frameOf(browser, ORG_PAGE);
  // Clicked in the frame, the link's load is triggered by the frame's page.
  await SpecialPowers.spawn(frame, [frameDownload], url => {
    const a = content.document.createElement("a");
    a.href = url;
    content.document.body.append(a);
    a.click();
  });
  await TestUtils.waitForCondition(
    async () => (await agentDownloads(call)).some(d => d.state === "denied"),
    "the frame's download is denied"
  );
  Assert.equal(alerts.opened, 0, "the denied site is not asked about");
  await TestUtils.waitForCondition(
    async () => !(await IOUtils.getChildren(dir)).length,
    "nothing is left in the download folder"
  );
  Assert.ok(!(await list.getAll()).some(d => d.succeeded), "nothing was saved");
});

/**
 * A redirect moves a download's address, not who started it: a page of a
 * site whose downloads are denied, framed in an allowed page, starts a
 * download in the whole tab through another site's redirect, and it is
 * refused.
 */
add_task(
  async function a_denied_pages_download_through_a_redirect_is_refused() {
    const { call, store, agent, dir, browser, list, alerts } =
      await downloadsSetup({ downloads: "allow" });
    await store.setFilePermission(
      agent.agentId,
      "downloads",
      "example.org",
      "deny"
    );
    const file = `${DOWNLOAD_SJS}?name=redirected.txt`;
    const frame = await frameOf(
      browser,
      PAGE2.replace("://example.com/", "://example.org/")
    );
    await clickTopLinkIn(
      frame,
      `${ROOT}sval_agent_redirect.sjs?${encodeURIComponent(file)}`
    );
    await TestUtils.waitForCondition(
      async () => (await agentDownloads(call)).some(d => d.state === "denied"),
      "the redirected download is denied"
    );
    Assert.equal(alerts.opened, 0, "the denied site is not asked about");
    await TestUtils.waitForCondition(
      async () => !(await IOUtils.getChildren(dir)).length,
      "nothing is left in the download folder"
    );
    Assert.ok(
      !(await list.getAll()).some(d => d.succeeded),
      "nothing was saved"
    );
  }
);

/** An allowed page's download saves unasked, through any redirect. */
add_task(async function an_allowed_pages_download_through_a_redirect_saves() {
  const { call, store, agent, browser, alerts } = await downloadsSetup({
    downloads: "allow",
  });
  // The redirect is a load of example.org's in the tab, which the agent may
  // open; only its downloads are denied.
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  await store.setFilePermission(
    agent.agentId,
    "downloads",
    "example.org",
    "deny"
  );
  const file = `${DOWNLOAD_SJS.replace(
    "://example.com/",
    "://example.org/"
  )}?name=onward.txt`;
  await pageRuns(
    browser,
    `location.href = ${JSON.stringify(
      `${ROOT}sval_agent_redirect.sjs?${encodeURIComponent(file)}`
    )};`
  );
  const done = await listedAs(call, "onward.txt", "done");
  Assert.equal(await IOUtils.readUTF8(done.path), "agent download body\n");
  Assert.equal(alerts.opened, 0, "it was not asked about");
});

/**
 * A page's own fetch through a redirect is no document load, and moves
 * nothing the gate knows about where the page's next download starts: the
 * download is the page's, and its allowed site saves it unasked.
 */
add_task(async function a_fetch_redirect_does_not_move_a_downloads_start() {
  const { call, store, agent, browser, alerts } = await downloadsSetup({
    downloads: "allow",
  });
  await store.setFilePermission(
    agent.agentId,
    "downloads",
    "example.org",
    "deny"
  );
  const elsewhere = `${DOWNLOAD_SJS.replace(
    "://example.com/",
    "://example.org/"
  )}?name=fetched.txt`;
  await SpecialPowers.spawn(
    browser,
    [`${ROOT}sval_agent_redirect.sjs?${encodeURIComponent(elsewhere)}`],
    async url => {
      await content.fetch(url, { mode: "no-cors" });
    }
  );
  await pageRuns(browser, download("after.txt"));
  await listedAs(call, "after.txt", "done");
  Assert.equal(alerts.opened, 0, "it was not asked about");
  Assert.ok(
    !(await agentDownloads(call)).some(d => d.file_name === "fetched.txt"),
    "and the fetch was no download"
  );
});

/**
 * A download whose starting page Sval cannot establish is asked about even on
 * a site whose downloads were allowed: an agent's own load of a file Firefox
 * opens itself names no page that started it.
 */
add_task(async function a_download_with_no_known_start_asks() {
  const { call, win, tab } = await downloadsSetup({ downloads: "allow" });
  const navigating = call("navigate_tab", {
    tab,
    to: `${DOWNLOAD_SJS}?name=unknown.pdf&pdf`,
  });
  const doc = await alertIn(win);
  Assert.equal(doc.querySelector(".sval-aa").dataset.kind, "downloads");
  Assert.ok(
    doc.getElementById("sval-aa-question").textContent.includes("example.com"),
    "it names the site sval has"
  );
  await choose(doc, "allow");
  await navigating.catch(() => {});
  await listedAs(call, "unknown.pdf", "done");
});
