/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_upload_helpers.js */

/**
 * What a user's answer to an upload grants (agent-control spec §4.4,
 * §5.2): Allow sends the files its alert listed, "Always allow" lets the
 * files of the folders it named go to the site unasked, at the scope chosen,
 * and Deny or a blocked site sends nothing.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_upload_helpers.js",
  this
);

add_task(async function allow_gives_this_calls_files_and_always_their_folder() {
  const { call, win, alerts, store, agent, tab, browser, many } =
    await uploadSetup();
  const { dir, paths } = await filesNamed("a.txt", "b.txt", "c.txt");
  const uploading = call("upload_file", {
    tab,
    ref: many,
    paths: paths.slice(0, 2),
  });
  const doc = await alertIn(win);
  Assert.equal(doc.querySelector(".sval-aa").dataset.kind, "uploads");
  const question = doc.getElementById("sval-aa-question").textContent;
  Assert.ok(
    question.includes(AGENT_LABEL) && question.includes("example.com"),
    "the alert names the agent and the site"
  );
  Assert.ok(
    doc.getElementById("sval-aa-detail").textContent.includes(resolved(dir)),
    "the alert names the folder Always allow grants"
  );
  Assert.deepEqual(
    [...doc.querySelectorAll("#sval-aa-items li")].map(li => li.textContent),
    paths.slice(0, 2).map(resolved),
    "it lists the full path of each file of this call"
  );
  Assert.equal(
    doc.activeElement?.dataset.choice,
    "deny",
    "Deny is the default"
  );
  Assert.deepEqual(
    [...doc.querySelectorAll("#sval-aa-options input")].map(
      radio => `${radio.value}:${radio.checked}`
    ),
    ["folder:true", "subfolders:false"],
    "Always allow covers the folder alone unless the user chooses more"
  );
  await choose(doc, "allow");
  const result = await uploading;
  Assert.equal(result.tab, tab);
  Assert.deepEqual(result.files, ["a.txt", "b.txt"]);
  Assert.equal(result.writes, "none");
  Assert.deepEqual(await filesIn(browser, "many"), ["a.txt", "b.txt"]);
  Assert.equal(
    await eventsIn(browser),
    "many:input many:change",
    "the page saw input, then change"
  );
  Assert.ok(
    !("example.com" in store.policyOf(agent.agentId).uploads),
    "Allow is not saved for the site"
  );

  const asking = call("upload_file", { tab, ref: many, paths: [paths[2]] });
  const next = await alertIn(win);
  Assert.equal(alerts.opened, 2, "the next upload asks again");
  await choose(next, "allow_always");
  Assert.deepEqual((await asking).files, ["c.txt"]);
  Assert.deepEqual(store.policyOf(agent.agentId).uploads["example.com"], {
    folders: [{ path: resolved(dir), subfolders: false }],
  });

  const again = await call("upload_file", {
    tab,
    ref: many,
    paths: [paths[0]],
  });
  Assert.deepEqual(
    again.files,
    ["a.txt"],
    "a later upload from that folder goes ahead"
  );
  Assert.equal(alerts.opened, 2, "unasked");
  Assert.deepEqual(await filesIn(browser, "many"), ["a.txt"]);
});

/**
 * "Always allow" covers the folders of the files the user saw: a file from
 * another folder, alone or among allowed ones, is asked about, and a second
 * "Always allow" adds its folder.
 */
