/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * SvalImportArc against a synthetic Arc install (import spec §4.2, §9): two
 * profiles, Spaces with nested folders, a split view and items import does
 * not carry, and Favorites.
 */

"use strict";

/* import-globals-from import_engine_head.js */

Services.prefs.setBoolPref("browser.migrate.chrome.extensions.enabled", false);

const Arc = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportArc.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { Sqlite } = ChromeUtils.importESModule(
  "resource://gre/modules/Sqlite.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { ChromeMigrationUtils } = ChromeUtils.importESModule(
  "resource:///modules/ChromeMigrationUtils.sys.mjs"
);

const tabItem = (id, url, title = "", savedTitle = null) => [
  id,
  {
    id,
    title,
    childrenIds: [],
    data: { tab: { savedURL: url, savedTitle } },
  },
];
const listItem = (id, title, childrenIds) => [
  id,
  { id, title, childrenIds, data: { list: {} } },
];
const containerItem = (id, childrenIds) => [
  id,
  { id, title: null, childrenIds, data: { itemContainer: {} } },
];

const ITEMS = [
  // Space "Home", default profile.
  containerItem("a-pinned", ["f1", "split", "welcome", "arc-tab"]),
  containerItem("a-unpinned", ["t6"]),
  listItem("f1", "Level 1", ["t1", "f2"]),
  tabItem("t1", "https://one.example/", "Renamed one", "Saved one"),
  listItem("f2", "Level 2", ["f3"]),
  listItem("f3", "Level 3", ["t2"]),
  tabItem("t2", "https://two.example/", "", "Two"),
  [
    "split",
    {
      id: "split",
      title: "Compare",
      childrenIds: ["t3", "t4"],
      data: { splitView: { itemWidthFactors: ["t3", 0.7, "t4", 0.3] } },
    },
  ],
  tabItem("t3", "https://three.example/", null, "Three"),
  tabItem("t4", "https://four.example/", null, "Four"),
  ["welcome", { id: "welcome", childrenIds: [], data: { welcomeToArc: {} } }],
  tabItem("arc-tab", "arc://settings", "", "Settings"),
  tabItem("t6", "https://six.example/", "", "Saved six"),
  // Space "Work", Profile 1.
  containerItem("b-pinned", ["t7"]),
  containerItem("b-unpinned", []),
  tabItem("t7", "https://seven.example/", "", "Seven"),
  // Favorites.
  containerItem("fav-default", ["t8", "ff"]),
  tabItem("t8", "https://eight.example/", "", "Eight"),
  listItem("ff", "Fav folder", ["t9"]),
  tabItem("t9", "https://nine.example/", "", "Nine"),
  containerItem("fav-p1", ["t10"]),
  tabItem("t10", "https://ten.example/", "", "Ten"),
].flat();

const PROFILE_1 = {
  custom: { _0: { directoryBasename: "Profile 1", machineID: "m" } },
};

const SPACES = [
  "space-home",
  {
    id: "space-home",
    title: "Home",
    profile: { default: true },
    containerIDs: ["unpinned", "a-unpinned", "pinned", "a-pinned"],
    customInfo: {
      iconType: { emoji_v2: "🏠" },
      windowTheme: {
        primaryColorPalette: {
          midTone: { red: 0.2, green: 0.4, blue: 0.9, alpha: 1 },
        },
      },
    },
  },
  "space-work",
  {
    id: "space-work",
    title: "Work",
    profile: PROFILE_1,
    containerIDs: ["pinned", "b-pinned", "unpinned", "b-unpinned"],
    customInfo: { iconType: { icon: "star.fill" } },
  },
  "space-bare",
  {
    id: "space-bare",
    title: "",
    profile: { default: {} },
    containerIDs: [{ pinned: {} }, "missing", { unpinned: {} }, "missing2"],
  },
];

