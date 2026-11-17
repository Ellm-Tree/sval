/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

/**
 * The switcher's list is every workspace in sibling order, the same on every
 * device, because it is the shared fractional index.
 */
add_task(function the_switcher_lists_every_workspace_in_sibling_order() {
  const { switcherItems } = SvalPanelModel;
  const { workspaceIds } = SvalTree;
  const nodes = {
    b: node({ kind: "workspace", name: "Second", order: "c0" }),
    a: node({ kind: "workspace", name: "First", order: "40" }),
    "": node({ kind: "workspace", name: "", order: "80" }),
    t: node({ kind: "tab", name: "A tab", parent: "a", order: "80" }),
  };

  Assert.deepEqual(
    workspaceIds(nodes),
    ["a", "", "b"],
    "workspaces in order, and a tab is not one"
  );
  Assert.deepEqual(
    switcherItems(nodes, "b"),
    [
      {
        id: "a",
        name: "First",
        color: null,
        emoji: null,
        agent: null,
        brand: null,
        device: false,
        current: false,
        elsewhere: false,
      },
      {
        id: "",
        name: "",
        color: null,
        emoji: null,
        agent: null,
        brand: null,
        device: false,
        current: false,
        elsewhere: false,
      },
      {
        id: "b",
        name: "Second",
        color: null,
        emoji: null,
        agent: null,
        brand: null,
        device: false,
        current: true,
        elsewhere: false,
      },
    ],
    "each entry carries the name the document holds and says which is current"
  );
  Assert.strictEqual(
    switcherItems(nodes, "b")[1].name,
    "",
    "a nameless workspace is reported nameless: the placeholder is the view's"
  );
  Assert.deepEqual(
    switcherItems(nodes, "b", new Set(["a"])).map(item => item.elsewhere),
    [true, false, false],
    "and each entry says whether another window shows it"
  );
});

/**
 * The switcher does not vanish when there is only one workspace. A person who
 * has never made a second one still needs to be told where they are, and the
 * control that names a workspace is the only workspace-level affordance the
 * panel has.
 */
add_task(function one_workspace_still_makes_a_switcher_entry() {
  const nodes = {
    ws: node({ kind: "workspace", name: "Only", order: "80" }),
    t: node({ kind: "tab", name: "A tab", parent: "ws", order: "80" }),
  };

  Assert.deepEqual(
    SvalPanelModel.switcherItems(nodes, "ws"),
    [
      {
        id: "ws",
        name: "Only",
        color: null,
        emoji: null,
        agent: null,
        brand: null,
        device: false,
        current: true,
        elsewhere: false,
      },
    ],
    "one entry, and it is the one being shown"
  );
  Assert.deepEqual(
    SvalPanelModel.switcherItems({}, null),
    [],
    "and a document with no workspace offers nothing rather than inventing one"
  );
});

/**
 * Which workspace a window shows, given what it remembers. Each case here is
 * a way a person otherwise loses sight of their tabs.
 */
add_task(function the_remembered_workspace_survives_or_falls_back() {
  const { currentWorkspace } = SvalPanelModel;
  const nodes = {
    a: node({ kind: "workspace", name: "First", order: "40" }),
    b: node({ kind: "workspace", name: "Second", order: "c0" }),
    t: node({ kind: "tab", name: "A tab", parent: "b", order: "80" }),
  };

  Assert.equal(
    currentWorkspace(nodes, "b"),
    "b",
    "a remembered workspace that still exists is the one shown"
  );
  Assert.equal(
    currentWorkspace(nodes, null),
    "a",
    "a brand new window shows the first workspace in sibling order"
  );
  Assert.equal(
    currentWorkspace(nodes, "gone"),
    "a",
    "a workspace deleted on another device falls back to the first, so the " +
      "panel is never empty with no way out"
  );
  Assert.equal(
    currentWorkspace(nodes, "t"),
    "a",
    "and a remembered id that is not a workspace is not shown as one"
  );
  Assert.strictEqual(
    currentWorkspace({}, "gone"),
    null,
    "with no workspace in the document there is nothing to show"
  );

  // A peer's pass brings a workspace in while the panel is open, and the
  // window stays where the user is.
  const withArrival = {
    ...nodes,
    early: node({ kind: "workspace", name: "Arrived", order: "10" }),
  };
  Assert.equal(
    SvalTree.workspaceIds(withArrival)[0],
    "early",
    "the arriving workspace sorts first, so this is not a vacuous check"
  );
  Assert.equal(
    currentWorkspace(withArrival, "b"),
    "b",
    "and the window is not yanked to it"
  );
});