add_task(async function always_allow_covers_only_the_folders_it_named() {
  const { call, win, alerts, store, agent, tab, browser, many } =
    await uploadSetup();
  const a = await filesNamed("in-a.txt");
  const b = await filesNamed("in-b.txt");
  const first = call("upload_file", { tab, ref: many, paths: a.paths });
  await choose(await alertIn(win), "allow_always");
  Assert.deepEqual((await first).files, ["in-a.txt"]);

  const fromB = call("upload_file", {
    tab,
    ref: many,
    paths: [a.paths[0], b.paths[0]],
  });
  const doc = await alertIn(win);
  Assert.equal(alerts.opened, 2, "a file in another folder asks");
  Assert.deepEqual(
    [...doc.querySelectorAll("#sval-aa-items li")].map(li => li.textContent),
    [resolved(a.paths[0]), resolved(b.paths[0])],
    "naming every file the call sends"
  );
  const detail = doc.getElementById("sval-aa-detail").textContent;
  Assert.ok(
    detail.includes(resolved(b.dir)) && !detail.includes(resolved(a.dir)),
    "and only the folder no grant covers"
  );
  await choose(doc, "allow_always");
  Assert.deepEqual((await fromB).files, ["in-a.txt", "in-b.txt"]);
  Assert.deepEqual(store.policyOf(agent.agentId).uploads["example.com"], {
    folders: [
      { path: resolved(a.dir), subfolders: false },
      { path: resolved(b.dir), subfolders: false },
    ],
  });
  await call("upload_file", { tab, ref: many, paths: b.paths });
  Assert.equal(alerts.opened, 2, "and then goes unasked");
  Assert.deepEqual(await filesIn(browser, "many"), ["in-b.txt"]);
});

/**
 * "This folder only" leaves the folders inside it asking; "This folder and
 * the folders inside it" covers them (decision 0129).
 */
add_task(async function the_scope_says_whether_folders_inside_are_covered() {
  const { call, win, alerts, store, agent, tab, many } = await uploadSetup();
  const { dir, paths } = await filesNamed("top.txt");
  const inner = PathUtils.join(dir, "inner");
  await IOUtils.makeDirectory(inner);
  const deep = PathUtils.join(inner, "deep.txt");
  await IOUtils.writeUTF8(deep, "deep");

  const first = call("upload_file", { tab, ref: many, paths });
  await choose(await alertIn(win), "allow_always");
  await first;
  const fromInner = call("upload_file", { tab, ref: many, paths: [deep] });
  const doc = await alertIn(win);
  Assert.equal(alerts.opened, 2, "a folder inside it asks");
  doc.querySelector('#sval-aa-options input[value="subfolders"]').click();
  await choose(doc, "allow_always");
  Assert.deepEqual((await fromInner).files, ["deep.txt"]);
  Assert.deepEqual(store.policyOf(agent.agentId).uploads["example.com"], {
    folders: [
      { path: resolved(dir), subfolders: false },
      { path: resolved(inner), subfolders: true },
    ],
  });

  await store.allowUploadFolders(
    agent.agentId,
    "example.com",
    [resolved(dir)],
    true
  );
  const deeper = PathUtils.join(inner, "more");
  await IOUtils.makeDirectory(deeper);
  const deepest = PathUtils.join(deeper, "deepest.txt");
  await IOUtils.writeUTF8(deepest, "deepest");
  await call("upload_file", { tab, ref: many, paths: [deepest] });
  Assert.equal(alerts.opened, 2, "and once chosen, they go unasked");
});

/**
 * A folder grant never covers a hidden file, or a file in a hidden folder
 * inside it, where the home folder keeps keys and tokens: each asks, while
 * a visible file beside them goes unasked.
 */
add_task(async function a_hidden_file_in_an_allowed_folder_asks() {
  const { call, win, alerts, store, agent, tab, browser, many } =
    await uploadSetup();
  const { dir, paths } = await filesNamed("visible.txt", ".netrc");
  const hiddenDir = PathUtils.join(dir, ".ssh");
  await IOUtils.makeDirectory(hiddenDir);
  const key = PathUtils.join(hiddenDir, "id_rsa");
  await IOUtils.writeUTF8(key, "key");
  const asks = async (what, path) => {
    const opened = alerts.opened;
    const asking = call("upload_file", { tab, ref: many, paths: [path] });
    const doc = await alertIn(win);
    Assert.equal(alerts.opened, opened + 1, `${what} asks`);
    Assert.deepEqual(
      [...doc.querySelectorAll("#sval-aa-items li")].map(li => li.textContent),
      [resolved(path)],
      `the alert names ${what}`
    );
    await choose(doc, "deny");
    await Assert.rejects(asking, e => e.code === "policy_denied");
  };

  await store.allowUploadFolders(
    agent.agentId,
    "example.com",
    [resolved(dir)],
    false
  );
  Assert.deepEqual(
    (await call("upload_file", { tab, ref: many, paths: [paths[0]] })).files,
    ["visible.txt"],
    "a visible file in the folder goes unasked"
  );
  Assert.equal(alerts.opened, 0);
  await asks("a hidden file in the folder", paths[1]);

  await store.allowUploadFolders(
    agent.agentId,
    "example.com",
    [resolved(dir)],
    true
  );
  await asks("a file in a hidden folder inside it", key);
  Assert.deepEqual(
    await filesIn(browser, "many"),
    ["visible.txt"],
    "no hidden file reached the page"
  );
});