const SIDEBAR = {
  version: 1,
  sidebar: {
    containers: [
      { global: {} },
      {
        spaces: SPACES,
        items: ITEMS,
        topAppsContainerIDs: [
          { default: true },
          "fav-default",
          PROFILE_1,
          "fav-p1",
        ],
      },
    ],
  },
};

const CHROMIUM_BOOKMARKS = {
  version: 1,
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks bar",
      children: [
        { type: "url", name: "Bar A", url: "https://a.example/" },
        {
          type: "folder",
          name: "Bar folder",
          children: [
            { type: "url", name: "Bar B", url: "https://b.example/" },
            { type: "url", name: "Bookmarklet", url: "javascript:void(0)" },
          ],
        },
      ],
    },
    other: {
      type: "folder",
      name: "Other",
      children: [{ type: "url", name: "Other C", url: "https://c.example/" }],
    },
    synced: { type: "folder", name: "Mobile", children: [] },
  },
};

const tab = (title, url) => ({ type: "tab", title, url });
const group = (name, children) => ({
  type: "group",
  name,
  color: null,
  children,
});
const split = (name, shares, children) => ({
  type: "split",
  name,
  shares,
  children,
});
const bookmark = (title, url) => ({ type: "bookmark", title, url });
const folder = (title, children) => ({ type: "folder", title, children });

let fixtureCount = 0;

async function freshDir() {
  const dir = PathUtils.join(
    do_get_profile().path,
    `arc-fixture-${++fixtureCount}`
  );
  await IOUtils.makeDirectory(dir);
  return dir;
}

async function makeSqlite(path, statements) {
  const db = await Sqlite.openConnection({ path });
  try {
    for (const [sql, params] of statements) {
      await db.execute(sql, params);
    }
  } finally {
    await db.close();
  }
}

/** A macOS-layout Arc install under a fake home. */
async function makeMacArc() {
  const home = await freshDir();
  const root = PathUtils.join(home, "Library", "Application Support", "Arc");
  const userData = PathUtils.join(root, "User Data");
  await IOUtils.makeDirectory(PathUtils.join(userData, "Default"));
  await IOUtils.makeDirectory(PathUtils.join(userData, "Profile 1"));
  await IOUtils.writeJSON(
    PathUtils.join(root, "StorableSidebar.json"),
    SIDEBAR
  );
  await IOUtils.writeJSON(PathUtils.join(userData, "Local State"), {
    profile: {
      info_cache: {
        Default: { name: "Person 1" },
        "Profile 1": { name: "Work" },
      },
    },
  });
  await IOUtils.writeJSON(
    PathUtils.join(userData, "Default", "Bookmarks"),
    CHROMIUM_BOOKMARKS
  );
  await makeSqlite(PathUtils.join(userData, "Default", "Login Data"), [
    ["CREATE TABLE logins (origin_url TEXT, password_value BLOB)"],
    ...[1, 2, 3].map(n => [
      "INSERT INTO logins VALUES (:u, :p)",
      { u: `https://login${n}.example/`, p: new Uint8Array([n]) },
    ]),
  ]);
  return { home, root, userData };
}

add_task(async function missing_arc_has_no_profiles() {
  const home = await freshDir();
  Assert.deepEqual(
    await Arc.findProfiles({ home, localAppData: home }),
    [],
    "no Arc directory, no profiles"
  );
});

add_task(async function finds_each_chromium_profile() {
  const { home, root, userData } = await makeMacArc();
  Assert.deepEqual(await Arc.findProfiles({ home, localAppData: null }), [
    {
      source: "arc",
      id: "Default",
      name: "Person 1",
      dir: PathUtils.join(userData, "Default"),
      root,
    },
    {
      source: "arc",
      id: "Profile 1",
      name: "Work",
      dir: PathUtils.join(userData, "Profile 1"),
      root,
    },
  ]);
});