/**
 * A workspace has one window (spec §10.7), so a workspace another window
 * shows is never a window's answer, remembered or not.
 */
add_task(function a_workspace_another_window_shows_is_never_the_answer() {
  const { currentWorkspace } = SvalPanelModel;
  const nodes = {
    a: node({ kind: "workspace", name: "First", order: "40" }),
    b: node({ kind: "workspace", name: "Second", order: "c0" }),
  };

  Assert.equal(
    currentWorkspace(nodes, "a", new Set(["a"])),
    "b",
    "a remembered workspace another window shows gives way to a free one"
  );
  Assert.equal(
    currentWorkspace(nodes, null, new Set(["a"])),
    "b",
    "and a new window takes the first one no window shows"
  );
  Assert.equal(
    currentWorkspace(nodes, "b", new Set(["a"])),
    "b",
    "while a remembered workspace no other window shows still wins"
  );
  Assert.strictEqual(
    currentWorkspace(nodes, "a", new Set(["a", "b"])),
    null,
    "and with every workspace shown elsewhere there is nothing for this window"
  );
});

/**
 * A window the user opens never falls back to an agent's workspace while the
 * user has a workspace of their own, free or not; a window that remembers an
 * agent's workspace, as an agent's own window does, keeps it.
 */
add_task(function a_new_window_takes_an_agents_workspace_only_when_alone() {
  const { currentWorkspace } = SvalPanelModel;
  const agentWorkspace = order => ({
    ...node({ kind: "workspace", name: "", order }),
    agent: { label: "Claude Code", device: "d" },
  });
  const nodes = {
    bot: agentWorkspace("20"),
    a: node({ kind: "workspace", name: "First", order: "40" }),
    b: node({ kind: "workspace", name: "Second", order: "c0" }),
  };

  Assert.equal(
    currentWorkspace(nodes, null),
    "a",
    "a new window passes over the agent's workspace, though it sorts first"
  );
  Assert.strictEqual(
    currentWorkspace(nodes, null, new Set(["a", "b"])),
    null,
    "and with the user's all shown elsewhere it gets none, so it makes its own"
  );
  Assert.equal(
    currentWorkspace(nodes, "bot", new Set(["a", "b"])),
    "bot",
    "while a window that remembers the agent's workspace still shows it"
  );
  Assert.strictEqual(
    currentWorkspace(nodes, "a", new Set(["a", "b"])),
    null,
    "and one whose workspace went elsewhere does not fall back to it"
  );
  Assert.equal(
    currentWorkspace({ bot: nodes.bot }, null),
    "bot",
    "with no workspace of the user's at all, the agent's is the one there is"
  );
});

/**
 * A phone's or tablet's own workspace (decision 2254) is passed over as an
 * agent's is: a window the user opens takes it only when the document holds
 * no workspace of the user's, and one that remembers it keeps it. The
 * switcher's entry says it is a device's.
 */
add_task(function a_new_window_takes_a_devices_workspace_only_when_alone() {
  const { currentWorkspace, isDeviceWorkspace, switcherItems } = SvalPanelModel;
  const nodes = {
    phone: {
      ...node({ kind: "workspace", name: "iPhone", order: "20" }),
      device_home: { device: "d" },
    },
    a: node({ kind: "workspace", name: "First", order: "40" }),
    b: node({ kind: "workspace", name: "Second", order: "c0" }),
  };

  Assert.ok(isDeviceWorkspace(nodes, "phone"), "the phone's is a device's");
  Assert.ok(!isDeviceWorkspace(nodes, "a"), "the user's is not");
  Assert.deepEqual(
    switcherItems(nodes, "a").map(item => item.device),
    [true, false, false],
    "and the switcher's entries say so"
  );
  Assert.equal(
    currentWorkspace(nodes, null),
    "a",
    "a new window passes over the device's workspace, though it sorts first"
  );
  Assert.strictEqual(
    currentWorkspace(nodes, null, new Set(["a", "b"])),
    null,
    "and with the user's all shown elsewhere it gets none"
  );
  Assert.equal(
    currentWorkspace(nodes, "phone", new Set(["a", "b"])),
    "phone",
    "while a window that remembers it still shows it"
  );
  Assert.equal(
    currentWorkspace(nodes, null, new Set(), "a"),
    "b",
    "the next one down from A is B"
  );
  Assert.equal(
    currentWorkspace(nodes, null, new Set(), "b"),
    "a",
    "and from B the wrap passes over the device's to A"
  );
  Assert.equal(
    currentWorkspace({ phone: nodes.phone }, null),
    "phone",
    "with no workspace of the user's at all, the device's is the one there is"
  );
});

