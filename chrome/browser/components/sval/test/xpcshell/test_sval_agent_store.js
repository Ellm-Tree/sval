/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalAgentStore, DEFAULT_POLICY } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentStore.sys.mjs"
);

const { writePrivateJSON } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPrivateFile.sys.mjs"
);

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const { isPolite, setPolite } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs"
);

do_get_profile();

function flipLast(hex) {
  return hex.slice(0, -1) + (hex.at(-1) === "0" ? "1" : "0");
}

function freshPath(tag) {
  return PathUtils.join(
    PathUtils.profileDir,
    `agents-${tag}-${Date.now()}.json`
  );
}

/**
 * The files beside `path` whose names start with its own, but for itself.
 *
 * @param {string} path
 * @returns {Promise<string[]>}
 */
async function temporariesOf(path) {
  const children = await IOUtils.getChildren(PathUtils.parent(path));
  return children.filter(child => child !== path && child.startsWith(path));
}

add_task(async function a_paired_agent_verifies_with_its_secret_only() {
  const store = await SvalAgentStore.open(freshPath("verify"));
  const { agentId, secret } = await store.pair({
    label: "Claude Code",
    workspaceId: "ws-1",
  });
  Assert.ok(/^[0-9a-f]{64}$/.test(secret), "256 bits as hex");

  const ok = await store.verify(agentId, secret);
  Assert.deepEqual(ok, { agentId, label: "Claude Code", isolated: false });
  Assert.equal(
    await store.verify(agentId, flipLast(secret)),
    null,
    "one changed character fails"
  );
  Assert.equal(await store.verify("no-such-agent", secret), null);
  // An id that only reads as the agent's as a string would hold a session
  // that Unpair, comparing ids, never finds to close.
  for (const [id, given] of [
    [[agentId], secret],
    [{ toString: () => agentId }, secret],
    [agentId, [secret]],
  ]) {
    Assert.equal(
      await store.verify(id, given),
      null,
      "only strings are an id and a secret"
    );
  }
});

/** The file holds a hash. A copy of the profile must not hand out the secret. */
add_task(async function the_file_never_holds_the_secret() {
  const path = freshPath("hash");
  const store = await SvalAgentStore.open(path);
  const { agentId, secret } = await store.pair({
    label: "A",
    workspaceId: "ws",
  });
  const text = await IOUtils.readUTF8(path);
  Assert.ok(!text.includes(secret), "secret absent from disk");
  const json = JSON.parse(text);
  Assert.equal(json.version, 1);
  Assert.ok(/^[0-9a-f]{64}$/.test(json.agents[agentId].secretHash));
  Assert.deepEqual(json.agents[agentId].policy, DEFAULT_POLICY);
});

add_task(async function a_reopened_store_still_verifies() {
  const path = freshPath("reopen");
  const { agentId, secret } = await (
    await SvalAgentStore.open(path)
  ).pair({ label: "A", workspaceId: "ws" });
  const again = await SvalAgentStore.open(path);
  Assert.ok(await again.verify(agentId, secret));
});

/**
 * An agent is its app: its client and the kind of workspace the user chose
 * for it are kept with it, and each workspace one of its sessions made is
 * kept with what that session said of itself (decision 1998).
 */