add_task(async function harvests_the_default_profile() {
  const { home } = await makeMacArc();
  const [profile] = await Arc.findProfiles({ home });
  const harvest = await Arc.harvest(profile);
  Assert.deepEqual(harvest, {
    windows: [
      {
        kind: "space",
        source: "space-home",
        name: "Home",
        emoji: "🏠",
        color: "blue",
        children: [
          group("Level 1", [
            tab("Renamed one", "https://one.example/"),
            group("Level 2", [
              group("Level 3", [tab("Two", "https://two.example/")]),
            ]),
          ]),
          split(
            "Compare",
            [0.7, 0.3],
            [
              tab("Three", "https://three.example/"),
              tab("Four", "https://four.example/"),
            ]
          ),
          tab("Saved six", "https://six.example/"),
        ],
      },
      // The untitled Space holds nothing importable, so it is not offered.
    ],
    bookmarks: {
      toolbar: [
        // Arc's Favorites, pinned, then its bookmarks bar.
        { ...bookmark("Eight", "https://eight.example/"), pinned: true },
        {
          ...folder("Fav folder", [bookmark("Nine", "https://nine.example/")]),
          pinned: true,
        },
        bookmark("Bar A", "https://a.example/"),
        folder("Bar folder", [bookmark("Bar B", "https://b.example/")]),
      ],
      menu: [],
      other: [bookmark("Other C", "https://c.example/")],
    },
    logins: 3,
    encryptedSession: false,
    // welcomeToArc, the arc:// tab and the bookmarklet.
    skipped: 3, // No preferences file: archive after 7 days.
    autoArchive: "7d",
  });
});

/**
 * Arc's Favorites arrive as pinned Favorites, in Arc's order, in the batch
 * that adds them (pins spec §10); its bookmarks bar arrives unpinned.
 */
/**
 * The card Arc gave its user comes with the harvest, from the two files Arc
 * keeps beside its sidebar. Without them the rest still arrives.
 */
add_task(async function arcs_card_comes_with_the_harvest() {
  const { home, root } = await makeMacArc();
  let [profile] = await Arc.findProfiles({ home });
  Assert.equal((await Arc.harvest(profile)).arcCard, undefined, "no card yet");

  await IOUtils.writeJSON(PathUtils.join(root, "StorableMembershipCard.json"), {
    version: 1,
    shapeName: "Shape2",
    paletteNumber: 7,
    backgroundBlobInfo: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    title: "DEFIANT PERFECTIONIST",
  });
  await IOUtils.writeJSON(PathUtils.join(root, "StorableAuthState.json"), {
    session: {
      user: {
        createdAt: (Date.UTC(2022, 10, 1, 12) - Date.UTC(2001, 0, 1)) / 1000,
      },
    },
  });
  [profile] = await Arc.findProfiles({ home });
  const { arcCard, windows } = await Arc.harvest(profile);
  Assert.ok(windows.length, "the Spaces still arrive");
  Assert.equal(arcCard.title, "DEFIANT PERFECTIONIST");
  Assert.equal(arcCard.since, "2022-11-01");
  Assert.equal(arcCard.shape, 2);
  Assert.equal(arcCard.palette, 7);
});

add_task(async function arcs_favorites_arrive_pinned() {
  const { home } = await makeMacArc();
  const [profile] = await Arc.findProfiles({ home });
  const { store, report } = await importedFavorites(
    await Arc.harvest(profile),
    "arc"
  );
  Assert.equal(report.favorites, 5);
  Assert.deepEqual(
    store.home().map(tile => [tile.name, tile.kind]),
    [
      ["Eight", "favorite"],
      ["Fav folder", "folder"],
    ]
  );
  Assert.ok(
    !store.pinsWithUrl("https://a.example/").length,
    "the bookmarks bar is not pinned"
  );
  Assert.ok(
    !store.isFavorite("https://eight.example/"),
    "and a pin is no favorite"
  );
});

