/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const M = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportModel.sys.mjs"
);
const { PRESETS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

const tab = (title, url) => ({ type: "tab", title, url });
const group = (name, color, children) => ({
  type: "group",
  name,
  color,
  children,
});
const win = (children, extra = {}) => ({
  kind: "window",
  name: null,
  emoji: null,
  color: null,
  children,
  ...extra,
});

function minter() {
  let n = 0;
  return () => `id-${++n}`;
}

const WORDS = {
  window: n => `Chrome Window ${n}`,
  workspace: n => `Edge Workspace ${n}`,
};

add_task(function chromium_colours_map_one_to_one() {
  Assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(M.chromiumColor), [
    "gray",
    "blue",
    "red",
    "yellow",
    "green",
    "pink",
    "purple",
    "cyan",
    "orange",
  ]);
  Assert.equal(M.chromiumColor(42), "gray", "an unknown value draws grey");
  for (const value of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    Assert.ok(PRESETS.includes(M.chromiumColor(value)), "a token sval draws");
  }
});

add_task(function an_rgb_colour_maps_to_its_nearest_token() {
  Assert.equal(M.nearestColor({ red: 0.9, green: 0.1, blue: 0.1 }), "red");
  Assert.equal(M.nearestColor({ red: 0.1, green: 0.3, blue: 0.9 }), "blue");
  Assert.equal(M.nearestColor({ red: 0.2, green: 0.8, blue: 0.2 }), "green");
  Assert.equal(M.nearestColor({ red: 0.5, green: 0.5, blue: 0.52 }), "gray");
  Assert.equal(M.nearestColor({ red: 0.95, green: 0.4, blue: 0.75 }), "pink");
  Assert.equal(M.nearestColor(null), null);
  Assert.equal(M.nearestColor({ red: "x", green: 0, blue: 0 }), null);
});

add_task(function a_window_becomes_a_workspace_with_its_groups_in_order() {
  const harvest = {
    windows: [
      win([
        tab("A", "https://a.example/"),
        group("Work", "blue", [tab("B", "https://b.example/")]),
        tab("C", "https://c.example/"),
      ]),
    ],
    bookmarks: null,
  };
  const { ops, workspaces } = M.planTree(
    harvest,
    { windows: [{ import: true, name: "Chrome Window 1" }], bookmarks: "none" },
    { mintId: minter() }
  );
  Assert.deepEqual(workspaces, ["id-1"]);
  Assert.deepEqual(ops, [
    { kind: "addWorkspace", id: "id-1", name: "Chrome Window 1", icon: null },
    {
      kind: "addTab",
      id: "id-2",
      parent: "id-1",
      name: "A",
      url: "https://a.example/",
    },
    { kind: "addGroup", id: "id-3", parent: "id-1", name: "Work", icon: null },
    {
      kind: "setAppearance",
      id: "id-3",
      color: "blue",
      emoji: null,
    },
    {
      kind: "addTab",
      id: "id-4",
      parent: "id-3",
      name: "B",
      url: "https://b.example/",
    },
    {
      kind: "addTab",
      id: "id-5",
      parent: "id-1",
      name: "C",
      url: "https://c.example/",
    },
  ]);
});

add_task(
  function an_unticked_window_is_left_behind_and_a_cleared_name_writes_none() {
    const harvest = {
      windows: [win([tab("A", "https://a.example/")]), win([])],
      bookmarks: null,
    };
    const { ops } = M.planTree(
      harvest,
      {
        windows: [
          { import: false, name: "x" },
          { import: true, name: "   " },
        ],
        bookmarks: "none",
      },
      { mintId: minter() }
    );
    Assert.deepEqual(ops, [
      { kind: "addWorkspace", id: "id-1", name: "", icon: null },
    ]);
  }
);

add_task(function a_space_keeps_its_emoji_and_colour() {
  const harvest = {
    windows: [
      win([], { kind: "space", name: "Home", emoji: "🏠", color: "green" }),
    ],
    bookmarks: null,
  };
  const { ops } = M.planTree(
    harvest,
    { windows: [{ import: true, name: "Home" }], bookmarks: "none" },
    { mintId: minter() }
  );
  Assert.deepEqual(ops, [
    { kind: "addWorkspace", id: "id-1", name: "Home", icon: null },
    { kind: "setAppearance", id: "id-1", color: "green", emoji: "🏠" },
  ]);
});