add_task(async function an_agent_keeps_each_sessions_workspace() {
  const path = freshPath("launch");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({
    label: "Claude Code",
    client: "Claude Code",
    isolated: true,
    workspaceId: "ws-1",
    task: "Fix login redirect",
    model: "Opus 5.5",
    dir: "/work/sval",
    started: 1_700_000_000_000,
    lastUsed: 1_700_000_100_000,
  });
  await store.addWorkspace(agentId, "ws-2", {
    task: "Compare laptop prices",
    dir: "/home/someone",
  });
  await store.touchWorkspace(agentId, "ws-2", 1_700_000_200_000);
  const { agentId: bare } = await store.pair({ label: "A" });
  const listed = (await SvalAgentStore.open(path)).agents();
  Assert.deepEqual(
    listed.find(a => a.agentId === agentId),
    {
      agentId,
      label: "Claude Code",
      client: "Claude Code",
      isolated: true,
      workspaces: [
        {
          workspaceId: "ws-1",
          task: "Fix login redirect",
          model: "Opus 5.5",
          dir: "/work/sval",
          started: 1_700_000_000_000,
          lastUsed: 1_700_000_100_000,
        },
        {
          workspaceId: "ws-2",
          task: "Compare laptop prices",
          model: "",
          dir: "/home/someone",
          started: null,
          lastUsed: 1_700_000_200_000,
        },
      ],
    }
  );
  Assert.deepEqual(
    listed.find(a => a.agentId === bare),
    { agentId: bare, label: "A", client: "", isolated: false, workspaces: [] }
  );
  Assert.deepEqual(store.workspaceOf(agentId, "ws-2"), {
    task: "Compare laptop prices",
    model: "",
    dir: "/home/someone",
    started: null,
    lastUsed: 1_700_000_200_000,
  });
  Assert.equal(store.workspaceOf(bare, "ws-2"), null, "only its own agent's");
  for (const id of ["ws-1", "ws-2"]) {
    Assert.deepEqual(
      store.agentOfWorkspace(id),
      { agentId, label: "Claude Code" },
      `${id} is the agent's`
    );
  }
  Assert.equal(store.agentOfWorkspace("ws-users"), null, "no agent's");
});

/** A session's new task names its own workspace and no other. */
add_task(async function a_new_task_is_kept_with_its_workspace() {
  const path = freshPath("task");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({
    label: "Claude Code",
    task: "First job",
    workspaceId: "ws",
  });
  await store.addWorkspace(agentId, "ws-other", { task: "Other job" });
  await store.setTask(agentId, "ws", "Second job");
  const [agent] = (await SvalAgentStore.open(path)).agents();
  Assert.deepEqual(
    agent.workspaces.map(w => w.task),
    ["Second job", "Other job"]
  );
});

/** Deleting one of an agent's workspaces leaves the agent paired. */
add_task(async function a_deleted_workspace_leaves_its_agent_paired() {
  const store = await SvalAgentStore.open(freshPath("deleted"));
  const { agentId, secret } = await store.pair({
    label: "A",
    workspaceId: "ws",
  });
  await store.addWorkspace(agentId, "ws-2", { task: "Two" });
  await store.workspaceDeleted("ws");
  Assert.ok(await store.verify(agentId, secret), "still paired");
  Assert.deepEqual(
    store.agents()[0].workspaces.map(w => w.workspaceId),
    ["ws-2"]
  );
  Assert.equal(store.workspaceOf(agentId, "ws"), null);
});

add_task(async function unpairing_forgets_the_agent() {
  const path = freshPath("unpair");
  const store = await SvalAgentStore.open(path);
  const { agentId, secret } = await store.pair({
    label: "A",
    workspaceId: "ws",
  });
  Assert.ok(await store.unpair(agentId));
  Assert.equal(await store.verify(agentId, secret), null);
  Assert.ok(
    !(await store.unpair(agentId)),
    "a second unpair reports nothing to do"
  );
  Assert.deepEqual((await SvalAgentStore.open(path)).agents(), []);
});

/** An id like "__proto__" or "constructor" must not resolve to a prototype member. */
add_task(async function prototype_names_are_not_agents() {
  const store = await SvalAgentStore.open(freshPath("proto"));
  for (const id of ["__proto__", "constructor", "toString"]) {
    Assert.equal(await store.verify(id, "x"), null, id);
  }
});

add_task(async function a_file_of_another_version_is_refused() {
  const path = freshPath("version");
  await IOUtils.writeJSON(path, { version: 2, agents: {} });
  await Assert.rejects(SvalAgentStore.open(path), /version/);
});