add_task(async function harvests_a_second_profile() {
  const { home } = await makeMacArc();
  const [, profile] = await Arc.findProfiles({ home });
  Assert.deepEqual(await Arc.harvest(profile), {
    windows: [
      {
        kind: "space",
        source: "space-work",
        name: "Work",
        emoji: null,
        color: null,
        children: [tab("Seven", "https://seven.example/")],
      },
    ],
    bookmarks: {
      toolbar: [{ ...bookmark("Ten", "https://ten.example/"), pinned: true }],
      menu: [],
      other: [],
    },
    logins: null,
    encryptedSession: false,
    skipped: 0, // No preferences file: archive after 7 days.
    autoArchive: "7d",
  });
});

// Arc 1.168's own files under a home in data/import/arc: a sidebar of two
// Spaces, with device ids, sync state and all but the primary palette of
// each Space's theme removed, and one profile with no Chromium files.
add_task(async function a_real_arc_install() {
  const home = do_get_file("data/import/arc").path;
  const root = PathUtils.join(home, "Library", "Application Support", "Arc");
  const profiles = await Arc.findProfiles({ home, localAppData: null });
  Assert.deepEqual(profiles, [
    {
      source: "arc",
      id: "Default",
      // "Your Arc" is a name Arc made up, so the profile has none.
      name: null,
      dir: PathUtils.join(root, "User Data", "Default"),
      root,
    },
  ]);
  // Both Spaces keep only pinned tabs. Main's are Arc's own starter folder,
  // whose split view of three panes lists the width of two; its Getting
  // Started item is skipped. The Favorites container is empty.
  const third = 0.33333333333333337;
  Assert.deepEqual(await Arc.harvest(profiles[0]), {
    windows: [
      {
        kind: "space",
        source: "08CD8B3D-1631-492A-8F2D-C7BA85FCBEAD",
        name: "3D Printing",
        emoji: "🖨️",
        color: "pink",
        children: [
          tab("MakerWorld", "https://makerworld.com/en"),
          tab("Thingiverse", "https://www.thingiverse.com/"),
          tab("Printables", "https://www.printables.com/"),
          tab(
            "Thangs",
            "https://thangs.com/search/multibin%20insert?scope=thangs&view=grid"
          ),
          tab("Shop - 3D Printing Deals", "https://3dprintingdeals.com/"),
        ],
      },
      {
        kind: "space",
        source: "thebrowser.company.defaultPersonalSpaceID",
        name: "Main",
        emoji: "🏠",
        color: "yellow",
        children: [
          group("Arc Basics", [
            tab("Arc Resources", "https://resources.arc.net/"),
            tab(
              "Import Logins & Bookmarks",
              "https://resources.arc.net/hc/en-us/articles/19335089616791-Import-Bookmarks-Logins-History-Extensions-from-Your-Previous-Browser"
            ),
            tab("Try Arc Max", "https://arc.net/max/tutorial"),
            split(
              null,
              [third, third, 1 - (third + third)],
              [
                tab(
                  "The Browser Company",
                  "https://www.youtube.com/@TheBrowserCompany/videos"
                ),
                tab(
                  "Keeping Tabs",
                  "https://browsercompany.substack.com/archive"
                ),
                {
                  ...tab("Arc", "https://twitter.com/arcinternet"),
                  emoji: "🌀",
                },
              ]
            ),
          ]),
        ],
      },
    ],
    bookmarks: null,
    logins: null,
    encryptedSession: false,
    skipped: 1, // No preferences file: archive after 7 days.
    autoArchive: "7d",
  });
});