/**
 * A new window opened from a workspace shows the next one down, in sibling
 * order and wrapping at the bottom, passing over the workspaces other windows
 * show and agents' workspaces, and has none to show when nothing is left.
 */
add_task(function a_window_opened_from_a_workspace_takes_the_next_one_down() {
  const { currentWorkspace } = SvalPanelModel;
  const nodes = {
    a: node({ kind: "workspace", name: "A", order: "20" }),
    b: node({ kind: "workspace", name: "B", order: "40" }),
    c: node({ kind: "workspace", name: "C", order: "80" }),
    d: node({ kind: "workspace", name: "D", order: "c0" }),
  };
  const none = new Set();

  Assert.equal(currentWorkspace(nodes, null, none, "b"), "c", "B opens C");
  Assert.equal(currentWorkspace(nodes, null, none, "d"), "a", "D wraps to A");
  Assert.equal(
    currentWorkspace(nodes, null, new Set(["c"]), "b"),
    "d",
    "C is shown elsewhere, so B opens D"
  );
  Assert.equal(
    currentWorkspace(nodes, null, new Set(["a", "c"]), "d"),
    "b",
    "and a wrap passes over the ones shown too"
  );
  Assert.strictEqual(
    currentWorkspace(nodes, null, new Set(["a", "b", "c", "d"]), "b"),
    null,
    "with all four shown there is none, so the caller makes a new one"
  );
  Assert.strictEqual(
    currentWorkspace(nodes, null, new Set(["a", "c", "d"]), "b"),
    null,
    "the workspace it is opened from is never the answer"
  );
  Assert.equal(
    currentWorkspace(nodes, "a", none, "gone"),
    "a",
    "a workspace the document does not hold leaves the answer as it was"
  );

  const withAgent = {
    ...nodes,
    e: {
      ...node({ kind: "workspace", name: "", order: "60" }),
      agent: { label: "Claude Code", device: "d" },
    },
  };
  Assert.equal(
    currentWorkspace(withAgent, null, none, "b"),
    "c",
    "an agent's workspace between B and C is passed over"
  );
  Assert.equal(
    currentWorkspace(withAgent, null, new Set(["c", "d", "a"]), "b"),
    null,
    "and never taken when it is all that is left"
  );
});

/**
 * An empty answer to a name prompt is a refusal.
 *
 * A user hits this by reflex, pressing OK without reading, so it decides
 * whether a string Sval chose ends up inside the synced document on every
 * device the person owns.
 */
add_task(async function an_empty_name_is_a_refusal_not_a_default() {
  const { chosenName } = SvalPanelModel;

  Assert.equal(chosenName(true, "Réunions"), "Réunions", "a typed name stands");
  Assert.equal(
    chosenName(true, "  Work  "),
    "Work",
    "surrounding whitespace is not part of a name"
  );

  Assert.strictEqual(
    chosenName(true, ""),
    null,
    "an empty field is no name, and the caller must create nothing"
  );
  Assert.strictEqual(
    chosenName(true, "   "),
    null,
    "whitespace is not a name either"
  );
  Assert.strictEqual(chosenName(false, "Work"), null, "cancelling is no name");
  Assert.strictEqual(
    chosenName(true, undefined),
    null,
    "a bag with no value at all is no name"
  );
});

/**
 * A workspace handed to a window Sval has just opened is delivered once, to that
 * window, and to nobody else.
 *
 * All three halves matter to the tear-off (spec §10.7). Delivered once,
 * because after startup the per-window session-store value is the only
 * record of what a window shows, and a hand-off that survived would override
 * the user's own switching the next time it was read. To that window,
 * because two tear-offs can be in flight. And to nobody else, because every
 * other window (an ordinary new one, and every window at launch) resolves
 * its workspace from what it remembers.
 */
