/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * An agent over the real listener, as sval-mcp connects (agent-control spec
 * §3.2, §5.6): a call waiting for the user does not hold up the agent's
 * next requests, and the user's answer settles every call waiting on it.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { SvalTestAgentClient } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestAgentClient.sys.mjs"
);
const { setPageTimeoutForTests } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs"
);
const { setPolite } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs"
);

const agentDir = () => PathUtils.join(PathUtils.profileDir, "sval-agents");

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await SpecialPowers.pushPrefEnv({
    set: [[SvalAgents.PREF, true]],
  });
  // The port file is what an agent finds Sval by, and Sval writes it after it
  // starts listening.
  await TestUtils.waitForCondition(async () => {
    const file = PathUtils.join(agentDir(), "port.json");
    return (
      SvalAgents.port !== null &&
      (await IOUtils.exists(file)) &&
      (await IOUtils.readJSON(file)).port === SvalAgents.port
    );
  }, "agent access listens and has written its port file");
  registerCleanupFunction(async () => {
    await SpecialPowers.popPrefEnv();
    await TestUtils.waitForCondition(
      () => SvalAgents.port === null,
      "agent access closes"
    );
    await IOUtils.remove(PathUtils.join(agentDir(), "agents.json"), {
      ignoreAbsent: true,
    });
  });
});

/**
 * Connects as sval-mcp does and asks to pair. Every frame Sval sends after
 * that is kept, and waited for as it arrives.
 *
 * @param {object} [launch] What the handshake says of sval-mcp's launch.
 * @returns {Promise<object>} `call(id, method, params)`, `replyTo(id)`,
 *   `reply(id)`, `progressed(token)` and `close()`.
 */
async function connectUnpaired(launch = undefined) {
  const { token } = await IOUtils.readJSON(
    PathUtils.join(agentDir(), "port.json")
  );
  const c = await within(
    SvalTestAgentClient.connect(SvalAgents.port, token),
    10_000,
    "sval's answer to the challenge"
  );
  Assert.equal(
    c.ctl.sval,
    await SvalTestAgentClient.mac(token, `sval:${c.nonce}`),
    "sval proves itself"
  );
  c.sendFrame({ hello: 1, pair: true, proof: c.proof, launch });
  Assert.deepEqual(await within(c.next(), 10_000, "sval's ready"), {
    ctl: { ready: "unpaired" },
  });

  const isReplyTo = id => f => f.mcp?.id === id;
  return {
    replyTo: id => c.frames.find(isReplyTo(id))?.mcp,
    call(id, method, params) {
      c.sendFrame({ mcp: { jsonrpc: "2.0", id, method, params } });
    },
    async reply(id) {
      return (await within(c.waitFor(isReplyTo(id)), 10_000, `reply ${id}`))
        .mcp;
    },
    progressed(progressToken) {
      return within(
        c.waitFor(
          f =>
            f.mcp?.method === "notifications/progress" &&
            f.mcp.params.progressToken === progressToken
        ),
        10_000,
        `call ${progressToken} reports that it waits`
      );
    },
    close: c.close,
  };
}

/** @returns {Promise<Set<string>>} The ids of every workspace now. */
async function workspaceIds() {
  const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
  return new Set(
    Object.entries(nodes)
      .filter(([, node]) => node.kind === "workspace")
      .map(([id]) => id)
  );
}

/**
 * Takes down, when the task ends, what a task's agent made: its connection,
 * an alert left open, its pairing and its workspace.
 *
 * @param {object} c What `connectUnpaired` returned.
 * @param {Set<string>} before The workspaces from before the task.
 */
function takeDownAtTaskEnd(c, before) {
  atTaskEnd(async () => {
    c.close();
    if (gDialogBox.isOpen) {
      gDialogBox.dialog.close();
      await TestUtils.waitForCondition(() => !gDialogBox.isOpen, "closed");
    }
    for (const id of await workspaceIds()) {
      if (before.has(id)) {
        continue;
      }
      for (const agent of SvalAgents.store?.agents() ?? []) {
        if (agent.workspaces.some(w => w.workspaceId === id)) {
          await SvalAgents.unpair(agent.agentId);
        }
      }
      await removeWorkspace(id);
    }
  });
}