add_task(function a_tab_keeps_its_emoji() {
  const harvest = {
    windows: [
      win([
        { ...tab("Chat", "https://chat.example/"), emoji: "🌀" },
        tab("Plain", "https://plain.example/"),
      ]),
    ],
    bookmarks: null,
  };
  const { ops } = M.planTree(
    harvest,
    { windows: [{ import: true, name: "W" }], bookmarks: "none" },
    { mintId: minter() }
  );
  Assert.deepEqual(ops, [
    { kind: "addWorkspace", id: "id-1", name: "W", icon: null },
    {
      kind: "addTab",
      id: "id-2",
      parent: "id-1",
      name: "Chat",
      url: "https://chat.example/",
    },
    { kind: "setAppearance", id: "id-2", color: null, emoji: "🌀" },
    {
      kind: "addTab",
      id: "id-3",
      parent: "id-1",
      name: "Plain",
      url: "https://plain.example/",
    },
  ]);
});

add_task(function archived_tabs_name_the_workspace_their_window_filled() {
  const harvest = {
    windows: [
      win([], { kind: "space", name: "Kept", source: "s1" }),
      win([], { kind: "space", name: "Declined", source: "s2" }),
      win([], { kind: "space", name: "Also kept", source: "s3" }),
    ],
    archived: [
      { title: "One", url: "https://1.example/", closedAt: 5, source: "s1" },
      { title: "Two", url: "https://2.example/", closedAt: 6, source: "s2" },
      { title: null, url: "https://3.example/", closedAt: 7, source: "s3" },
      { title: "Gone", url: "https://4.example/", closedAt: 8, source: null },
    ],
  };
  const entries = M.planArchived(
    harvest,
    [
      { import: true, name: "Kept" },
      { import: false, name: "Declined" },
      { import: true, name: "Renamed" },
    ],
    ["ws-1", "ws-3"],
    { mintId: () => "nowhere" }
  );
  Assert.deepEqual(entries, [
    {
      title: "One",
      url: "https://1.example/",
      workspace: "ws-1",
      workspaceName: "Kept",
      closedAt: 5,
    },
    {
      title: "",
      url: "https://3.example/",
      workspace: "ws-3",
      workspaceName: "Renamed",
      closedAt: 7,
    },
    {
      title: "Gone",
      url: "https://4.example/",
      workspace: "nowhere",
      workspaceName: "",
      closedAt: 8,
    },
  ]);
});

add_task(function the_first_launch_workspace_takes_the_first_window() {
  const harvest = {
    windows: [win([tab("A", "https://a.example/")]), win([])],
    bookmarks: null,
  };
  const { ops, workspaces } = M.planTree(
    harvest,
    {
      windows: [
        { import: true, name: "One" },
        { import: true, name: "Two" },
      ],
      bookmarks: "none",
    },
    { mintId: minter(), reuseWorkspace: "first" }
  );
  Assert.deepEqual(workspaces, ["first", "id-2"]);
  Assert.deepEqual(ops[0], { kind: "rename", id: "first", name: "One" });
  Assert.equal(ops[1].parent, "first", "its tab goes into the reused one");
  Assert.deepEqual(ops[2], {
    kind: "addWorkspace",
    id: "id-2",
    name: "Two",
    icon: null,
  });
});

add_task(function bookmarks_into_a_workspace_become_groups_and_tabs() {
  const harvest = {
    windows: [],
    bookmarks: {
      toolbar: [{ type: "bookmark", title: "T", url: "https://t.example/" }],
      menu: [
        {
          type: "folder",
          title: "Recipes",
          children: [
            { type: "bookmark", title: "R", url: "https://r.example/" },
          ],
        },
      ],
      other: [],
    },
  };
  const { ops } = M.planTree(
    harvest,
    { windows: [], bookmarks: "workspace", bookmarksName: "Chrome Bookmarks" },
    { mintId: minter() }
  );
  Assert.deepEqual(
    ops.map(o => [o.kind, o.parent ?? null, o.name]),
    [
      ["addWorkspace", null, "Chrome Bookmarks"],
      ["addTab", "id-1", "T"],
      ["addGroup", "id-1", "Recipes"],
      ["addTab", "id-3", "R"],
    ]
  );
});

