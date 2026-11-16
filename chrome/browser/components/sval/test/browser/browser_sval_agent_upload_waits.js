/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_upload_helpers.js */

/**
 * An upload while the user decides (agent-control spec §4.4, §5.2): the
 * call waits for the answer and a retry joins its alert, the alert names
 * every file, the page's writes on `change` are gated, other input waits,
 * and the files are read and checked again only once the user allows.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_upload_helpers.js",
  this
);

/**
 * An upload whose call carries a progress token waits for the user's
 * answer, and Allow gives the files.
 */
add_task(async function a_waiting_upload_goes_ahead_when_the_user_allows() {
  const { callWithProgress, win, tab, browser, many } = await uploadSetup();
  const { paths } = await filesNamed("a.txt");
  const uploading = callWithProgress("upload_file", { tab, ref: many, paths });
  const flag = settledFlag(uploading.result);
  const doc = await alertIn(win);
  await TestUtils.waitForCondition(
    () => uploading.progress.length,
    "the call reports progress"
  );
  Assert.ok(!flag.settled, "and is still waiting");
  await choose(doc, "allow");
  Assert.deepEqual((await uploading.result).files, ["a.txt"]);
  Assert.deepEqual(await filesIn(browser, "many"), ["a.txt"]);
});

/**
 * A call that stops waiting, as one the agent cancels does, leaves its alert
 * up, and a retry joins it. An Allow given then is kept for the retry of the
 * same files.
 */
add_task(async function a_late_allow_is_kept_for_the_retry() {
  const { call, callWithProgress, win, alerts, tab, browser, many } =
    await uploadSetup();
  const { paths } = await filesNamed("a.txt");
  const first = callWithProgress("upload_file", { tab, ref: many, paths });
  const doc = await alertIn(win);
  await first.cancel();
  Assert.ok(win.gDialogBox.isOpen, "the alert stays up");
  const retry = callWithProgress("upload_file", { tab, ref: many, paths });
  await TestUtils.waitForCondition(
    () => retry.progress.length,
    "a retry waits"
  );
  Assert.equal(alerts.opened, 1, "on the same alert");
  await retry.cancel();
  await choose(doc, "allow");
  await TestUtils.waitForCondition(
    () => !win.gDialogBox.isOpen,
    "the alert closes"
  );
  Assert.deepEqual(
    (await call("upload_file", { tab, ref: many, paths })).files,
    ["a.txt"],
    "the next retry goes ahead"
  );
  Assert.equal(alerts.opened, 1, "unasked");
  Assert.deepEqual(await filesIn(browser, "many"), ["a.txt"]);
});

/**
 * The user is shown each file's full path, links followed, and the path is
 * checked again once the bytes are read: a link pointed elsewhere while the
 * user decides uploads nothing.
 */
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function a_link_pointed_elsewhere_meanwhile_uploads_nothing() {
    const { call, win, tab, browser, many } = await uploadSetup();
    const { dir, paths } = await filesNamed("first.txt", "second.txt");
    const link = PathUtils.join(dir, "link.txt");
    await symlink(paths[0], link);
    const uploading = call("upload_file", { tab, ref: many, paths: [link] });
    const doc = await alertIn(win);
    await IOUtils.remove(link);
    await symlink(paths[1], link);
    await choose(doc, "allow");
    await Assert.rejects(uploading, e => e.code === "bad_file");
    Assert.deepEqual(await filesIn(browser, "many"), [], "no file reached it");
  }
);

/**
 * One input at a time per tab: a click made while an upload's input is
 * still running waits for it, then finds the upload's writes unanswered
 * and is not performed. The upload's alert lists its own write alone.
 */
add_task(async function a_click_during_an_upload_waits_and_is_refused() {
  const { callWithProgress, raw, call, store, agent, win, tab, browser, many } =
    await uploadSetup({ sites: { "example.com": "ask-before-writes" } });
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    doc.body.dataset.clicks = "0";
    doc.getElementById("fetch").addEventListener("click", () => {
      doc.body.dataset.clicks = String(Number(doc.body.dataset.clicks) + 1);
    });
    doc.getElementById("many").addEventListener("change", () =>
      content.fetch("https://example.com/sval-upload-sent", {
        method: "POST",
        body: "files",
      })
    );
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const fetchRef = snapshot.match(/button "Send by fetch" \[(e\d+)\]/)[1];
  const { dir, paths } = await filesNamed("a.txt");
  await store.allowUploadFolders(agent.agentId, "example.com", [dir], false);
  const uploading = callWithProgress("upload_file", {
    tab,
    ref: many,
    paths,
  });
  await TestUtils.waitForCondition(
    () => eventsIn(browser).then(events => events.includes("many:change")),
    "the upload's input ran"
  );
  const clicked = await raw("click_element", { tab, ref: fetchRef });
  Assert.equal(
    JSON.parse(clicked.content[0].text).error,
    "awaiting_approval",
    "the click is refused"
  );
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.body.dataset.clicks
    ),
    "0",
    "and was not performed"
  );
  const doc = await alertIn(win);
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-upload-sent" }],
    "the alert lists the upload's write alone"
  );
  await choose(doc, "allow");
  Assert.equal((await uploading.result).writes, "allowed");
});

