/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * The download permission in an agent's tab (agent-control spec §5.2): asked
 * the first time a page on an undecided site starts one, kept per site, and
 * saved to the user's download folder with no dialog of any kind.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/** No unknownContentType or save-as window opens for an agent. */
function noDownloadDialogs() {
  const opened = [];
  const observer = (subject, topic) => {
    if (topic === "domwindowopened") {
      subject.addEventListener(
        "load",
        () => opened.push(subject.document.documentURI),
        { once: true }
      );
    }
  };
  Services.ww.registerNotification(observer);
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  let pickers = 0;
  MockFilePicker.showCallback = () => {
    pickers++;
  };
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  atTaskEnd(() => {
    Services.ww.unregisterNotification(observer);
    MockFilePicker.cleanup();
  });
  return () => {
    Assert.deepEqual(
      opened.filter(uri => !uri.startsWith("chrome://browser/content/browser")),
      [],
      "no download dialog opened"
    );
    Assert.equal(pickers, 0, "no save-as picker opened");
  };
}

add_task(async function the_first_download_waits_and_allow_saves_only_it() {
  const checkDialogs = noDownloadDialogs();
  const { call, win, alerts, store, agent, dir, browser } =
    await downloadsSetup();
  await pageRuns(browser, download("report.txt"));
  const doc = await alertIn(win);
  Assert.equal(doc.querySelector(".sval-aa").dataset.kind, "downloads");
  const question = doc.getElementById("sval-aa-question").textContent;
  Assert.ok(
    question.includes(AGENT_LABEL) && question.includes("example.com"),
    "the alert names the agent and the site"
  );
  Assert.equal(
    doc.activeElement?.dataset.choice,
    "deny",
    "Deny is the default"
  );
  await listedAs(call, "report.txt", "awaiting_approval");
  const final = PathUtils.join(dir, "report.txt");
  Assert.ok(
    !(await IOUtils.exists(final)),
    "nothing is at its path while it waits"
  );
  await choose(doc, "allow");
  const done = await listedAs(call, "report.txt", "done");
  Assert.equal(done.path, final);
  Assert.equal(done.bytes, "agent download body\n".length);
  Assert.equal(await IOUtils.readUTF8(final), "agent download body\n");
  Assert.ok(
    !("example.com" in store.policyOf(agent.agentId).downloads),
    "Allow is not saved for the site"
  );

  await pageRuns(browser, download("second.txt"));
  const again = await alertIn(win);
  Assert.equal(alerts.opened, 2, "the next download asks again");
  await choose(again, "deny");
  await listedAs(call, "second.txt", "denied");
  checkDialogs();
});

add_task(async function always_allow_saves_the_sites_later_downloads_unasked() {
  const { call, win, alerts, store, agent, browser } = await downloadsSetup();
  await pageRuns(browser, download("first.txt"));
  const doc = await alertIn(win);
  const buttons = [...doc.querySelectorAll("sval-dialog [data-choice]")];
  Assert.deepEqual(
    buttons.map(b => b.dataset.choice),
    ["allow", "allow_always", "deny_always", "deny"]
  );
  Assert.ok(
    buttons.slice(1, 3).every(b => b.textContent.includes("example.com")),
    "the always choices name the site"
  );
  await choose(doc, "allow_always");
  await listedAs(call, "first.txt", "done");
  Assert.equal(store.policyOf(agent.agentId).downloads["example.com"], "allow");
  await pageRuns(browser, download("second.txt"));
  await listedAs(call, "second.txt", "done");
  Assert.equal(alerts.opened, 1, "a later download from the site is unasked");
});

add_task(async function deny_cancels_it_and_always_deny_the_rest_unasked() {
  const { call, win, alerts, store, agent, dir, browser, list } =
    await downloadsSetup();
  await pageRuns(browser, download("no.txt"));
  await choose(await alertIn(win), "deny");
  await listedAs(call, "no.txt", "denied");
  Assert.ok(
    !("example.com" in store.policyOf(agent.agentId).downloads),
    "Deny is not saved for the site"
  );
  await pageRuns(browser, download("again.txt"));
  await choose(await alertIn(win), "deny_always");
  await listedAs(call, "again.txt", "denied");
  Assert.equal(store.policyOf(agent.agentId).downloads["example.com"], "deny");
  await pageRuns(browser, download("third.txt"));
  await listedAs(call, "third.txt", "denied");
  Assert.equal(alerts.opened, 2, "the third was refused unasked");
  // Firefox's own handler removes the file it was writing, on its saver's
  // thread, so it may outlast the refusal briefly. If anything stays, the
  // failure names it.
  let left = [];
  await TestUtils.waitForCondition(
    async () => {
      left = (await IOUtils.getChildren(dir)).map(p => PathUtils.filename(p));
      return !left.length;
    },
    "the download folder empties",
    250,
    120
  ).catch(() => {});
  Assert.deepEqual(left, [], "nothing is left in the download folder");
  Assert.ok(!(await list.getAll()).some(d => d.succeeded), "nothing was saved");
});