/** A write that fails must not forget the agent, or a retry skips the write and the hash outlives the unpairing. */
add_task(
  async function a_failed_unpair_write_leaves_the_agent_paired_and_retryable() {
    const dir = PathUtils.join(
      PathUtils.profileDir,
      `agents-failed-write-${Date.now()}`
    );
    await IOUtils.makeDirectory(dir);
    const path = PathUtils.join(dir, "agents.json");
    const store = await SvalAgentStore.open(path);
    const { agentId, secret } = await store.pair({
      label: "A",
      workspaceId: "ws",
    });

    // A file in place of the directory, which no write can go into.
    await IOUtils.remove(dir, { recursive: true });
    await IOUtils.writeUTF8(dir, "");
    await Assert.rejects(
      store.unpair(agentId),
      /./,
      "the failed write rejects"
    );
    Assert.ok(await store.verify(agentId, secret), "the agent is still paired");
    Assert.equal(store.agents().length, 1);

    await IOUtils.remove(dir);
    await IOUtils.makeDirectory(dir);
    Assert.ok(await store.unpair(agentId), "the retry unpairs");
    Assert.equal(
      await (await SvalAgentStore.open(path)).verify(agentId, secret),
      null,
      "a reopened store no longer verifies"
    );
  }
);

add_task(async function concurrent_pairs_all_persist() {
  const path = freshPath("concurrent");
  const store = await SvalAgentStore.open(path);
  const paired = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      store.pair({ label: `A${i}`, workspaceId: "ws" })
    )
  );
  const again = await SvalAgentStore.open(path);
  Assert.equal(again.agents().length, 5);
  for (const { agentId, secret } of paired) {
    Assert.ok(await again.verify(agentId, secret), agentId);
  }
});

/**
 * The file holds secret hashes, so no other OS user may read it, even where
 * the profile directory is world-readable. Windows has no mode to check;
 * test_sval_agents_listener.js checks the directory's DACL there.
 */
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function the_agents_file_is_readable_only_by_its_owner() {
    const path = freshPath("mode");
    const store = await SvalAgentStore.open(path);
    const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
    let { permissions } = await IOUtils.stat(path);
    Assert.equal(permissions & 0o077, 0, `mode ${permissions.toString(8)}`);
    Assert.deepEqual(await temporariesOf(path), [], "no temporary file left");

    // A later write keeps it private too.
    await store.unpair(agentId);
    ({ permissions } = await IOUtils.stat(path));
    Assert.equal(permissions & 0o077, 0, `mode ${permissions.toString(8)}`);
  }
);

/**
 * An app pairs again when its sval-mcp has lost its secret: it is the same
 * agent, with its rules and workspaces, under a new secret.
 */
add_task(async function an_app_that_pairs_again_stays_one_agent() {
  const path = freshPath("again");
  const store = await SvalAgentStore.open(path);
  const first = await store.pair({
    label: "Claude Code",
    launchId: "0123456789abcdef",
    workspaceId: "ws-1",
  });
  await store.setSiteLevel(first.agentId, "reddit.com", "full");

  const again = await store.pair({
    label: "Claude Code",
    isolated: true,
    launchId: "0123456789abcdef",
    workspaceId: "ws-2",
  });
  Assert.equal(again.agentId, first.agentId, "the same agent");
  Assert.equal(store.agents().length, 1, "one record");
  Assert.equal(await store.verify(first.agentId, first.secret), null);
  Assert.deepEqual(await store.verify(again.agentId, again.secret), {
    agentId: first.agentId,
    label: "Claude Code",
    isolated: true,
  });
  const reopened = await SvalAgentStore.open(path);
  Assert.equal(
    reopened.policyOf(first.agentId).sites["reddit.com"],
    "full",
    "its rules stay"
  );
  Assert.deepEqual(
    reopened
      .agents()[0]
      .workspaces.map(w => w.workspaceId)
      .sort(),
    ["ws-1", "ws-2"],
    "its workspaces stay"
  );

  const other = await store.pair({
    label: "Claude Code",
    launchId: "fedcba9876543210",
  });
  const unsaid = await store.pair({ label: "Claude Code" });
  Assert.equal(
    new Set([first.agentId, other.agentId, unsaid.agentId]).size,
    3,
    "another app, or one that names no launch, is another agent"
  );
});

