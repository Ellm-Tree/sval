/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

/**
 * Which of the tree's tabs the address bar lists for what is typed, and in
 * what order (launcher spec §5, §6): every workspace's tabs, matched on the
 * start of a word of the title or address, this workspace's first and then
 * the most recently used.
 */

const { matchTabs, recentTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs"
);

/**
 * Two workspaces: Work, which the window shows, and Home.
 *
 * @returns {object} a `nodes` map.
 */
function twoWorkspaces() {
  return {
    work: node({ kind: "workspace", name: "Work", order: "40" }),
    home: node({ kind: "workspace", name: "Home", order: "80" }),
    cal: node({
      kind: "tab",
      name: "Calendar",
      parent: "home",
      order: "40",
      url: "https://calendar.example.com/week",
    }),
    music: node({
      kind: "tab",
      name: "Musica Viva",
      parent: "work",
      order: "40",
      url: "https://radio.example.org/",
    }),
    hub: node({
      kind: "tab",
      name: "Pull requests",
      parent: "work",
      order: "80",
      url: "https://github.com/sval/pulls",
    }),
  };
}

const never = () => null;

add_task(function a_word_start_of_the_title_matches() {
  const found = matchTabs(twoWorkspaces(), "ca", {
    currentWorkspaceId: "work",
    lastActive: never,
  });
  Assert.deepEqual(
    found.map(f => f.nodeId),
    ["cal"],
    "Calendar, and not Musica, where ca is inside a word"
  );
  Assert.deepEqual(
    found[0],
    {
      nodeId: "cal",
      workspaceId: "home",
      title: "Calendar",
      url: "https://calendar.example.com/week",
      strong: true,
    },
    "a prefix of a title word is a strong match"
  );
});

add_task(function the_host_matches() {
  const [hub] = matchTabs(twoWorkspaces(), "gi", {
    currentWorkspaceId: "work",
    lastActive: never,
  });
  Assert.equal(hub?.nodeId, "hub", "github.com is found by gi");
  Assert.ok(hub.strong, "a prefix of the host is a strong match");

  const [path] = matchTabs(twoWorkspaces(), "pulls", {
    currentWorkspaceId: "work",
    lastActive: never,
  });
  Assert.equal(path?.nodeId, "hub", "a word of the address matches");
  Assert.ok(!path.strong, "and is not strong");
});

add_task(function every_word_has_to_match() {
  const nodes = twoWorkspaces();
  const options = { currentWorkspaceId: "work", lastActive: never };
  Assert.deepEqual(
    matchTabs(nodes, "pull git", options).map(f => f.nodeId),
    ["hub"],
    "one word in the title and one in the host"
  );
  Assert.deepEqual(
    matchTabs(nodes, "pull calendar", options),
    [],
    "no tab has both"
  );
  Assert.deepEqual(matchTabs(nodes, "  ", options), [], "nothing typed");
});

add_task(function an_archived_tab_never_matches() {
  const nodes = twoWorkspaces();
  nodes.old = {
    ...node({
      kind: "tab",
      name: "Calendar archive",
      parent: "home",
      order: "c0",
      url: "https://calendar.example.com/archive",
    }),
    kind: "archived",
  };
  Assert.deepEqual(
    matchTabs(nodes, "calendar", {
      currentWorkspaceId: "work",
      lastActive: never,
    }).map(f => f.nodeId),
    ["cal"],
    "only the open tab"
  );
});

add_task(function this_workspace_comes_first_then_the_most_recent() {
  const nodes = twoWorkspaces();
  nodes.cal2 = node({
    kind: "tab",
    name: "Calendar for work",
    parent: "work",
    order: "c0",
    url: "https://calendar.example.com/team",
  });
  nodes.cal3 = node({
    kind: "tab",
    name: "Calendar of holidays",
    parent: "home",
    order: "80",
    url: "https://holidays.example.net/",
  });
  const when = { cal: 300, cal2: 100, cal3: 200 };
  const found = matchTabs(nodes, "cal", {
    currentWorkspaceId: "work",
    lastActive: id => when[id] ?? null,
  });
  Assert.deepEqual(
    found.map(f => f.nodeId),
    ["cal2", "cal", "cal3"],
    "this workspace's match first, though used longest ago, then by use"
  );
  Assert.deepEqual(
    matchTabs(nodes, "cal", {
      currentWorkspaceId: "work",
      lastActive: id => when[id] ?? null,
      limit: 2,
    }).map(f => f.nodeId),
    ["cal2", "cal"],
    "the limit holds"
  );
});

add_task(function the_tab_on_screen_is_not_offered() {
  Assert.deepEqual(
    matchTabs(twoWorkspaces(), "ca", {
      currentWorkspaceId: "home",
      lastActive: never,
      exclude: "cal",
    }),
    [],
    "switching to the tab already shown would do nothing"
  );
});

add_task(function a_private_window_lists_its_own_tabs_only() {
  // Every private window has a workspace of its own in one tree
  // (`SvalPrivateSession`).
  const nodes = {
    mine: node({ kind: "workspace", name: "Private", order: "40" }),
    theirs: node({ kind: "workspace", name: "Private", order: "80" }),
    a: node({
      kind: "tab",
      name: "Calendar",
      parent: "mine",
      order: "40",
      url: "https://calendar.example.com/",
    }),
    b: node({
      kind: "tab",
      name: "Calendar",
      parent: "theirs",
      order: "40",
      url: "https://calendar.example.com/other",
    }),
  };
  Assert.deepEqual(
    matchTabs(nodes, "ca", {
      currentWorkspaceId: "mine",
      lastActive: never,
      onlyCurrent: true,
    }).map(f => f.nodeId),
    ["a"],
    "only the window's own workspace"
  );
});

add_task(function nothing_typed_lists_the_most_recent_tabs_everywhere() {
  const when = { cal: 300, music: 100, hub: 200 };
  Assert.deepEqual(
    recentTabs(twoWorkspaces(), {
      lastActive: id => when[id] ?? null,
      limit: 2,
    }).map(f => [f.nodeId, f.workspaceId]),
    [
      ["cal", "home"],
      ["hub", "work"],
    ],
    "by use across workspaces, within the limit"
  );
});