// Arc 1.130 for Windows, installed from its package and set up through its
// own sidebar: the starter Space keeps Arc's starter folder, a folder of two
// tabs and a Split, and a second Space has a theme colour. One tab was
// archived from the starter Space. Sync state and device ids are removed.
add_task(async function a_real_windows_arc_install() {
  const localAppData = do_get_file("data/import/arc-windows").path;
  const root = PathUtils.join(
    localAppData,
    "Packages",
    "TheBrowserCompany.Arc_ttt1ap7aakyb4",
    "LocalCache",
    "Local",
    "Arc"
  );
  const profiles = await Arc.findProfiles({ home: null, localAppData });
  Assert.deepEqual(profiles, [
    {
      source: "arc",
      id: "Default",
      name: null,
      dir: PathUtils.join(root, "User Data", "Default"),
      root,
    },
  ]);
  // The starter Space has no name of its own; Arc shows it as "Space 1".
  const MAIN = "thebrowser.company.defaultPersonalSpaceID";
  const ARTICLES = "https://resources.arc.net/hc/en-us/articles/";
  const mdn = tab("MDN Web Docs", "https://developer.mozilla.org/en-US/");
  const linear = tab(
    "Linear \u2013 The system for product development",
    "https://linear.app/"
  );
  Assert.deepEqual(await Arc.harvest(profiles[0]), {
    windows: [
      {
        kind: "space",
        source: MAIN,
        name: null,
        emoji: null,
        color: null,
        children: [
          group("Arc Basics", [
            tab(
              "Pinned Tabs",
              `${ARTICLES}19231060187159-Pinned-Tabs-Tabs-you-want-to-stick-around`
            ),
            tab(
              "Spaces",
              `${ARTICLES}19228064149143-Spaces-Distinct-Browsing-Areas`
            ),
            tab(
              "Split View",
              `${ARTICLES}19335393146775-Split-View-View-Multiple-Tabs-at-Once`
            ),
            tab(
              "Import Bookmarks",
              `${ARTICLES}19335089616791-Import-Bookmarks-Logins-History-Extensions-from-Your-Previous-Browser`
            ),
            tab("Shortcuts", `${ARTICLES}20595231349911-Shortcuts`),
            tab(
              "The Browser Company",
              "https://www.youtube.com/@TheBrowserCompany/videos"
            ),
            split(null, null, [
              tab(
                "Keeping Tabs",
                "https://browsercompany.substack.com/archive"
              ),
              tab("Arc", "https://twitter.com/arcinternet"),
            ]),
          ]),
          group("trip", [
            tab("Fjord - Wikipedia", "https://en.wikipedia.org/wiki/Fjord"),
            tab(
              "OpenStreetMap",
              "https://www.openstreetmap.org/#map=4/38.01/-95.84"
            ),
          ]),
          mdn,
          linear,
          split(null, null, [
            tab("seriouseats.com", "https://www.seriouseats.com/"),
            tab(
              "NYT Cooking - Recipes and Cooking Guides From The New York Times",
              "https://cooking.nytimes.com/"
            ),
          ]),
        ],
      },
      {
        kind: "space",
        source: "385D595A-DAF7-4064-B9CE-6C565C6D3112",
        name: "work",
        emoji: null,
        color: "green",
        children: [
          mdn,
          linear,
          tab("Hacker News", "https://news.ycombinator.com/"),
        ],
      },
    ],
    bookmarks: {
      toolbar: [
        { ...bookmark("Gmail", "https://mail.google.com"), pinned: true },
        {
          ...bookmark("Google Calendar", "https://calendar.google.com"),
          pinned: true,
        },
      ],
      menu: [],
      other: [],
    },
    logins: null,
    encryptedSession: false,
    skipped: 0,
    autoArchive: "7d",
    archived: [
      {
        title: "Tents | REI Co-op",
        url: "https://www.rei.com/c/tents",
        closedAt: 1793660965504.8713,
        source: MAIN,
      },
    ],
  });
});