add_task(
  function names_are_suggested_per_kind_and_kept_when_the_source_has_one() {
    const names = M.suggestNames(
      [
        win([], { kind: "edgeWorkspace" }),
        win([]),
        win([], { kind: "edgeWorkspace" }),
        win([], { kind: "space", name: "Work" }),
        win([]),
      ],
      WORDS
    );
    Assert.deepEqual(names, [
      "Edge Workspace 1",
      "Chrome Window 1",
      "Edge Workspace 2",
      "Work",
      "Chrome Window 2",
    ]);
  }
);

add_task(function favorites_skip_known_urls_and_empty_folders() {
  const roots = {
    toolbar: [
      { type: "bookmark", title: "Known", url: "https://known.example/" },
      { type: "bookmark", title: "New", url: "https://new.example/" },
      { type: "bookmark", title: "Broken", url: "https://[bad" },
    ],
    menu: [
      {
        type: "folder",
        title: "All known",
        children: [
          { type: "bookmark", title: "Again", url: "https://new.example/" },
        ],
      },
    ],
    other: [],
  };
  const plan = M.planFavorites(roots, new Set(["https://known.example/"]));
  Assert.deepEqual(
    plan.favorites,
    [{ title: "New", url: "https://new.example/" }],
    "a folder left empty is not made, nor the menu holding only it"
  );
  Assert.equal(plan.skipped, 3, "known, repeated and unparsable");
});

/**
 * Favorites is one tree: the source's toolbar is its top level, and its menu
 * and other bookmarks are folders in it. Another browser's import, kept as
 * folders each holding only the next, arrives as its innermost folder, and a
 * folder that holds anything beside its one folder stays.
 */
add_task(function favorites_fold_folders_that_only_hold_a_folder() {
  const mark = n => ({
    type: "bookmark",
    title: `Page ${n}`,
    url: `https://example.com/${n}`,
  });
  const folder = (title, children) => ({ type: "folder", title, children });
  const roots = {
    toolbar: [
      mark(1),
      folder("Imported bookmarks", [
        folder("Bookmarks Bar", [
          folder("Imported From Elsewhere", [
            mark(2),
            folder("Bookmarks Bar", [mark(3)]),
          ]),
        ]),
      ]),
    ],
    menu: [folder("Wrapper", [folder("Empty", [])])],
    other: [mark(4), folder("Reading List", [mark(5)])],
  };
  const plan = M.planFavorites(roots, new Set());
  const place = n => ({ title: `Page ${n}`, url: `https://example.com/${n}` });
  Assert.deepEqual(plan.favorites, [
    place(1),
    {
      title: "Imported From Elsewhere",
      type: M.FOLDER,
      children: [
        place(2),
        { title: "Bookmarks Bar", type: M.FOLDER, children: [place(3)] },
      ],
    },
    {
      title: "Other Bookmarks",
      type: M.FOLDER,
      children: [
        place(4),
        { title: "Reading List", type: M.FOLDER, children: [place(5)] },
      ],
    },
  ]);
});

add_task(function favorites_match_urls_as_places_spells_them() {
  const roots = {
    toolbar: [
      { type: "bookmark", title: "Known", url: "HTTPS://Known.EXAMPLE" },
      { type: "bookmark", title: "New", url: "https://New.example" },
      { type: "bookmark", title: "Again", url: "https://new.example/" },
      // Within Places' limit as spelled, past it once percent-encoded.
      {
        type: "bookmark",
        title: "Long",
        url: `https://long.example/${"\u00e9".repeat(30000)}`,
      },
    ],
    menu: [],
    other: [],
  };
  const plan = M.planFavorites(roots, new Set(["https://known.example/"]));
  Assert.deepEqual(plan.favorites, [
    { title: "New", url: "https://new.example/" },
  ]);
  Assert.equal(plan.skipped, 3, "known, repeated and too long to store");
});

add_task(function counts_cover_every_level() {
  const harvest = {
    windows: [
      win([
        tab("A", "u"),
        group("G", null, [tab("B", "u"), group("H", null, [])]),
        // A split is its tabs, and no group.
        { type: "split", name: null, shares: null, children: [tab("C", "u")] },
      ]),
    ],
    bookmarks: {
      toolbar: [{ type: "bookmark", title: "x", url: "u" }],
      menu: [
        {
          type: "folder",
          title: "f",
          children: [{ type: "bookmark", title: "y", url: "u" }],
        },
      ],
      other: [],
    },
  };
  Assert.deepEqual(M.countHarvest(harvest), {
    windows: 1,
    tabs: 3,
    groups: 2,
    bookmarks: 2,
  });
});