/**
 * On Windows an 8.3 short name such as `GIT-CR~1` names a dotfile without
 * its dot, so a name of that form asks. A file whose own name has that form
 * stands in for the short name, which a volume need not generate.
 */
add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function a_short_name_in_an_allowed_folder_asks() {
    const { call, win, alerts, store, agent, tab, browser, many } =
      await uploadSetup();
    const { dir, paths } = await filesNamed("GIT-CR~1");
    await store.allowUploadFolders(agent.agentId, "example.com", [dir], false);
    const asking = call("upload_file", { tab, ref: many, paths });
    const doc = await alertIn(win);
    Assert.equal(alerts.opened, 1, "a short name asks");
    await choose(doc, "deny");
    await Assert.rejects(asking, e => e.code === "policy_denied");
    Assert.deepEqual(await filesIn(browser, "many"), []);
  }
);

/**
 * An Allow covers the files its alert listed: another call's files, sent
 * while that alert is up, are asked about in an alert of their own.
 */
add_task(async function allow_covers_only_the_files_it_listed() {
  const { call, win, alerts, tab, browser, many } = await uploadSetup();
  const { paths } = await filesNamed("shown.txt", "other.txt");
  const first = call("upload_file", { tab, ref: many, paths: [paths[0]] });
  const doc = await alertIn(win);
  const second = call("upload_file", { tab, ref: many, paths: [paths[1]] });
  await choose(doc, "allow");
  Assert.deepEqual((await first).files, ["shown.txt"]);
  await TestUtils.waitForCondition(
    () => alerts.opened === 2,
    "the other files are asked about"
  );
  const next = await alertIn(win);
  Assert.deepEqual(
    [...next.querySelectorAll("#sval-aa-items li")].map(li => li.textContent),
    [resolved(paths[1])]
  );
  await choose(next, "deny");
  await Assert.rejects(second, e => e.code === "policy_denied");
  Assert.deepEqual(await filesIn(browser, "many"), ["shown.txt"]);
});

add_task(async function deny_refuses_this_call_and_always_deny_the_site() {
  const { call, win, alerts, store, agent, tab, browser, many } =
    await uploadSetup();
  const { paths } = await filesNamed("secret.txt");
  const uploading = call("upload_file", { tab, ref: many, paths });
  await choose(await alertIn(win), "deny");
  await Assert.rejects(
    uploading,
    e => e.code === "policy_denied",
    "the upload is refused"
  );
  Assert.ok(!("example.com" in store.policyOf(agent.agentId).uploads));
  const asking = call("upload_file", { tab, ref: many, paths });
  await choose(await alertIn(win), "deny_always");
  await Assert.rejects(asking, e => e.code === "policy_denied");
  Assert.equal(store.policyOf(agent.agentId).uploads["example.com"], "deny");
  await Assert.rejects(
    call("upload_file", { tab, ref: many, paths }),
    e => e.code === "policy_denied",
    "and so is the next, unasked"
  );
  Assert.equal(alerts.opened, 2);
  Assert.deepEqual(await filesIn(browser, "many"), [], "no file reached it");
});

add_task(async function a_blocked_site_uploads_nothing() {
  const { call, store, agent, alerts, tab, many } = await uploadSetup();
  const { dir, paths } = await filesNamed("a.txt");
  await store.allowUploadFolders(agent.agentId, "example.com", [dir], false);
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  await Assert.rejects(
    call("upload_file", { tab, ref: many, paths }),
    e => e.code === "policy_denied"
  );
  Assert.equal(alerts.opened, 0);
});