add_task(async function a_site_level_persists_and_unknown_levels_are_refused() {
  const path = freshPath("policy");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  await store.setSiteLevel(agentId, "ebay.com", "read-only");
  Assert.equal(
    (await SvalAgentStore.open(path)).policyOf(agentId).sites["ebay.com"],
    "read-only"
  );
  await Assert.rejects(
    store.setSiteLevel(agentId, "ebay.com", "sometimes"),
    /level/
  );
  Assert.equal(store.policyOf("nobody"), null);
  const copy = store.policyOf(agentId);
  copy.sites["x.com"] = "full";
  Assert.ok(
    !("x.com" in store.policyOf(agentId).sites),
    "policyOf returns a copy"
  );
});

/**
 * An "Always" answer about writes to several sites sets them together, and
 * leaves a site the caller keeps, as the policy stands at the write.
 */
add_task(async function several_sites_are_set_together_but_kept_sites_stay() {
  const path = freshPath("policy");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  await store.setSiteLevel(agentId, "b.example", "blocked");
  const seen = [];
  await store.setSiteLevels(
    agentId,
    ["a.example", "b.example", "c.example"],
    "read-only",
    (policy, site) => {
      seen.push(site);
      return policy.sites[site] === "blocked";
    }
  );
  Assert.deepEqual(seen, ["a.example", "b.example", "c.example"]);
  Assert.deepEqual((await SvalAgentStore.open(path)).policyOf(agentId).sites, {
    "a.example": "read-only",
    "b.example": "blocked",
    "c.example": "read-only",
  });
  await Assert.rejects(
    store.setSiteLevels(agentId, ["a.example"], "sometimes"),
    /level/
  );
});

add_task(async function a_site_named_like_a_prototype_member_is_an_own_key() {
  const path = freshPath("policy-proto");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  await store.setSiteLevel(agentId, "__proto__", "blocked");
  await store.setSiteLevel(agentId, "constructor", "full");
  for (const policy of [
    store.policyOf(agentId),
    (await SvalAgentStore.open(path)).policyOf(agentId),
  ]) {
    Assert.ok(Object.hasOwn(policy.sites, "__proto__"));
    Assert.equal(policy.sites.__proto__, "blocked");
    Assert.equal(policy.sites.constructor, "full");
    Assert.equal(
      Object.getPrototypeOf(Object.getPrototypeOf(policy.sites)),
      null,
      "the prototype is still a plain Object.prototype"
    );
    Assert.ok(!Object.hasOwn(policy.sites, "toString"));
  }
  Assert.equal({}.blocked, undefined, "Object.prototype is untouched");
});

add_task(async function setting_a_level_for_an_unknown_agent_writes_nothing() {
  const path = freshPath("policy-nobody");
  const store = await SvalAgentStore.open(path);
  await store.setSiteLevel("nobody", "ebay.com", "full");
  await store.setSiteLevel("__proto__", "ebay.com", "full");
  Assert.ok(!(await IOUtils.exists(path)), "no file was written");
  Assert.equal(store.policyOf("__proto__"), null);
});

/**
 * A write keeps every field Sval does not know (spec §5.2), at every level of
 * the file. What Sval cannot read in a policy is dropped as it loads.
 */