/**
 * The real sequence a new agent meets: it pairs, then opens a tab on a site
 * the user has not decided on while its window is not open yet. While each
 * of those calls waits for the user, the agent's next requests are answered,
 * and a second call for the same site waits on the same alert. Allow
 * settles every call waiting on it.
 */
add_task(async function waiting_calls_leave_the_connection_free() {
  const before = await workspaceIds();
  const c = await connectUnpaired();
  takeDownAtTaskEnd(c, before);
  c.call(1, "initialize", {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "Wire Agent" },
  });
  await c.reply(1);

  c.call(2, "tools/call", {
    name: "request_shared_pairing",
    arguments: { task: "Test task" },
    _meta: { progressToken: "pair" },
  });
  await c.progressed("pair");
  c.call(3, "tools/list");
  Assert.deepEqual(
    (await c.reply(3)).result.tools.map(t => t.name),
    ["request_isolated_pairing", "request_shared_pairing"],
    "answered while the pairing waits"
  );
  Assert.equal(c.replyTo(2), undefined, "the pairing still waits");
  await TestUtils.waitForCondition(
    () =>
      gDialogBox.dialog?._frame.contentDocument?.querySelector(
        ".sval-ap-allow"
      ),
    "the pairing alert draws"
  );
  await pair(gDialogBox.dialog._frame.contentDocument);
  Assert.ok(!(await c.reply(2)).result.isError, "Allow paired the agent");

  const open = (id, progressToken) =>
    c.call(id, "tools/call", {
      name: "open_tab",
      arguments: { url: PAGE2 },
      _meta: { progressToken },
    });
  open(4, "first");
  await c.progressed("first");
  c.call(5, "tools/call", { name: "list_tabs", arguments: {} });
  const listed = await c.reply(5);
  Assert.ok(!listed.result.isError, "list_tabs answered while open_tab waits");
  open(6, "second");
  await c.progressed("second");
  Assert.equal(c.replyTo(4), undefined, "the first open_tab still waits");
  Assert.equal(c.replyTo(6), undefined, "and so does the second");

  const created = [...(await workspaceIds())].filter(id => !before.has(id));
  Assert.equal(created.length, 1, "pairing made the agent's workspace");
  const agentWin = await TestUtils.waitForCondition(() => {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.SvalPanel?.workspaceId === created[0] && w.gDialogBox?.isOpen) {
        return w;
      }
    }
    return null;
  }, "the agent's window asks");
  Assert.equal(agentWin.gDialogBox._queued.length, 0, "one alert for both");
  await choose(await alertIn(agentWin), "allow");
  for (const id of [4, 6]) {
    const reply = await c.reply(id);
    Assert.ok(!reply.result.isError, `call ${id} carried on`);
    Assert.equal(JSON.parse(reply.result.content[0].text).url, PAGE2);
  }
});

/**
 * A page whose script never yields holds no more than its own call: the call
 * gives up with page_unresponsive, and the agent's next request on the same
 * connection is answered while the page is still busy.
 */