/** A page may send on `change`, so the upload is an input like a click. */
add_task(async function a_page_that_sends_on_change_is_gated() {
  const { call, win, store, agent, tab, browser, many } = await uploadSetup();
  await store.setSiteLevel(agent.agentId, "example.com", "ask-before-writes");
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("many").addEventListener("change", () =>
      content.fetch("https://example.com/sval-upload", {
        method: "POST",
        body: "file",
      })
    );
  });
  const { dir, paths } = await filesNamed("a.txt");
  await store.allowUploadFolders(agent.agentId, "example.com", [dir], false);
  const uploading = call("upload_file", { tab, ref: many, paths });
  const doc = await alertIn(win);
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-upload" }],
    "the write the change sent is held"
  );
  await choose(doc, "deny");
  Assert.equal((await uploading).writes, "denied");
});

/** The alert names every file Allow would send, the most a call takes. */
add_task(async function the_alert_names_every_file() {
  const { call, win, tab, many } = await uploadSetup();
  const names = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
  const { paths } = await filesNamed(...names);
  const uploading = call("upload_file", { tab, ref: many, paths });
  const doc = await alertIn(win);
  Assert.deepEqual(
    [...doc.querySelectorAll("#sval-aa-items li")].map(li => li.textContent),
    paths.map(resolved)
  );
  await choose(doc, "deny");
  await uploading.catch(() => {});
});

/**
 * The files are read only once the user has allowed the upload, so no
 * call waiting for the user holds their bytes: the page gets the file as it
 * is when the user answers.
 */
add_task(async function the_files_are_read_after_the_user_allows() {
  const { call, win, tab, browser, many } = await uploadSetup();
  const { paths } = await filesNamed("first.txt");
  const uploading = call("upload_file", { tab, ref: many, paths });
  const doc = await alertIn(win);
  await IOUtils.writeUTF8(paths[0], "written while the user decided");
  await choose(doc, "allow");
  Assert.deepEqual((await uploading).files, ["first.txt"]);
  Assert.deepEqual(
    await contentsIn(browser, "many"),
    ["written while the user decided"],
    "the page got the file as it was when the user answered"
  );
});

/**
 * The user is shown each file's full path, links followed, and the path is
 * checked again once the bytes are read: a link pointed elsewhere while the
 * user decides uploads nothing.
 */
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function a_link_pointed_elsewhere_meanwhile_uploads_nothing() {
    const { call, win, tab, browser, many } = await uploadSetup();
    const { dir, paths } = await filesNamed("first.txt", "second.txt");
    const link = PathUtils.join(dir, "link.txt");
    await symlink(paths[0], link);
    const uploading = call("upload_file", { tab, ref: many, paths: [link] });
    const doc = await alertIn(win);
    await IOUtils.remove(link);
    await symlink(paths[1], link);
    await choose(doc, "allow");
    await Assert.rejects(uploading, e => e.code === "bad_file");
    Assert.deepEqual(await filesIn(browser, "many"), [], "no file reached it");
  }
);

/**
 * The page's site can be blocked while the user decides: the upload is
 * checked again after Allow, and stops.
 */
add_task(async function a_site_blocked_while_the_user_decides_gets_nothing() {
  const { call, win, store, agent, tab, browser, many } = await uploadSetup();
  const { paths } = await filesNamed("a.txt");
  const uploading = call("upload_file", { tab, ref: many, paths });
  const doc = await alertIn(win);
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  await choose(doc, "allow");
  await Assert.rejects(
    uploading,
    e => e.code === "policy_denied",
    "the upload stops"
  );
  Assert.deepEqual(await filesIn(browser, "many"), [], "no file reached it");
  Assert.notEqual(
    store.policyOf(agent.agentId).uploads?.["example.com"],
    "allow",
    "a blocked site is not recorded as allowed"
  );
});

/**
 * The upload goes to the site the user was asked about, or nowhere: a tab
 * that moved to another site while the user decided gets nothing.
 */
add_task(async function a_tab_that_moved_on_meanwhile_gets_nothing() {
  const { call, win, store, agent, tab, browser, many } = await uploadSetup();
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  const { paths } = await filesNamed("a.txt");
  const uploading = call("upload_file", { tab, ref: many, paths });
  const doc = await alertIn(win);
  const elsewhere =
    ROOT.replace("https://example.com", "https://example.org") +
    "sval_agent_page.html";
  // The new page holds a file input under the same ref number.
  const loaded = BrowserTestUtils.browserLoaded(browser, false, elsewhere);
  loadPastLayer(browser, elsewhere);
  await within(loaded, 10_000, "the tab's load");
  await choose(doc, "allow");
  await Assert.rejects(
    uploading,
    e => e.code === "page_changed",
    "the upload stops with page_changed"
  );
  Assert.equal(
    await SpecialPowers.spawn(browser, [], () =>
      Array.from(content.document.querySelectorAll("input[type=file]")).reduce(
        (n, input) => n + input.files.length,
        0
      )
    ),
    0,
    "no file reached the new page"
  );
});