add_task(async function a_write_keeps_what_sval_does_not_know() {
  const path = freshPath("unknown");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  const json = await IOUtils.readJSON(path);
  json.later = { kept: true };
  json.agents[agentId].note = "kept";
  json.agents[agentId].policy.future = [1, 2];
  json.agents[agentId].policy.sites["odd.example"] = "everything";
  json.agents[agentId].policy.downloads = { "dl.example": "maybe" };
  json.agents[agentId].policy.uploads = "damaged";
  await IOUtils.writeJSON(path, json);

  const reopened = await SvalAgentStore.open(path);
  await reopened.setSiteLevel(agentId, "new.example", "full");
  await reopened.setFilePermission(agentId, "downloads", "a.example", "allow");
  await reopened.setFilePermission(agentId, "uploads", "b.example", "deny");
  const after = await IOUtils.readJSON(path);
  Assert.deepEqual(after.later, { kept: true }, "a top-level field is kept");
  Assert.equal(after.agents[agentId].note, "kept", "a record field is kept");
  const { policy } = after.agents[agentId];
  Assert.deepEqual(policy.future, [1, 2], "a policy field is kept");
  Assert.ok(!("odd.example" in policy.sites), "an unreadable level goes");
  Assert.equal(policy.sites["new.example"], "full");
  Assert.deepEqual(policy.downloads, { "a.example": "allow" });
  Assert.deepEqual(policy.uploads, { "b.example": "deny" });
  await Assert.rejects(
    reopened.setFilePermission(agentId, "downloads", "a.example", "sometimes"),
    /permission/
  );
  await Assert.rejects(
    reopened.setFilePermission(agentId, "cookies", "a.example", "allow"),
    /permission/
  );
});

add_task(async function a_planted_temporary_file_does_not_block_the_write() {
  const path = freshPath("planted");
  const planted = `${path}.tmp`;
  await IOUtils.writeUTF8(planted, "planted");
  await IOUtils.setPermissions(planted, 0o400);
  await writePrivateJSON(path, { written: true });
  Assert.deepEqual(await IOUtils.readJSON(path), { written: true });
  Assert.deepEqual(
    await temporariesOf(path),
    [planted],
    "only the planted file is left beside it"
  );
  if (AppConstants.platform != "win") {
    const { permissions } = await IOUtils.stat(path);
    Assert.equal(permissions & 0o777, 0o600, `mode ${permissions.toString(8)}`);
  }
  await IOUtils.remove(planted, { retryReadonly: true });
});

/**
 * The default is set by one setter, and a site's rules come off one at a
 * time or together. Each change is written and told.
 */
add_task(async function the_default_and_rules_are_edited() {
  const path = freshPath("edit");
  let changes = 0;
  const store = await SvalAgentStore.open(path, { onChange: () => changes++ });
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  Assert.equal(store.policyOf(agentId).default, "ask", "a new agent asks");

  for (const value of [
    "blocked",
    "read-only",
    "ask-before-writes",
    "full",
    "ask",
  ]) {
    await store.setDefault(agentId, value);
    Assert.equal(store.policyOf(agentId).default, value);
  }
  await Assert.rejects(store.setDefault(agentId, "sometimes"), /default/);
  await store.setDefault("nobody", "full");

  await store.setDefault(agentId, "read-only");
  await store.setSiteLevel(agentId, "a.example", "full");
  await store.setFilePermission(agentId, "downloads", "a.example", "allow");
  await store.setFilePermission(agentId, "uploads", "a.example", "deny");
  await Assert.rejects(
    store.setFilePermission(agentId, "uploads", "a.example", "allow"),
    /permission/,
    "uploads are allowed only from folders"
  );
  await store.removeSiteLevel(agentId, "a.example");
  let policy = (await SvalAgentStore.open(path)).policyOf(agentId);
  Assert.equal(policy.default, "read-only", "the default is on disk");
  Assert.ok(!("a.example" in policy.sites), "the level is gone");
  Assert.equal(policy.downloads["a.example"], "allow", "the files stay");

  await store.removeFilePermission(agentId, "downloads", "a.example");
  policy = store.policyOf(agentId);
  Assert.ok(!("a.example" in policy.downloads));
  Assert.equal(policy.uploads["a.example"], "deny");
  await Assert.rejects(
    store.removeFilePermission(agentId, "cookies", "a.example"),
    /permission/
  );

  await store.setSiteLevel(agentId, "a.example", "blocked");
  await store.setAppPermission(agentId, "a.example", "mailto", "allow");
  await store.removeSite(agentId, "a.example");
  policy = store.policyOf(agentId);
  for (const map of ["sites", "downloads", "uploads", "apps"]) {
    Assert.ok(!Object.hasOwn(policy[map], "a.example"), `${map} cleared`);
  }

  const before = changes;
  await store.removeSite(agentId, "a.example");
  Assert.equal(changes, before, "removing nothing writes nothing");
});