add_task(async function a_busy_page_leaves_the_connection_free() {
  const before = await workspaceIds();
  const c = await connectUnpaired();
  takeDownAtTaskEnd(c, before);
  c.call(1, "initialize", {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "Busy Agent" },
  });
  await c.reply(1);
  c.call(2, "tools/call", {
    name: "request_shared_pairing",
    arguments: { task: "Test task" },
  });
  const doc = await TestUtils.waitForCondition(() => {
    const d = gDialogBox.dialog?._frame.contentDocument;
    return d?.querySelector(".sval-ap-allow") ? d : null;
  }, "the pairing alert draws");
  await pair(doc);
  Assert.ok(!(await c.reply(2)).result.isError, "paired");
  const [created] = [...(await workspaceIds())].filter(id => !before.has(id));

  c.call(3, "tools/call", { name: "open_tab", arguments: { url: PAGE2 } });
  const agentWin = await TestUtils.waitForCondition(() => {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.SvalPanel?.workspaceId === created && w.gDialogBox?.isOpen) {
        return w;
      }
    }
    return null;
  }, "the agent's window asks about the site");
  await choose(await alertIn(agentWin), "allow");
  const { tab } = JSON.parse((await c.reply(3)).result.content[0].text);
  const browser = agentWin.gBrowser.selectedBrowser;
  Assert.equal(browser.currentURI.spec, PAGE2, "the agent's tab");

  atTaskEnd(setPageTimeoutForTests(300));
  let free = false;
  const busy = SpecialPowers.spawn(browser, [], () => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      // Never yields to the page's event loop.
    }
  }).then(() => {
    free = true;
  });
  try {
    c.call(10, "tools/call", { name: "get_snapshot", arguments: { tab } });
    c.call(11, "tools/call", { name: "list_tabs", arguments: {} });
    const read = await c.reply(10);
    Assert.ok(read.result.isError, "the read failed");
    Assert.equal(
      JSON.parse(read.result.content[0].text).error,
      "page_unresponsive"
    );
    const listed = await c.reply(11);
    Assert.ok(!listed.result.isError, "list_tabs is answered");
    Assert.ok(!free, "while the page is still busy");
  } finally {
    await busy;
  }
});

/**
 * An agent's task names its workspace, and its client and model name the
 * agent: the alert asks under the agent's name and says the task beside what
 * sval-mcp said of its launch; the workspace, its mark, the record, the
 * pairing result and `list_tabs` each carry theirs.
 */
add_task(async function an_agents_task_names_its_workspace() {
  const before = await workspaceIds();
  const c = await connectUnpaired({
    dir: "/work/sval",
    started: 1_700_000_000_000,
    id: "7f3a0123456789ab",
  });
  takeDownAtTaskEnd(c, before);
  c.call(1, "initialize", {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "claude-code" },
  });
  await c.reply(1);
  c.call(2, "tools/call", {
    name: "request_shared_pairing",
    arguments: { task: "Fix login redirect", model: "Opus 5.5" },
  });
  const doc = await TestUtils.waitForCondition(() => {
    // The button is in the markup; the question is written at
    // DOMContentLoaded, with the facts.
    const d = gDialogBox.dialog?._frame.contentDocument;
    return d?.getElementById("sval-ap-question")?.textContent ? d : null;
  }, "the pairing alert draws");
  Assert.ok(
    doc.getElementById("sval-ap-question").textContent.includes("claude-code"),
    "the alert names the agent by its client"
  );
  const facts = [...doc.getElementById("sval-ap-facts").children].map(
    li => li.textContent
  );
  Assert.equal(facts.length, 4, "the task, client, folder and start");
  Assert.ok(facts[0].includes("Fix login redirect"), facts[0]);
  Assert.ok(facts[1].includes("claude-code"), facts[1]);
  Assert.ok(facts[2].includes("/work/sval"), facts[2]);
  await pair(doc);
  const paired = (await c.reply(2)).result;
  Assert.ok(!paired.isError);
  Assert.ok(
    paired.content[0].text.includes('"Fix login redirect"'),
    paired.content[0].text
  );

  c.call(3, "tools/call", { name: "list_tabs", arguments: {} });
  const listed = JSON.parse((await c.reply(3)).result.content[0].text);
  Assert.equal(listed.workspace, "Fix login redirect");

  const [created] = [...(await workspaceIds())].filter(id => !before.has(id));
  const node = (await SvalPanel.engine.tree()).nodes[created];
  Assert.equal(
    node.content.name,
    "Fix login redirect",
    "the workspace is named for the task"
  );
  Assert.equal(node.agent.label, "claude-code", "and marked as the agent's");
  const record = SvalAgents.store
    .agents()
    .find(a => a.workspaces.some(w => w.workspaceId === created));
  Assert.equal(
    typeof record.workspaces[0].lastUsed,
    "number",
    "making the workspace counts as using it"
  );
  delete record.workspaces[0].lastUsed;
  Assert.deepEqual(
    { ...record, agentId: null },
    {
      agentId: null,
      label: "claude-code",
      client: "claude-code",
      isolated: false,
      workspaces: [
        {
          workspaceId: created,
          task: "Fix login redirect",
          model: "Opus 5.5",
          dir: "/work/sval",
          started: 1_700_000_000_000,
        },
      ],
    }
  );
});