// Arc's SpaceModel lists a Space's containers in `newContainerIDs`, where an
// unpinned one is `shared` or a machine's and window's own (`desktop`), and
// keeps `containerIDs` as a legacy copy naming one of each. The reader takes
// every container the newer list names, and an item two of them list once.
// The `desktop` marker's payload here is a stand-in: the reader keys on the
// marker alone.
add_task(async function every_container_a_space_lists_imports() {
  const home = await freshDir();
  const root = PathUtils.join(home, "Library", "Application Support", "Arc");
  await IOUtils.makeDirectory(root, { createAncestors: true });
  await IOUtils.writeJSON(PathUtils.join(root, "StorableSidebar.json"), {
    version: 1,
    sidebar: {
      containers: [
        { global: {} },
        {
          spaces: [
            "s",
            {
              id: "s",
              title: "Several",
              profile: { default: true },
              containerIDs: ["unpinned", "shared", "pinned", "pinned-c"],
              newContainerIDs: [
                { unpinned: { _0: { shared: {} } } },
                "shared",
                { pinned: {} },
                "pinned-c",
                {
                  unpinned: {
                    _0: { desktop: { machineID: "m", windowID: "w" } },
                  },
                },
                "desktop-c",
              ],
            },
          ],
          items: [
            containerItem("pinned-c", ["p"]),
            containerItem("shared", ["u", "twice"]),
            containerItem("desktop-c", ["d", "twice"]),
            tabItem("p", "https://pinned.example/", "P"),
            tabItem("u", "https://shared.example/", "U"),
            tabItem("d", "https://desktop.example/", "D"),
            tabItem("twice", "https://twice.example/", "T"),
          ].flat(),
          topAppsContainerIDs: [],
        },
      ],
    },
  });
  const [profile] = await Arc.findProfiles({ home, localAppData: null });
  const { windows } = await Arc.harvest(profile);
  Assert.deepEqual(windows[0].children, [
    tab("P", "https://pinned.example/"),
    tab("U", "https://shared.example/"),
    tab("T", "https://twice.example/"),
    tab("D", "https://desktop.example/"),
  ]);
});

// Arc keeps the tabs it archived in StorableArchiveItems.json beside the
// sidebar, each entry naming the Space it left and when, in seconds from
// 2001-01-01, as a real install's file holds them.
add_task(async function archived_tabs_go_with_the_profile_of_their_space() {
  const { home, root } = await makeMacArc();
  const archivedTab = (id, space, url, archivedAt, title = null) => [
    id,
    {
      reason: "manual",
      source: { space: { _0: space } },
      archivedAt,
      sidebarItem: {
        id,
        title,
        childrenIds: [],
        data: { tab: { savedURL: url, savedTitle: `Saved ${id}` } },
      },
    },
  ];
  await IOUtils.writeJSON(PathUtils.join(root, "StorableArchiveItems.json"), {
    version: 1,
    items: [
      ...archivedTab(
        "a1",
        "space-home",
        "https://a1.example/",
        800000000,
        "A1"
      ),
      ...archivedTab("a2", "space-work", "https://a2.example/", 800000100),
      ...archivedTab("a3", "deleted-space", "https://a3.example/", 800000200),
      ...archivedTab("a4", "space-home", "arc://settings", 800000300),
      "a5",
      {
        source: { space: { _0: "space-home" } },
        archivedAt: 800000400,
        sidebarItem: { id: "a5", childrenIds: ["x"], data: { list: {} } },
      },
    ],
  });
  const [main, work] = await Arc.findProfiles({ home, localAppData: null });
  const mainHarvest = await Arc.harvest(main);
  Assert.deepEqual(mainHarvest.archived, [
    {
      title: "A1",
      url: "https://a1.example/",
      closedAt: (800000000 + 978307200) * 1000,
      source: "space-home",
    },
    {
      title: "Saved a3",
      url: "https://a3.example/",
      closedAt: (800000200 + 978307200) * 1000,
      source: null,
    },
  ]);
  Assert.equal(
    mainHarvest.windows.find(win => win.name === "Home").source,
    "space-home"
  );
  Assert.deepEqual((await Arc.harvest(work)).archived, [
    {
      title: "Saved a2",
      url: "https://a2.example/",
      closedAt: (800000100 + 978307200) * 1000,
      source: "space-work",
    },
  ]);
});

/**
 * Arc's preferences, as a property list under `Library/Preferences` in
 * `home`, holding `values`, each a string.
 *
 * @param {string} home
 * @param {object} values
 */