/**
 * "Always allow" for uploads records the folders it covers with their scope,
 * adding to those allowed before, keeping the wider scope of a folder named
 * twice, and replaces a denial (decision 0129).
 */
add_task(async function upload_folders_add_up() {
  const path = freshPath("upload-folders");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  await store.setFilePermission(agentId, "uploads", "a.example", "deny");
  await store.allowUploadFolders(agentId, "a.example", ["/u/a"], true);
  await store.allowUploadFolders(agentId, "a.example", ["/u/b", "/u/a"], false);
  Assert.deepEqual(
    (await SvalAgentStore.open(path)).policyOf(agentId).uploads["a.example"],
    {
      folders: [
        { path: "/u/a", subfolders: true },
        { path: "/u/b", subfolders: false },
      ],
    },
    "an alert never narrows a folder"
  );
  await store.allowUploadFolders(agentId, "a.example", ["/u/b"], true);
  Assert.deepEqual(
    store.policyOf(agentId).uploads["a.example"].folders[1],
    { path: "/u/b", subfolders: true },
    "and widens one only as the user chose"
  );
  await Assert.rejects(
    store.allowUploadFolders(agentId, "a.example", [], false),
    /folders/
  );
  await Assert.rejects(
    store.allowUploadFolders(agentId, "a.example", ["/u/c"]),
    /folders/,
    "a folder needs its scope"
  );
});

/**
 * Settings narrows an upload folder or removes it, and never widens one. The
 * last folder's removal leaves no entry, so Sval asks again.
 */
add_task(async function settings_narrows_and_removes_upload_folders() {
  const path = freshPath("upload-folder-changes");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  await store.allowUploadFolders(agentId, "a.example", ["/u/a", "/u/b"], true);
  await store.changeUploadFolder(agentId, "a.example", "/u/a", "narrow");
  Assert.deepEqual(store.policyOf(agentId).uploads["a.example"].folders, [
    { path: "/u/a", subfolders: false },
    { path: "/u/b", subfolders: true },
  ]);
  await store.changeUploadFolder(agentId, "a.example", "/u/a", "remove");
  await store.changeUploadFolder(agentId, "a.example", "/u/x", "remove");
  Assert.deepEqual(store.policyOf(agentId).uploads["a.example"].folders, [
    { path: "/u/b", subfolders: true },
  ]);
  await store.changeUploadFolder(agentId, "a.example", "/u/b", "remove");
  Assert.ok(
    !Object.hasOwn(
      (await SvalAgentStore.open(path)).policyOf(agentId).uploads,
      "a.example"
    ),
    "no folders left is no entry"
  );
  await Assert.rejects(
    store.changeUploadFolder(agentId, "a.example", "/u/b", "widen"),
    /upload folder/
  );
});

/**
 * Apps are recorded per site and scheme, a site-wide Deny replaces them, and
 * forgetting the last scheme leaves no entry (agent-control spec §5.2).
 */