/**
 * Be polite over the real listener: a burst of actions on one site, sent
 * together as a model's parallel tool calls are, queues in order up to
 * `MAX_QUEUED`, and the rest are refused with when to try again. A read sent
 * with them is answered at once. How many are kept depends on how long the
 * first action takes, since a queued one that has gone frees its place, so
 * this checks the shape and `test_sval_agent_polite.js` checks the counts.
 */
add_task(async function a_burst_of_actions_on_one_site_queues_then_refuses() {
  const before = await workspaceIds();
  const c = await connectUnpaired();
  takeDownAtTaskEnd(c, before);
  c.call(1, "initialize", {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "Burst Agent" },
  });
  await c.reply(1);
  c.call(2, "tools/call", {
    name: "request_shared_pairing",
    arguments: { task: "Test task" },
  });
  const doc = await TestUtils.waitForCondition(() => {
    const d = gDialogBox.dialog?._frame.contentDocument;
    return d?.querySelector(".sval-ap-allow") ? d : null;
  }, "the pairing alert draws");
  await pair(doc);
  Assert.ok(!(await c.reply(2)).result.isError, "paired");
  const [created] = [...(await workspaceIds())].filter(id => !before.has(id));
  const { agentId } = SvalAgents.store
    .agents()
    .find(a => a.workspaces.some(w => w.workspaceId === created));

  // open_tab acts on the site too, so under Be polite it claims the site's
  // next slot. The burst's slots would then start from that claim, and one
  // could pass while the burst is still arriving, freeing a place for a
  // later action after an earlier one was refused. With Be polite off for
  // the open, the burst's first action goes at once and the slots after it
  // are counted from the burst.
  setPolite(agentId, false);
  c.call(3, "tools/call", { name: "open_tab", arguments: { url: PAGE2 } });
  const agentWin = await TestUtils.waitForCondition(() => {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.SvalPanel?.workspaceId === created && w.gDialogBox?.isOpen) {
        return w;
      }
    }
    return null;
  }, "the agent's window asks about the site");
  await choose(await alertIn(agentWin), "allow");
  const { tab } = JSON.parse((await c.reply(3)).result.content[0].text);
  setPolite(agentId, true);

  const burst = [10, 11, 12, 13, 14, 15, 16];
  for (const id of burst) {
    c.call(id, "tools/call", {
      name: "scroll_page",
      arguments: { tab, direction: "down" },
    });
  }
  c.call(20, "tools/call", { name: "list_tabs", arguments: {} });
  const listed = JSON.parse((await c.reply(20)).result.content[0].text);
  Assert.deepEqual(
    listed.polite,
    { on: true, actions_per_second: 1, interval_ms: 1000, max_queued: 4 },
    "list_tabs gives the rules"
  );
  Assert.ok(
    burst.some(id => !c.replyTo(id)),
    "list_tabs is answered while actions still wait their turn"
  );
  const replies = [];
  for (const id of burst) {
    replies.push(await c.reply(id));
  }
  const kept = replies.filter(r => !r.result.isError);
  const refused = replies.filter(r => r.result.isError);
  Assert.greater(refused.length, 0, "a burst past the queue is refused");
  Assert.deepEqual(
    replies.map(r => !!r.result.isError),
    [...kept.map(() => false), ...refused.map(() => true)],
    "the first go in order; the rest are refused"
  );
  for (const r of refused) {
    const error = JSON.parse(r.result.content[0].text);
    Assert.equal(error.error, "rate_limited");
    Assert.equal(error.tab, tab);
    Assert.greater(error.retry_after_ms, 0, "with when to try again");
  }
});