add_task(async function a_page_made_blob_follows_the_site_rule() {
  const { call, alerts, dir, browser } = await downloadsSetup({
    downloads: "allow",
  });
  await pageRuns(
    browser,
    `const a = document.createElement('a');
     a.href = URL.createObjectURL(new Blob(['made here'], {type: 'text/plain'}));
     a.download = 'made.txt';
     document.body.append(a);
     a.click();`
  );
  const done = await listedAs(call, "made.txt", "done");
  Assert.equal(done.path, PathUtils.join(dir, "made.txt"));
  Assert.equal(await IOUtils.readUTF8(done.path), "made here");
  await pageRuns(
    browser,
    `const a = document.createElement('a');
     a.href = 'data:text/plain,from%20data';
     a.download = 'data.txt';
     document.body.append(a);
     a.click();`
  );
  const data = await listedAs(call, "data.txt", "done");
  Assert.equal(await IOUtils.readUTF8(data.path), "from data");
  Assert.equal(alerts.opened, 0);
});

add_task(async function a_blocked_site_downloads_nothing() {
  const { call, alerts, store, agent, dir, browser } = await downloadsSetup({
    downloads: "allow",
  });
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  // A load of the site itself is refused before it starts (the site half of
  // the gate); a file the page makes is refused as a download.
  await pageRuns(
    browser,
    `const a = document.createElement('a');
     a.href = URL.createObjectURL(new Blob(['x'], {type: 'text/plain'}));
     a.download = 'blocked.txt';
     document.body.append(a);
     a.click();`
  );
  // The site is blocked, so the agent cannot see the download's name.
  await TestUtils.waitForCondition(async () => {
    const all = await agentDownloads(call);
    return (
      all.length === 1 && all[0].state === "denied" && all[0].file_name === null
    );
  }, "blocked.txt is denied, unnamed");
  Assert.equal(alerts.opened, 0);
  await TestUtils.waitForCondition(
    async () => !(await IOUtils.getChildren(dir)).length,
    "nothing is left in the download folder"
  );
});

add_task(async function a_file_firefox_would_open_is_only_saved() {
  const { call, win, browser, list } = await downloadsSetup({
    downloads: "allow",
  });
  const tabsBefore = gBrowser.tabs.length + win.gBrowser.tabs.length;
  await pageRuns(
    browser,
    `location.href = ${JSON.stringify(`${DOWNLOAD_SJS}?name=paper.pdf&pdf`)};`
  );
  const done = await listedAs(call, "paper.pdf", "done");
  Assert.ok(await IOUtils.exists(done.path));
  // Firefox opens a finished download only when `launchWhenSucceeded` is
  // set, which it decides as it makes the download (`DownloadLegacyTransfer`)
  // and acts on as it succeeds (`Download._succeed`).
  const saved = (await list.getAll()).find(d => d.target.path === done.path);
  Assert.ok(saved?.succeeded, "the download is Firefox's, and done");
  Assert.ok(!saved.launchWhenSucceeded, "Firefox does not open it");
  Assert.equal(
    gBrowser.tabs.length + win.gBrowser.tabs.length,
    tabsBefore,
    "no tab opened the saved file"
  );
});

add_task(async function the_users_own_downloads_are_never_listed() {
  const { call, list } = await downloadsSetup({ downloads: "allow" });
  const userTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a new tab's load"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(userTab));
  const panel = document.getElementById("downloadsPanel");
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  await pageRuns(userTab.linkedBrowser, download("mine.txt"));
  await within(shown, 10_000, "the user's download opening their panel");
  await TestUtils.waitForCondition(
    async () => (await list.getAll()).some(d => d.succeeded),
    "the user's download finished"
  );
  Assert.deepEqual(await agentDownloads(call), [], "the agent sees none of it");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await within(hidden, 10_000, "the user closing their panel");
});

/** A site blocked while the user decides downloads nothing, whatever the answer. */
add_task(
  async function a_site_blocked_while_the_user_decides_downloads_nothing() {
    const { call, win, store, agent, dir, browser } = await downloadsSetup();
    await pageRuns(browser, download("late.txt"));
    const doc = await alertIn(win);
    await store.setSiteLevel(agent.agentId, "example.com", "blocked");
    await choose(doc, "allow");
    await TestUtils.waitForCondition(async () => {
      const all = await agentDownloads(call);
      return (
        all.length === 1 &&
        all[0].state === "denied" &&
        all[0].file_name === null
      );
    }, "late.txt is denied, unnamed");
    Assert.notEqual(
      store.policyOf(agent.agentId).downloads?.["example.com"],
      "allow",
      "the blocked site is not recorded as allowed"
    );
    await TestUtils.waitForCondition(
      async () => !(await IOUtils.getChildren(dir)).length,
      "nothing is left in the download folder"
    );
  }
);

/** Switching agent access off cancels a download that waits for the user. */
add_task(async function access_off_cancels_a_held_download() {
  const { call, win, dir, browser, list } = await downloadsSetup();
  await pageRuns(browser, download("held.txt"));
  await alertIn(win);
  await listedAs(call, "held.txt", "awaiting_approval");
  await agentAccessOff();
  await TestUtils.waitForCondition(
    async () => !(await IOUtils.getChildren(dir)).length,
    "nothing is left in the download folder"
  );
  Assert.ok(
    !(await list.getAll()).some(d => d.succeeded || !d.stopped),
    "nothing was saved, and nothing runs on"
  );
});

/**
 * `list_downloads` names a download only while the agent may read the site
 * it came from.
 */
add_task(async function a_download_from_a_site_now_blocked_is_not_named() {
  const { call, store, agent, browser } = await downloadsSetup({
    downloads: "allow",
  });
  await pageRuns(browser, download("named.txt"));
  const done = await listedAs(call, "named.txt", "done");
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  const [entry] = await agentDownloads(call);
  Assert.deepEqual(
    entry,
    { file_name: null, path: null, state: "done", bytes: done.bytes },
    "its name and path are withheld, its state and size kept"
  );
});