add_task(function a_handed_workspace_is_delivered_once_to_one_window() {
  // Plain objects stand in for windows: the map is keyed by identity and
  // reads nothing off its keys, so it can be asked before the window it names
  // has run any of its own code.
  const torn = {};
  const other = {};

  Assert.equal(
    SvalPanelModel.takeHandedWorkspace(torn),
    null,
    "a window nobody handed a workspace to is handed nothing"
  );

  SvalPanelModel.handWorkspaceTo(torn, "ws-1");
  Assert.ok(
    !SvalPanelModel.isHandedToAgent(torn),
    "a user's workspace is not an agent's"
  );
  Assert.equal(
    SvalPanelModel.takeHandedWorkspace(other),
    null,
    "and a different window still is, with one in flight"
  );
  Assert.equal(
    SvalPanelModel.takeHandedWorkspace(torn),
    "ws-1",
    "the window it was handed to gets it"
  );
  Assert.equal(
    SvalPanelModel.takeHandedWorkspace(torn),
    null,
    "once: reading consumes it, so it cannot override a later switch"
  );

  SvalPanelModel.handWorkspaceTo(torn, "ws-agent", { agent: true });
  Assert.ok(
    SvalPanelModel.isHandedToAgent(torn),
    "an agent's workspace says so"
  );
  Assert.ok(!SvalPanelModel.isHandedToAgent(other), "for its own window only");
  Assert.equal(SvalPanelModel.takeHandedWorkspace(torn), "ws-agent");
  Assert.ok(!SvalPanelModel.isHandedToAgent(torn), "and not once it is taken");
});

/**
 * A new workspace needs a name and nothing else. What it is given for colour
 * and emoji goes through the same filters as every other write of them.
 */
add_task(function a_new_workspace_needs_only_a_name() {
  const { chosenContainer } = SvalPanelModel;

  Assert.deepEqual(
    chosenContainer(true, { name: "Errands", color: null, emoji: "" }),
    { name: "Errands", color: null, emoji: null, transparency: null },
    "a name alone is enough, and an empty emoji is no emoji"
  );
  Assert.deepEqual(
    chosenContainer(true, { name: " Errands ", color: "green", emoji: "🐟" }),
    { name: "Errands", color: "green", emoji: "🐟", transparency: null },
    "the name is trimmed and a colour and emoji come through"
  );
  Assert.deepEqual(
    chosenContainer(true, { name: "Errands", color: "plaid", emoji: "🐟🐠" }),
    { name: "Errands", color: null, emoji: "🐟", transparency: null },
    "a colour this build cannot draw is dropped and an emoji is cut to one"
  );
  const custom = { h: 290, c: 0.12, l: 0.36, mode: "dark" };
  Assert.deepEqual(
    chosenContainer(true, {
      name: "Errands",
      color: custom,
      emoji: "",
      transparency: 0.4,
    }),
    { name: "Errands", color: custom, emoji: null, transparency: 0.4 },
    "a Workspace keeps its custom colour and how see-through it is"
  );
  Assert.deepEqual(
    chosenContainer(true, {
      name: "Errands",
      color: null,
      emoji: "",
      transparency: 0.3,
    }),
    { name: "Errands", color: null, emoji: null, transparency: 0.3 },
    "a Workspace with no colour keeps how see-through it is"
  );
  Assert.deepEqual(
    chosenContainer(
      true,
      { name: "Errands", color: custom, emoji: "", transparency: 0.4 },
      "group"
    ),
    {
      name: "Errands",
      color: { h: 290, c: 0.12 },
      emoji: null,
      transparency: null,
    },
    "a group keeps the hue and intensity, and no transparency"
  );
  Assert.strictEqual(
    chosenContainer(true, { name: "   ", color: "green", emoji: "🐟" }),
    null,
    "a blank name creates nothing, whatever else was chosen"
  );
  Assert.strictEqual(
    chosenContainer(false, { name: "Errands", color: "green", emoji: "🐟" }),
    null,
    "a cancelled dialog creates nothing"
  );
});

/**
 * The window's title names the workspace it shows (spec §10.7), because on
 * macOS the Dock and ⌘` have nothing else to read.
 */
add_task(function the_window_title_is_prefaced_with_the_workspace() {
  const { windowTitlePreface } = SvalPanelModel;

  Assert.equal(
    windowTitlePreface("🐟", "Research"),
    "🐟 Research — ",
    "emoji, name, then the separator Firefox joins title parts with"
  );
  Assert.equal(
    windowTitlePreface(null, "Research"),
    "Research — ",
    "a workspace with no emoji is still named"
  );
  Assert.equal(
    windowTitlePreface("🐟", ""),
    "",
    "and a window showing no workspace prefaces nothing rather than an emoji " +
      "with nothing after it"
  );
});