/**
 * A window's preview lists every group, nested ones by their path, each with
 * only the tabs directly inside it, and the tabs in no group.
 */
add_task(function a_preview_flattens_nested_groups_into_paths() {
  const preview = M.windowPreview(
    win([
      tab("Loose", "https://l.example/"),
      group("Inspiration", null, [
        tab("A", "https://a.example/"),
        group("Type", null, [
          group("Specimens", null, [tab("S", "https://s.example/")]),
          tab("T", "https://t.example/"),
        ]),
      ]),
      group("Work", "cyan", []),
      {
        type: "split",
        name: null,
        shares: null,
        children: [tab("P1", "https://p1.example/"), tab("P2", "u")],
      },
    ])
  );
  Assert.deepEqual(
    preview.groups.map(g => [g.path.join(" › "), g.color, g.tabs.length]),
    [
      ["Inspiration", null, 1],
      ["Inspiration › Type", null, 1],
      ["Inspiration › Type › Specimens", null, 1],
      ["Work", "cyan", 0],
    ]
  );
  Assert.deepEqual(
    preview.loose.map(t => t.title),
    ["Loose", "P1", "P2"],
    "a split's tabs are listed where it stands"
  );
});

add_task(function only_web_and_file_urls_are_carried() {
  for (const url of [
    "https://a.example/",
    "http://a.example/",
    "file:///tmp/x",
  ]) {
    Assert.ok(M.importableUrl(url), url);
  }
  for (const url of [
    "chrome://settings/",
    "arc://newtab",
    "edge://newtab",
    "about:blank",
    "javascript:alert(1)",
    "",
    null,
  ]) {
    Assert.ok(!M.importableUrl(url), String(url));
  }
});

add_task(function a_file_on_another_machine_is_not_carried() {
  for (const url of [
    "file:///Users/me/notes.html",
    "file:///C:/Users/me/notes.html",
    "file:/home/me/notes.html",
  ]) {
    Assert.ok(M.importableUrl(url), url);
  }
  // Each opens as \\host\share on Windows.
  for (const url of [
    "file:////host/share/x",
    "file://///host/share/x",
    "FILE://///host/share/x",
    "file:\\\\\\\\host\\share\\x",
    "file:///\\\\host\\share\\x",
    "file:///%5C%5Chost/share/x",
    "file:///%2F%2Fhost/share/x",
  ]) {
    Assert.ok(!M.importableUrl(url), url);
  }
});

add_task(function the_report_says_what_arrived() {
  const report = (workspaces, favorites, failed = [], history = 0) => ({
    workspaces,
    favorites,
    failed,
    tabs: 0,
    history,
  });
  const both = M.importReportText(report(["a", "b", "c"], 1210));
  Assert.stringContains(both, "3", "the workspaces are counted");
  Assert.stringContains(
    both,
    (1210).toLocaleString(),
    "and the favorites, in the locale's digits"
  );
  const one = M.importReportText(report(["a"], 0));
  Assert.stringContains(one, "1");
  const nothing = M.importReportText(report([], 0));
  Assert.ok(nothing, "an import that brought nothing says so");
  Assert.ok(!/\d/.test(nothing), "without a count");
  Assert.stringContains(
    M.importReportText(report([], 1, ["arc"])),
    "1",
    "a browser that failed has a line of its own"
  );
  Assert.notEqual(
    M.importReportText(report([], 1)),
    M.importReportText(report(["a"], 0)),
    "a favorite and a workspace are told apart"
  );
  const withHistory = M.importReportText(report(["a", "b", "c"], 40, [], 1210));
  Assert.stringContains(withHistory, "40");
  Assert.ok(
    !withHistory.includes((1210).toLocaleString()) &&
      !withHistory.includes("1210"),
    "history is said without a count"
  );
  Assert.notEqual(
    M.importReportText(report(["a"], 0, [], 5)),
    one,
    "history is said when it came"
  );
  const historyAlone = M.importReportText(report([], 0, [], 5));
  Assert.ok(
    historyAlone && historyAlone !== nothing,
    "history alone is something new"
  );
});

/**
 * Messages spec §7's table: which buttons each kind of failure offers, and a
 * line of its own for each, naming the browser.
 */