async function writeArcPreferences(home, values) {
  const dir = PathUtils.join(home, "Library", "Preferences");
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  const escape = text =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const entries = Object.entries(values)
    .map(
      ([key, value]) =>
        `<key>${escape(key)}</key><string>${escape(value)}</string>`
    )
    .join("");
  await IOUtils.writeUTF8(
    PathUtils.join(dir, "company.thebrowser.Browser.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">' +
      `<plist version="1.0"><dict>${entries}</dict></plist>`
  );
}

// Arc keeps its choice for archiving idle tabs in its macOS preferences
// (idle-tab archive spec §7.5): a profile's own entry, as a real file holds
// it, else the global one.
add_task(
  { skip_if: () => AppConstants.platform != "macosx" },
  async function arcs_archive_setting_comes_over() {
    const { home } = await makeMacArc();
    await writeArcPreferences(home, {
      autoArchiveTimeThreshold: "thirtyDays",
      autoArchiveTimeThresholdsPerProfile: JSON.stringify({
        thresholds: [{ default: {} }, "twelveHours"],
      }),
    });
    const [main, work] = await Arc.findProfiles({ home });
    Assert.equal(
      (await Arc.harvest(main)).autoArchive,
      "12h",
      "the default profile's own choice"
    );
    Assert.equal(
      (await Arc.harvest(work)).autoArchive,
      "30d",
      "a profile without one takes the global choice"
    );

    await writeArcPreferences(home, { autoArchiveTimeThreshold: "never" });
    Assert.equal(
      (await Arc.harvest(main)).autoArchive,
      "never",
      "and Never is carried as Never"
    );
  }
);

add_task(async function a_real_arc_split_imports_as_one_split() {
  const home = do_get_file("data/import/arc").path;
  const [profile] = await Arc.findProfiles({ home, localAppData: null });
  const [, main] = await importedTree(await Arc.harvest(profile), "arc");
  Assert.deepEqual(main, [
    {
      group: "Arc Basics",
      children: [
        "https://resources.arc.net/",
        "https://resources.arc.net/hc/en-us/articles/19335089616791-Import-Bookmarks-Logins-History-Extensions-from-Your-Previous-Browser",
        "https://arc.net/max/tutorial",
        {
          split: "",
          shares: [33.33, 33.33, 33.34],
          panes: [
            "https://www.youtube.com/@TheBrowserCompany/videos",
            "https://browsercompany.substack.com/archive",
            "https://twitter.com/arcinternet",
          ],
        },
      ],
    },
  ]);
});

add_task(async function a_named_split_keeps_its_name_and_widths() {
  const { home } = await makeMacArc();
  const [profile] = await Arc.findProfiles({ home });
  const [homeSpace] = await importedTree(await Arc.harvest(profile), "arc");
  Assert.deepEqual(
    homeSpace.find(node => node.split !== undefined),
    {
      split: "Compare",
      shares: [70, 30],
      panes: ["https://three.example/", "https://four.example/"],
    },
    "Arc's width factors are the split's shares"
  );
});

add_task(async function splits_hold_two_to_four_panes() {
  const { home, root } = await makeMacArc();
  const panes = [1, 2, 3, 4, 5].map(n => `p${n}`);
  const splitItem = (id, childrenIds) => [
    id,
    { id, title: null, childrenIds, data: { splitView: {} } },
  ];
  await IOUtils.writeJSON(PathUtils.join(root, "StorableSidebar.json"), {
    sidebar: {
      containers: [
        { global: {} },
        {
          spaces: SPACES.slice(0, 2),
          items: [
            containerItem("a-pinned", ["five", "one"]),
            splitItem("five", panes),
            ...panes.map(id => tabItem(id, `https://${id}.example/`)),
            // A split left with one pane Arc shows, beside a page import
            // does not carry.
            splitItem("one", ["alone", "settings"]),
            tabItem("alone", "https://alone.example/"),
            tabItem("settings", "arc://settings"),
          ].flat(),
        },
      ],
    },
  });
  const [profile] = await Arc.findProfiles({ home });
  const [homeSpace] = await importedTree(await Arc.harvest(profile), "arc");
  Assert.deepEqual(homeSpace, [
    {
      split: "",
      shares: null,
      panes: panes.slice(0, 4).map(id => `https://${id}.example/`),
    },
    "https://p5.example/",
    "https://alone.example/",
  ]);
});

add_task(async function windows_package_without_profiles() {
  const localAppData = await freshDir();
  const root = PathUtils.join(
    localAppData,
    "Packages",
    "TheBrowserCompany.Arc_ttt1ap7aakyb4",
    "LocalCache",
    "Local",
    "Arc"
  );
  await IOUtils.makeDirectory(root);
  await IOUtils.makeDirectory(
    PathUtils.join(localAppData, "Packages", "Some.Other_app")
  );
  // No `{global}` entry: the data container is found by its contents.
  await IOUtils.writeJSON(PathUtils.join(root, "StorableSidebar.json"), {
    sidebar: { containers: [{}, SIDEBAR.sidebar.containers[1]] },
  });
  const profiles = await Arc.findProfiles({ home: null, localAppData });
  Assert.deepEqual(profiles, [
    {
      source: "arc",
      id: "Default",
      name: null,
      dir: PathUtils.join(root, "User Data", "Default"),
      root,
    },
  ]);
  const harvest = await Arc.harvest(profiles[0]);
  Assert.deepEqual(
    harvest.windows.map(w => w.name),
    ["Home"],
    "the empty untitled Space is not offered"
  );
  Assert.deepEqual(harvest.bookmarks.other, []);
  Assert.equal(harvest.bookmarks.toolbar.length, 2, "Favorites only");
  Assert.equal(harvest.logins, null);
  Assert.equal(harvest.skipped, 2);
});

add_task(async function corrupt_sidebar_throws_cleanly() {
  const { home, root } = await makeMacArc();
  await IOUtils.writeUTF8(
    PathUtils.join(root, "StorableSidebar.json"),
    '{"sidebar": {"containers": [{"global": {}}, {"spa'
  );
  const [profile] = await Arc.findProfiles({ home });
  await Assert.rejects(
    Arc.harvest(profile),
    e => e.message == "sval: the Arc sidebar could not be read",
    "a sidebar mid-write is reported without a path"
  );

  await IOUtils.writeJSON(PathUtils.join(root, "StorableSidebar.json"), {
    sidebar: { containers: [{ global: {} }] },
  });
  await Assert.rejects(
    Arc.harvest(profile),
    /^Error: sval: the Arc sidebar could not be read$/,
    "a sidebar with no data container is unreadable too"
  );
});

add_task(async function imports_history_through_firefox() {
  const { home, userData } = await makeMacArc();
  const recent = ChromeMigrationUtils.dateToChromeTime(Date.now() - 86400000);
  await makeSqlite(PathUtils.join(userData, "Default", "History"), [
    [
      "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, " +
        "visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, " +
        "hidden INTEGER)",
    ],
    [
      "INSERT INTO urls (url, title, visit_count, typed_count, " +
        "last_visit_time, hidden) VALUES " +
        "('https://history-one.example/', 'One', 1, 0, :t, 0), " +
        "('https://history-two.example/', 'Two', 2, 1, :t, 0), " +
        "('https://hidden.example/', 'Hidden', 1, 0, :t, 1)",
      { t: recent },
    ],
  ]);
  const [profile, other] = await Arc.findProfiles({ home });
  Assert.equal(await Arc.importHistory(profile), 2);
  Assert.ok(await PlacesUtils.history.fetch("https://history-one.example/"));
  Assert.ok(await PlacesUtils.history.fetch("https://history-two.example/"));
  Assert.ok(!(await PlacesUtils.history.fetch("https://hidden.example/")));
  Assert.equal(
    await Arc.importHistory(other),
    0,
    "a profile with no History imports nothing"
  );
});