/**
 * An agent's workspace is named by its agent wherever a workspace is named
 * (agent-control spec §6): the switcher, and the window's title, which starts
 * with the robot so the Dock and ⌘` tell an agent's window from the user's.
 */
add_task(function an_agent_workspace_is_named_by_its_agent() {
  const { AGENT_EMOJI, agentLabelOf, switcherItems, windowTitlePreface } =
    SvalPanelModel;
  const nodes = {
    a: {
      ...node({ kind: "workspace", name: "Claude Code", order: "40" }),
      agent: { label: "Claude Code", device: "d1" },
    },
    u: node({ kind: "workspace", name: "Mine", order: "80" }),
    odd: {
      ...node({ kind: "workspace", name: "Odd", order: "c0" }),
      agent: { device: "d1" },
    },
    t: node({ kind: "tab", name: "A tab", parent: "a", order: "80" }),
  };

  Assert.equal(agentLabelOf(nodes, "a"), "Claude Code", "the agent's label");
  Assert.strictEqual(
    agentLabelOf(nodes, "u"),
    null,
    "the user's is no agent's"
  );
  Assert.strictEqual(agentLabelOf(nodes, "t"), null, "a tab is no workspace");
  Assert.strictEqual(agentLabelOf(nodes, null), null, "nor is nothing");
  Assert.equal(
    agentLabelOf(nodes, "odd"),
    "An agent",
    "a mark with no label still marks the workspace as an agent's"
  );
  Assert.deepEqual(
    switcherItems(nodes, "u").map(item => item.agent),
    ["Claude Code", null, "An agent"],
    "the switcher knows which entries are agents'"
  );
  Assert.equal(
    windowTitlePreface(AGENT_EMOJI, "Claude Code"),
    "🤖 Claude Code — ",
    "an agent's window is titled with the robot and the agent's label"
  );
});

/**
 * One workspace's entry, as the History sidebar's Workspace column reads it
 * for every cell, is the entry the whole list holds for it, and there is
 * none for what the list leaves out.
 */
add_task(function one_workspaces_entry_is_its_entry_in_the_list() {
  const { switcherItemOf, switcherItems } = SvalPanelModel;
  const nodes = {
    a: {
      ...node({ kind: "workspace", name: "Claude Code", order: "40" }),
      agent: { label: "Claude Code", device: "d1" },
      appearance: { color: "blue", emoji: "🌊" },
    },
    u: node({ kind: "workspace", name: "Mine", order: "80" }),
    "": node({ kind: "workspace", name: "", order: "c0" }),
    g: node({ kind: "group", name: "A group", parent: "u", order: "80" }),
    t: node({ kind: "tab", name: "A tab", parent: "g", order: "80" }),
  };
  for (const item of switcherItems(nodes, "u")) {
    Assert.deepEqual(
      switcherItemOf(nodes, item.id, "u"),
      item,
      `the entry for ${JSON.stringify(item.id)}`
    );
  }
  for (const id of ["g", "t", "gone", "toString", "__proto__"]) {
    Assert.strictEqual(
      switcherItemOf(nodes, id, "u"),
      null,
      `no entry for ${id}, which the list leaves out`
    );
  }
});

/**
 * Another device's agent workspace is labelled with that device's name once
 * it has arrived (history-sync spec §4.3); this device's is not.
 */
add_task(function another_devices_agent_workspace_names_the_device() {
  const { agentLabelOf, switcherItems } = SvalPanelModel;
  const nodes = {
    here: {
      ...node({ kind: "workspace", name: "Claude Code", order: "40" }),
      agent: { label: "Claude Code", device: "d1" },
    },
    there: {
      ...node({ kind: "workspace", name: "Codex", order: "80" }),
      agent: { label: "Codex", device: "d2" },
    },
    unnamed: {
      ...node({ kind: "workspace", name: "Codex", order: "c0" }),
      agent: { label: "Codex", device: "d3" },
    },
  };
  const names = { d1: "Laptop", d2: "Desk" };
  const devices = { self: "d1", nameOf: device => names[device] ?? null };
  Assert.equal(agentLabelOf(nodes, "here", devices), "Claude Code");
  Assert.equal(agentLabelOf(nodes, "there", devices), "Codex · Desk");
  Assert.equal(
    agentLabelOf(nodes, "unnamed", devices),
    "Codex",
    "a device whose name has not arrived shows the label alone"
  );
  Assert.deepEqual(
    switcherItems(nodes, null, new Set(), devices).map(item => item.agent),
    ["Claude Code", "Codex · Desk", "Codex"]
  );
});