add_task(async function app_permissions_are_kept_per_scheme() {
  const path = freshPath("apps");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  await store.setAppPermission(agentId, "zoom.us", "zoommtg", "allow");
  await store.setAppPermission(agentId, "zoom.us", "zoomus", "deny");
  Assert.deepEqual(
    (await SvalAgentStore.open(path)).policyOf(agentId).apps["zoom.us"],
    { zoommtg: "allow", zoomus: "deny" }
  );
  await store.removeAppPermission(agentId, "zoom.us", "zoomus");
  Assert.deepEqual(store.policyOf(agentId).apps["zoom.us"], {
    zoommtg: "allow",
  });
  await store.setApps(agentId, "zoom.us", "deny");
  Assert.equal(store.policyOf(agentId).apps["zoom.us"], "deny");
  await store.setAppPermission(agentId, "zoom.us", "mailto", "allow");
  Assert.deepEqual(store.policyOf(agentId).apps["zoom.us"], {
    mailto: "allow",
  });
  await store.removeAppPermission(agentId, "zoom.us", "mailto");
  Assert.ok(!Object.hasOwn(store.policyOf(agentId).apps, "zoom.us"));
  await store.setApps(agentId, "a.example", "deny");
  await store.setApps(agentId, "a.example", null);
  Assert.ok(!Object.hasOwn(store.policyOf(agentId).apps, "a.example"));
  await Assert.rejects(
    store.setAppPermission(agentId, "a.example", "Not A Scheme", "allow"),
    /app permission/
  );
  await Assert.rejects(
    store.setAppPermission(agentId, "a.example", "mailto", "maybe"),
    /app permission/
  );
  await Assert.rejects(store.setApps(agentId, "a.example", "allow"), /apps/);
});

/**
 * Reading a site's console is decided per agent and per site, and the answer
 * outlives the store (agent-control spec §4.5).
 */
add_task(async function console_permissions_are_kept_per_agent_and_site() {
  const path = freshPath("console");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws-a" });
  const other = (await store.pair({ label: "B", workspaceId: "ws-b" })).agentId;
  await store.setFilePermission(agentId, "console", "a.example", "allow");
  await store.setFilePermission(agentId, "console", "b.example", "deny");
  const reopened = await SvalAgentStore.open(path);
  Assert.deepEqual(reopened.policyOf(agentId).console, {
    "a.example": "allow",
    "b.example": "deny",
  });
  Assert.deepEqual(
    reopened.policyOf(other).console,
    {},
    "another agent has no answer"
  );
  await reopened.removeFilePermission(agentId, "console", "a.example");
  Assert.ok(!Object.hasOwn(reopened.policyOf(agentId).console, "a.example"));
  await reopened.removeSite(agentId, "b.example");
  Assert.deepEqual(reopened.policyOf(agentId).console, {});
  await reopened.restoreSite(agentId, "b.example", { console: "deny" });
  Assert.equal(reopened.policyOf(agentId).console["b.example"], "deny");
  await Assert.rejects(
    reopened.setFilePermission(agentId, "console", "a.example", "sometimes"),
    /file permission/
  );
});

/** Site tools' answers are kept per agent, and a site's removal takes them. */
add_task(async function site_tools_answers_are_kept_and_removed() {
  const path = freshPath("page-tools");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  const HASH = "b".repeat(64);
  await store.setPageTools(agentId, "on");
  await store.setPageToolSite(agentId, "a.example", "allow");
  await store.setPageToolSite(agentId, "b.example", "deny");
  await store.grantPageTool(agentId, "a.example", "search", HASH);
  await store.grantPageTool(agentId, "a.example", "cart", HASH);
  let policy = (await SvalAgentStore.open(path)).policyOf(agentId);
  Assert.equal(policy.pageTools, "on");
  Assert.deepEqual(policy.pageToolSites, {
    "a.example": "allow",
    "b.example": "deny",
  });
  Assert.deepEqual(policy.pageToolGrants, {
    "a.example": { search: HASH, cart: HASH },
  });

  await store.revokePageTool(agentId, "a.example", "cart");
  await store.removePageToolSite(agentId, "b.example");
  policy = store.policyOf(agentId);
  Assert.deepEqual(policy.pageToolGrants, { "a.example": { search: HASH } });
  Assert.deepEqual(policy.pageToolSites, { "a.example": "allow" });

  await store.setPageToolSite(agentId, "a.example", "deny");
  Assert.ok(
    !("a.example" in store.policyOf(agentId).pageToolGrants),
    "denying a site's tools drops its grants"
  );
  await store.setPageToolSite(agentId, "c.example", "allow");
  await store.grantPageTool(agentId, "c.example", "search", HASH);
  await store.removeSite(agentId, "c.example");
  policy = store.policyOf(agentId);
  Assert.ok(!("c.example" in policy.pageToolSites), "removing a site");
  Assert.ok(!("c.example" in policy.pageToolGrants), "takes its tools too");

  await Assert.rejects(store.setPageTools(agentId, "maybe"), /site tools/);
  await Assert.rejects(
    store.setPageToolSite(agentId, "a.example", "maybe"),
    /site tools/
  );
  await Assert.rejects(
    store.grantPageTool(agentId, "a.example", "x", "short"),
    /site tools/
  );
});