add_task(function failure_line_for_each_kind() {
  const commands = line => line.actions.map(action => action.command);
  const data = M.importFailureLine("Chrome", "data");
  const open = M.importFailureLine("Chrome", "open");
  const history = M.importFailureLine("Chrome", "history");
  Assert.deepEqual(commands(data), ["importBookmarksFile", "sendReport"]);
  Assert.deepEqual(commands(open), ["retrySource", "importBookmarksFile"]);
  Assert.deepEqual(commands(history), ["retrySource"]);
  for (const line of [data, open, history]) {
    Assert.stringContains(line.text, "Chrome", "the line names the browser");
    Assert.ok(
      line.actions.every(action => action.label),
      "every button is labelled"
    );
  }
  Assert.equal(
    new Set([data.text, open.text, history.text]).size,
    3,
    "each kind has its own line"
  );
});

/**
 * Each window chosen isolated fills an isolated workspace, the reused
 * first-launch one included, and a window left shared fills a shared one
 * (isolated workspaces spec §8).
 */
add_task(function each_window_chosen_isolated_fills_an_isolated_workspace() {
  const harvest = {
    windows: [win([tab("A", "https://a.example/")]), win([]), win([])],
    bookmarks: null,
  };
  const { ops } = M.planTree(
    harvest,
    {
      windows: [
        { import: true, name: "One", isolated: true },
        { import: true, name: "Two", isolated: false },
        { import: true, name: "Three", isolated: true },
      ],
      bookmarks: "none",
    },
    { mintId: minter(), reuseWorkspace: "first" }
  );
  Assert.deepEqual(
    ops.filter(op => op.kind !== "addTab"),
    [
      { kind: "rename", id: "first", name: "One" },
      { kind: "setIsolation", id: "first", isolated: true },
      { kind: "addWorkspace", id: "id-2", name: "Two", icon: null },
      {
        kind: "addWorkspace",
        id: "id-3",
        name: "Three",
        icon: null,
        isolated: true,
      },
    ]
  );
});

/**
 * A profile is a workspace (import spec §3): a lone profile's plain windows
 * land in one workspace named for the browser, each window a group when
 * there are several, and a workspace the browser already keeps stays one.
 */
add_task(function a_profiles_windows_land_in_one_workspace() {
  const edgeWorkspace = win([tab("W", "https://w.example/")], {
    kind: "edgeWorkspace",
  });
  const harvest = {
    windows: [
      win([tab("A", "https://a.example/")]),
      edgeWorkspace,
      win([group("G", "red", [tab("B", "https://b.example/")])]),
    ],
    bookmarks: null,
    logins: 2,
    encryptedSession: false,
    skipped: 1,
  };
  const profile = { source: "edge", id: "Default", name: null, dir: "/x" };
  const combined = M.combineProfiles([{ profile, harvest }], "Edge");
  Assert.deepEqual(combined.windows, [
    {
      kind: "profile",
      name: "Edge",
      emoji: null,
      color: null,
      profile: "Default",
      children: [
        group("Window 1", null, [tab("A", "https://a.example/")]),
        group("Window 2", null, [
          group("G", "red", [tab("B", "https://b.example/")]),
        ]),
      ],
    },
    { ...edgeWorkspace, profile: "Default" },
  ]);
  Assert.equal(combined.logins, 2);
  Assert.equal(combined.skipped, 1);
  Assert.deepEqual(combined.parts, [{ profile, bookmarks: null }]);
  Assert.deepEqual(M.suggestNames(combined.windows, WORDS), [
    "Edge",
    "Edge Workspace 1",
  ]);
});

/** Several profiles: each is named for itself, and one window is not wrapped. */
add_task(function each_of_several_profiles_is_named_for_itself() {
  const one = (id, name, url, bookmarks = null) => ({
    profile: { source: "chrome", id, name, dir: `/${id}` },
    harvest: {
      windows: [win([tab("T", url)])],
      bookmarks,
      logins: null,
      encryptedSession: false,
      skipped: 0,
    },
  });
  const work = {
    toolbar: [{ type: "bookmark", title: "W", url: "https://w.example/" }],
    menu: [],
    other: [],
  };
  const combined = M.combineProfiles(
    [
      one("Default", null, "https://a.example/"),
      one("Profile 1", "Work", "https://b.example/", work),
    ],
    "Chrome"
  );
  Assert.deepEqual(
    combined.windows.map(w => [w.name, w.profile, w.children]),
    [
      ["Default", "Default", [tab("T", "https://a.example/")]],
      ["Work", "Profile 1", [tab("T", "https://b.example/")]],
    ]
  );
  Assert.deepEqual(combined.bookmarks, work);
  Assert.equal(combined.logins, null, "no profile counted any");
});