/**
 * A joining device leaves behind only workspaces nobody touched: unnamed,
 * with no group and at most one tab still on a fresh window's page.
 */
add_task(function a_joining_device_leaves_only_untouched_workspaces_behind() {
  const { withoutUntouchedWorkspaces } = SvalTree;
  const ws = (name = "") => ({ kind: "workspace", content: { name } });
  const tab = (parent, url) => ({
    kind: "tab",
    placement: { parent },
    content: { url },
  });
  const doc = {
    schema: 1,
    seen: { someone: 5 },
    nodes: {
      fresh: ws(),
      freshTab: tab("fresh", "about:newtab"),
      empty: ws(),
      named: ws("Work"),
      namedTab: tab("named", "about:newtab"),
      browsed: ws(),
      browsedTab: tab("browsed", "https://example.com/"),
      twoTabs: ws(),
      first: tab("twoTabs", "about:home"),
      second: tab("twoTabs", "about:blank"),
      grouped: ws(),
      group: { kind: "group", placement: { parent: "grouped" }, content: {} },
      coloured: { ...ws(), appearance: { color: "blue", emoji: null } },
      withEmoji: { ...ws(), appearance: { color: null, emoji: "🌊" } },
      isolated: { ...ws(), lifecycle: { isolated: true } },
    },
  };
  const { json, dropped } = withoutUntouchedWorkspaces(JSON.stringify(doc));
  Assert.deepEqual(
    dropped.sort(),
    ["empty", "fresh", "freshTab"],
    "an unnamed workspace with nothing, or one fresh tab, is left behind"
  );
  const kept = JSON.parse(json);
  Assert.deepEqual(
    Object.keys(kept.nodes).sort(),
    [
      "browsed",
      "browsedTab",
      "coloured",
      "first",
      "group",
      "grouped",
      "isolated",
      "named",
      "namedTab",
      "second",
      "twoTabs",
      "withEmoji",
    ],
    "a name, a colour, an emoji, isolation, a visited page, a second tab or " +
      "a group keeps one"
  );
  Assert.deepEqual(kept.seen, doc.seen, "and the rest of the document stays");

  const { isUntouchedWorkspace } = SvalTree;
  Assert.deepEqual(
    Object.keys(doc.nodes).filter(id => isUntouchedWorkspace(doc.nodes, id)),
    ["fresh", "empty"],
    "one workspace at a time gets the same answer, as a closing window asks"
  );
  Assert.ok(
    !isUntouchedWorkspace(doc.nodes, "gone"),
    "and an id the document lacks is not untouched"
  );

  const nothing = JSON.stringify({ nodes: { named: ws("Work") } });
  Assert.equal(
    withoutUntouchedWorkspaces(nothing).json,
    nothing,
    "a document with nothing to leave is carried unchanged"
  );
});

/**
 * Moving a workspace in the switcher names the neighbours it lands between,
 * which the engine keys it between, and a move that changes nothing is no
 * change at all.
 */
add_task(function a_workspace_moves_between_its_new_neighbours() {
  const { moveWorkspaceOp } = SvalPanelModel;
  const order = ["a", "b", "c", "d"];
  const op = (before, after) => ({ kind: "moveWorkspace", before, after });
  Assert.deepEqual(
    moveWorkspaceOp(order, "d", "a", "before"),
    { ...op(null, "a"), id: "d" },
    "to the front"
  );
  Assert.deepEqual(
    moveWorkspaceOp(order, "a", "d", "after"),
    { ...op("d", null), id: "a" },
    "to the end"
  );
  Assert.deepEqual(
    moveWorkspaceOp(order, "a", "c", "before"),
    { ...op("b", "c"), id: "a" },
    "down, before a later one"
  );
  Assert.deepEqual(
    moveWorkspaceOp(order, "d", "b", "after"),
    { ...op("b", "c"), id: "d" },
    "up, after an earlier one"
  );
  for (const [id, target, side] of [
    ["b", "c", "before"],
    ["c", "b", "after"],
    ["b", "b", "before"],
    ["x", "b", "before"],
    ["b", "x", "after"],
  ]) {
    Assert.equal(
      moveWorkspaceOp(order, id, target, side),
      null,
      `${id} ${side} ${target} changes nothing`
    );
  }
});