/**
 * A removed site's rule comes back whole, in one write, and a rule with a
 * part Sval cannot read is refused whole, so Undo never leaves half a rule.
 */
add_task(async function a_removed_site_is_restored_whole_or_not_at_all() {
  const path = freshPath("restore-site");
  let changes = 0;
  const store = await SvalAgentStore.open(path, { onChange: () => changes++ });
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  const HASH = "c".repeat(64);
  const rule = {
    level: "full",
    downloads: "allow",
    uploads: "deny",
    apps: { mailto: "allow" },
    toolSite: "allow",
    grants: { search: HASH },
  };

  const before = changes;
  await store.restoreSite(agentId, "a.example", rule);
  Assert.equal(changes, before + 1, "one write");
  const policy = (await SvalAgentStore.open(path)).policyOf(agentId);
  Assert.equal(policy.sites["a.example"], "full");
  Assert.equal(policy.downloads["a.example"], "allow");
  Assert.equal(policy.uploads["a.example"], "deny");
  Assert.deepEqual(policy.apps["a.example"], { mailto: "allow" });
  Assert.equal(policy.pageToolSites["a.example"], "allow");
  Assert.deepEqual(policy.pageToolGrants["a.example"], { search: HASH });

  for (const damaged of [
    { level: "everything" },
    { downloads: "maybe" },
    { apps: "allow" },
    { toolSite: "maybe" },
    { grants: { search: HASH, cart: "short" } },
  ]) {
    const written = changes;
    await Assert.rejects(
      store.restoreSite(agentId, "b.example", { ...rule, ...damaged }),
      /unreadable rule/,
      JSON.stringify(damaged)
    );
    Assert.equal(changes, written, "nothing is written");
    const after = store.policyOf(agentId);
    for (const map of [
      "sites",
      "downloads",
      "uploads",
      "apps",
      "pageToolSites",
      "pageToolGrants",
    ]) {
      Assert.ok(!Object.hasOwn(after[map] ?? {}, "b.example"), map);
    }
  }
});

/**
 * What the user decided about Be polite is the pairing's, so it goes with
 * it.
 */
add_task(
  async function unpairing_clears_what_the_user_decided_about_be_polite() {
    const store = await SvalAgentStore.open(freshPath("polite"));
    const first = await store.pair({
      label: "Claude Code",
      workspaceId: "ws-1",
    });
    setPolite(first.agentId, false);
    Assert.ok(!isPolite(first.agentId));

    Assert.ok(await store.unpair(first.agentId));
    Assert.ok(
      isPolite(first.agentId),
      "nothing of the choice outlives the pairing"
    );
  }
);

/**
 * The user's later choice of isolated or shared reaches the agent whose
 * workspace it is, so its next workspace is that kind too, and no other.
 */
add_task(async function isolating_a_workspace_is_kept_with_its_agents() {
  const path = freshPath("isolated");
  const store = await SvalAgentStore.open(path);
  const { agentId } = await store.pair({ label: "A", workspaceId: "ws" });
  const { agentId: other } = await store.pair({
    label: "B",
    workspaceId: "ws-other",
  });
  await store.setIsolated("ws", true);
  const isolatedOf = async id =>
    (await SvalAgentStore.open(path)).agents().find(a => a.agentId === id)
      .isolated;
  Assert.equal(await isolatedOf(agentId), true, "kept, and written");
  Assert.equal(await isolatedOf(other), false, "another workspace's agent");
  await store.setIsolated("ws", false);
  Assert.equal(await isolatedOf(agentId), false);
});