/**
 * A source's pins are a tree of their own (pins-root spec §7), in the
 * source's order, and nothing in Favorites. A pin is skipped only for an
 * address already a pin, so an address already a favorite still arrives as
 * a pin.
 */
add_task(function pinned_marks_are_pins() {
  const roots = {
    toolbar: [
      {
        type: "bookmark",
        title: "Mail",
        url: "https://mail.example/",
        pinned: true,
      },
      { type: "bookmark", title: "Bar", url: "https://bar.example/" },
      {
        type: "folder",
        title: "Dev",
        pinned: true,
        children: [
          { type: "bookmark", title: "Repo", url: "https://repo.example/" },
          { type: "bookmark", title: "CI", url: "https://ci.example/" },
        ],
      },
      {
        type: "bookmark",
        title: "Old",
        url: "https://known.example/",
        pinned: true,
      },
      {
        type: "bookmark",
        title: "Pinned already",
        url: "https://pinned.example/",
        pinned: true,
      },
    ],
    menu: [],
    other: [],
  };
  const plan = M.planFavorites(
    roots,
    new Set(["https://known.example/"]),
    new Set(["https://pinned.example/"])
  );
  Assert.deepEqual(
    plan.pins.map(entry => entry.title),
    ["Mail", "Dev", "Old"],
    "the pinned favorite and folder, and a favorite's address, as pins"
  );
  Assert.deepEqual(
    plan.pins[1].children.map(entry => entry.title),
    ["Repo", "CI"],
    "a pinned folder whole"
  );
  Assert.deepEqual(
    plan.favorites.map(entry => entry.title),
    ["Bar"],
    "and no pin in Favorites"
  );
  Assert.equal(plan.skipped, 1, "the address already a pin");
});

/**
 * A profile's history goes to the workspace its plain windows landed in
 * (decision 1287), and to none when the profile also keeps Spaces, Tab
 * Groups or Workspaces of its own, which no browser records per visit, or
 * when its windows stayed behind.
 */
add_task(function each_profiles_history_goes_to_its_own_workspace() {
  const harvestOf = windows => ({
    windows,
    bookmarks: null,
    logins: null,
    encryptedSession: false,
    skipped: 0,
  });
  const part = (id, windows) => ({
    profile: { source: "chrome", id, name: id, dir: `/${id}` },
    harvest: harvestOf(windows),
  });
  const combined = M.combineProfiles(
    [
      part("Plain", [win([tab("A", "https://a.example/")])]),
      part("Spaces", [
        win([tab("B", "https://b.example/")]),
        win([tab("S", "https://s.example/")], { kind: "space" }),
      ]),
      part("Left", [win([tab("C", "https://c.example/")])]),
    ],
    "Chrome"
  );
  const choices = {
    windows: combined.windows.map(w => ({
      import: w.profile !== "Left",
      name: w.name ?? "",
    })),
    bookmarks: M.BOOKMARKS_TO.none,
  };
  const { workspaces } = M.planTree(combined, choices, { mintId: minter() });
  Assert.equal(workspaces.length, 3, "Plain, Spaces' plain windows, a Space");

  Assert.deepEqual(M.historyWorkspaces(combined, choices.windows, workspaces), {
    Plain: workspaces[0],
  });
});

/** An Arc or Zen profile holds Spaces alone: its history goes to none. */
add_task(function a_profile_of_spaces_alone_sends_its_history_to_none() {
  const combined = M.combineProfiles(
    [
      {
        profile: { source: "arc", id: "Default", name: null, dir: "/arc" },
        harvest: {
          windows: [
            win([tab("S", "https://s.example/")], { kind: "space" }),
            win([tab("T", "https://t.example/")], { kind: "space" }),
          ],
          bookmarks: null,
          logins: null,
          encryptedSession: false,
          skipped: 0,
        },
      },
    ],
    "Arc"
  );
  const windows = combined.windows.map(w => ({
    import: true,
    name: w.name ?? "",
  }));
  const { workspaces } = M.planTree(
    combined,
    { windows, bookmarks: M.BOOKMARKS_TO.none },
    { mintId: minter() }
  );
  Assert.deepEqual(M.historyWorkspaces(combined, windows, workspaces), {});
});
