/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from import_engine_head.js */

const { defaultRoots, findProfiles, harvest, importHistory, insertPages } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalImportFirefox.sys.mjs"
  );
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { harvestBrowser } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
);
const { runImport } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImport.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { Sqlite } = ChromeUtils.importESModule(
  "resource://gre/modules/Sqlite.sys.mjs"
);

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

do_get_profile();

const DAY_MS = 86400000;

function makeRoot(name) {
  return makeTempDir(`sval-ff-${name}`);
}

const entry = (url, title) => ({ url, title });

const SESSION = {
  windows: [
    {
      tabs: [
        // Pinned tabs come first in Firefox's tab array and import as tabs.
        {
          entries: [entry("https://pinned.example/", "Pinned")],
          index: 1,
          pinned: true,
        },
        {
          entries: [
            entry("https://a.example/old", "Old"),
            entry("https://a.example/now", "A now"),
          ],
          index: 2,
        },
        {
          entries: [entry("https://g1.example/", "G1")],
          index: 1,
          groupId: "g1",
        },
        { entries: [entry("about:config", "Config")], index: 1, groupId: "g1" },
        {
          entries: [entry("https://g2.example/", "G2")],
          index: 1,
          groupId: "g1",
        },
        { entries: [entry("https://b.example/", "B")], index: 1 },
        {
          entries: [entry("https://c.example/", "C")],
          index: 1,
          groupId: "g2",
        },
        { entries: [entry("about:newtab", "")], index: 1, groupId: "g3" },
      ],
      groups: [
        { id: "g1", name: "Work", color: "cyan", collapsed: false },
        { id: "g2", name: "", color: "not-a-colour", collapsed: true },
        { id: "g3", name: "Empty", color: "red", collapsed: false },
      ],
    },
    {
      isPrivate: true,
      tabs: [{ entries: [entry("https://secret.example/", "S")], index: 1 }],
    },
    {
      tabs: [
        { entries: [entry("https://second.example/", "Second")], index: 1 },
      ],
    },
  ],
};

const EXPECTED_WINDOWS = [
  {
    kind: "window",
    name: null,
    emoji: null,
    color: null,
    children: [
      { type: "tab", title: "Pinned", url: "https://pinned.example/" },
      { type: "tab", title: "A now", url: "https://a.example/now" },
      {
        type: "group",
        name: "Work",
        color: "cyan",
        children: [
          { type: "tab", title: "G1", url: "https://g1.example/" },
          { type: "tab", title: "G2", url: "https://g2.example/" },
        ],
      },
      { type: "tab", title: "B", url: "https://b.example/" },
      {
        type: "group",
        name: null,
        color: null,
        children: [{ type: "tab", title: "C", url: "https://c.example/" }],
      },
    ],
  },
  {
    kind: "window",
    name: null,
    emoji: null,
    color: null,
    children: [
      { type: "tab", title: "Second", url: "https://second.example/" },
    ],
  },
];

/**
 * A places.sqlite with the columns the reader reads: Places' roots by their
 * fixed guids, a few bookmarks, and visits at the given ages in days.
 *
 * @param {string} dir The profile directory to write it in.
 */
async function makePlaces(dir) {
  const db = await Sqlite.openConnection({
    path: PathUtils.join(dir, "places.sqlite"),
  });
  try {
    await db.execute(
      "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, guid TEXT)"
    );
    await db.execute(
      `CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER,
         fk INTEGER, parent INTEGER, position INTEGER, title TEXT, guid TEXT)`
    );
    await db.execute(
      `CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY,
         place_id INTEGER, visit_date INTEGER, visit_type INTEGER)`
    );
    const places = [
      [1, "https://tool.example/", "Tool page"],
      [2, "https://menu.example/", "Menu page"],
      [3, "https://nested.example/", "Nested page"],
      [4, "javascript:void(0)", "Bookmarklet"],
      [5, "https://unfiled.example/", "Unfiled page"],
      [6, "https://mobile.example/", "Mobile page"],
      [7, "https://tagged.example/", "Tagged page"],
      [8, "https://history.example/", "History page"],
      [9, "https://old.example/", "Old page"],
      [10, "about:robots", "Robots"],
    ];
    for (const [id, url, title] of places) {
      await db.execute(
        "INSERT INTO moz_places (id, url, title, guid) VALUES (?, ?, ?, ?)",
        [id, url, title, `place${id}`.padEnd(12, "_")]
      );
    }
    // [id, type, fk, parent, position, title, guid]
    const marks = [
      [1, 2, null, 0, 0, "", "root________"],
      [2, 2, null, 1, 0, "menu", "menu________"],
      [3, 2, null, 1, 1, "toolbar", "toolbar_____"],
      [4, 2, null, 1, 2, "tags", "tags________"],
      [5, 2, null, 1, 3, "unfiled", "unfiled_____"],
      [6, 2, null, 1, 4, "mobile", "mobile______"],
      // Toolbar: a folder after a bookmark, given out of id order.
      [11, 2, null, 3, 1, "Folder", "folder000001"],
      [10, 1, 1, 3, 0, "Tool", "bookmark0001"],
      [12, 1, 3, 11, 0, "Nested", "bookmark0002"],
      [13, 3, null, 11, 1, null, "separator001"],
      [14, 1, 4, 11, 2, "Bookmarklet", "bookmark0003"],
      [20, 1, 2, 2, 0, "Menu", "bookmark0004"],
      [30, 1, 5, 5, 0, "Unfiled", "bookmark0005"],
      [31, 1, 6, 6, 0, null, "bookmark0006"],
      // A tag folder and its entry are not bookmarks.
      [40, 2, null, 4, 0, "tagname", "tag000000001"],
      [41, 1, 7, 40, 0, null, "tagentry0001"],
    ];
    for (const row of marks) {
      await db.execute(
        `INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row
      );
    }
    const now = Date.now();
    // [place, age in days, visit_type]
    const visits = [
      [8, 1, 1],
      [8, 2, 2],
      [3, 10, 1],
      [9, 400, 1],
      [10, 1, 1],
    ];
    for (const [place, age, type] of visits) {
      await db.execute(
        "INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)",
        [place, (now - age * DAY_MS) * 1000, type]
      );
    }
  } finally {
    await db.close();
  }
}

const EXPECTED_BOOKMARKS = {
  toolbar: [
    { type: "bookmark", title: "Tool", url: "https://tool.example/" },
    {
      type: "folder",
      title: "Folder",
      children: [
        { type: "bookmark", title: "Nested", url: "https://nested.example/" },
      ],
    },
  ],
  menu: [{ type: "bookmark", title: "Menu", url: "https://menu.example/" }],
  other: [
    { type: "bookmark", title: "Unfiled", url: "https://unfiled.example/" },
    { type: "bookmark", title: "", url: "https://mobile.example/" },
  ],
};

async function makeFirefox(name) {
  const root = await makeRoot(name);
  const rel = PathUtils.join(root, "Profiles", "abc.default-release");
  const abs = PathUtils.join(root, "elsewhere");
  await IOUtils.makeDirectory(rel);
  await IOUtils.makeDirectory(abs);
  await IOUtils.writeUTF8(
    PathUtils.join(root, "profiles.ini"),
    [
      "[Install4F96D1932A9F858E]",
      "Default=Profiles/abc.default-release",
      "",
      "[Profile1]",
      "Name=Second",
      "IsRelative=0",
      `Path=${abs}`,
      "",
      "[Profile0]",
      "Name=default-release",
      "IsRelative=1",
      "Path=Profiles/abc.default-release",
      "Default=1",
      "",
      "[Profile2]",
      "Name=sval itself",
      "IsRelative=0",
      `Path=${PathUtils.profileDir}`,
      "",
      "[Profile3]",
      "Name=Gone",
      "IsRelative=1",
      "Path=Profiles/missing",
      "",
      "[General]",
      "StartWithLastProfile=1",
      "Version=2",
      "",
    ].join("\r\n")
  );
  return { root, rel, abs };
}

add_task(async function profiles_are_listed_from_profiles_ini() {
  const { root, rel, abs } = await makeFirefox("list");
  Assert.deepEqual(await findProfiles([root]), [
    { source: "firefox", id: abs, name: "Second", dir: abs },
    {
      source: "firefox",
      id: "Profiles/abc.default-release",
      name: "default-release",
      dir: rel,
    },
  ]);
});

add_task(async function a_missing_firefox_lists_nothing() {
  const root = await makeRoot("none");
  Assert.deepEqual(await findProfiles([root]), []);
  Assert.deepEqual(
    await findProfiles([PathUtils.join(root, "does-not-exist")]),
    []
  );
});

add_task(async function harvest_reads_windows_groups_and_bookmarks() {
  const { root, rel } = await makeFirefox("harvest");
  await IOUtils.makeDirectory(PathUtils.join(rel, "sessionstore-backups"));
  await IOUtils.writeJSON(
    PathUtils.join(rel, "sessionstore-backups", "recovery.jsonlz4"),
    SESSION,
    { compress: true }
  );
  // The shutdown session is only read when no recovery file exists.
  await IOUtils.writeJSON(
    PathUtils.join(rel, "sessionstore.jsonlz4"),
    { windows: [] },
    { compress: true }
  );
  await makePlaces(rel);
  const before = await IOUtils.getChildren(rel);

  const [profile] = (await findProfiles([root])).filter(p => p.dir === rel);
  Assert.deepEqual(await harvest(profile), {
    windows: EXPECTED_WINDOWS,
    bookmarks: EXPECTED_BOOKMARKS,
    logins: null,
    encryptedSession: false,
    // about:config, about:newtab and the bookmarklet.
    skipped: 3,
  });
  Assert.deepEqual(
    (await IOUtils.getChildren(rel)).sort(),
    before.sort(),
    "the source profile is left as it was"
  );
});

// A profile as Firefox 158 left it at shutdown, in data/import/firefox: its
// session with form data, storage, cookies, favicons and closed tabs
// removed, and its places.sqlite with a few visits deleted and its unread
// tables emptied. Both windows hold a tab group.
const REAL_PROFILE = do_get_file("data/import/firefox").path;

const tab = (title, url) => ({ type: "tab", title, url });
const tabGroup = (name, color, children) => ({
  type: "group",
  name,
  color,
  children,
});
const plainWindow = children => ({
  kind: "window",
  name: null,
  emoji: null,
  color: null,
  children,
});
const bookmark = (title, url) => ({ type: "bookmark", title, url });

async function listRealProfile() {
  const root = await makeRoot("real");
  await IOUtils.writeUTF8(
    PathUtils.join(root, "profiles.ini"),
    `[Profile0]\nName=main\nIsRelative=0\nPath=${REAL_PROFILE}\nDefault=1\n`
  );
  return findProfiles([root]);
}

add_task(async function a_real_firefox_profile() {
  const profiles = await listRealProfile();
  Assert.deepEqual(profiles, [
    { source: "firefox", id: REAL_PROFILE, name: "main", dir: REAL_PROFILE },
  ]);
  Assert.deepEqual(await harvest(profiles[0]), {
    windows: [
      plainWindow([
        tab("hello network", "https://hello.com/"),
        tab(
          "Not Wine, Not Beer: The Ingredient That Makes Pot Roast Extra Delicious | The Kitchn",
          "https://www.thekitchn.com/korean-bbq-sauce-pot-roast-23847028?utm_source=firefox-newtab-en-us"
        ),
        tabGroup("GREY", "gray", [
          tab("Wikipedia", "https://www.wikipedia.org/"),
        ]),
        tab(
          "Explore | Travel Made Easy, Vacations, Planning Advice",
          "https://www.explore.com/"
        ),
      ]),
      plainWindow([
        tabGroup("PINK GRP", "pink", [
          tab("Reddit - The heart of the internet", "https://www.reddit.com/"),
          tab(
            "Associated Press News: Breaking News, Latest Headlines and Videos | AP News",
            "https://apnews.com/"
          ),
        ]),
        tab("YouTube", "https://www.youtube.com/"),
      ]),
    ],
    // Firefox's own default bookmarks, and one the user added to the toolbar.
    bookmarks: {
      toolbar: [
        bookmark(
          "Explore | Travel Made Easy, Vacations, Planning Advice",
          "https://www.explore.com/"
        ),
      ],
      menu: [
        {
          type: "folder",
          title: "Mozilla Firefox",
          children: [
            bookmark(
              "Get Help",
              "https://support.mozilla.org/products/firefox"
            ),
            bookmark(
              "Customize Firefox",
              "https://support.mozilla.org/kb/customize-firefox-controls-buttons-and-toolbars?utm_source=firefox-browser&utm_medium=default-bookmarks&utm_campaign=customize"
            ),
            bookmark("Get Involved", "https://www.mozilla.org/contribute/"),
            bookmark("About Us", "https://www.mozilla.org/about/"),
          ],
        },
      ],
      other: [],
    },
    logins: null,
    encryptedSession: false,
    skipped: 0,
  });
});

add_task(async function a_real_firefox_profiles_history() {
  // The fixture's visits are from 2026-10-16, so the window reaches them
  // whatever day this runs.
  Services.prefs.setIntPref("browser.migrate.history.maxAgeInDays", 365000);
  await PlacesUtils.history.clear();
  const [profile] = await listRealProfile();
  let imported;
  try {
    imported = await importHistory(profile);
  } finally {
    Services.prefs.clearUserPref("browser.migrate.history.maxAgeInDays");
  }

  // Nine visits to eight pages, redirects included.
  Assert.equal(imported, 8);
  const youtube = await PlacesUtils.history.fetch("https://www.youtube.com/", {
    includeVisits: true,
  });
  Assert.equal(youtube.title, "YouTube");
  Assert.equal(youtube.visits.length, 2);
  for (const url of [
    "https://apnews.com/",
    "http://hello.com/",
    "https://hello.com/",
    "https://www.wikipedia.org/",
    "http://explore.com/",
    "https://explore.com/",
    "https://www.explore.com/",
  ]) {
    Assert.ok(await PlacesUtils.history.hasVisits(url), url);
  }
  await PlacesUtils.history.clear();
});

add_task(async function the_shutdown_session_is_read_without_a_recovery_file() {
  const root = await makeRoot("clean");
  await IOUtils.writeJSON(
    PathUtils.join(root, "sessionstore.jsonlz4"),
    {
      windows: [
        { tabs: [{ entries: [entry("https://x.example/", "X")], index: 1 }] },
      ],
    },
    { compress: true }
  );
  const result = await harvest({
    source: "firefox",
    id: "x",
    name: null,
    dir: root,
  });
  Assert.deepEqual(result.windows, [
    {
      kind: "window",
      name: null,
      emoji: null,
      color: null,
      children: [{ type: "tab", title: "X", url: "https://x.example/" }],
    },
  ]);
  Assert.equal(result.bookmarks, null, "no places.sqlite, no bookmarks");
});

add_task(async function a_corrupt_session_throws_a_clean_error() {
  const root = await makeRoot("corrupt");
  await IOUtils.writeUTF8(
    PathUtils.join(root, "sessionstore.jsonlz4"),
    "https://leak.example/ not lz4"
  );
  await Assert.rejects(
    harvest({ source: "firefox", id: "x", name: null, dir: root }),
    e =>
      /^Firefox \w+ could not be \w+ \(\w+\)$/.test(e.message) &&
      !e.message.includes("leak") &&
      !e.message.includes(root)
  );
});

add_task(async function a_corrupt_places_throws_a_clean_error() {
  const root = await makeRoot("corrupt-places");
  await IOUtils.writeUTF8(PathUtils.join(root, "places.sqlite"), "not sqlite");
  await Assert.rejects(
    harvest({ source: "firefox", id: "x", name: null, dir: root }),
    e =>
      /^Firefox \w+ could not be \w+ \(\w+\)$/.test(e.message) &&
      !e.message.includes(root)
  );
});

add_task(async function history_is_inserted_into_places() {
  const root = await makeRoot("history");
  await makePlaces(root);
  const profile = { source: "firefox", id: "x", name: null, dir: root };

  // history.example has two visits, nested.example one; old.example is past
  // the window and about:robots is not importable.
  Assert.equal(await importHistory(profile), 2);

  const page = await PlacesUtils.history.fetch("https://history.example/", {
    includeVisits: true,
  });
  Assert.equal(page.title, "History page");
  Assert.equal(page.visits.length, 2);
  Assert.ok(await PlacesUtils.history.hasVisits("https://nested.example/"));
  Assert.ok(!(await PlacesUtils.history.hasVisits("https://old.example/")));
  Assert.ok(!(await PlacesUtils.history.hasVisits("about:robots")));
});

add_task(async function history_honours_the_max_age_pref() {
  const root = await makeRoot("history-age");
  await makePlaces(root);
  await PlacesUtils.history.clear();
  Services.prefs.setIntPref("browser.migrate.history.maxAgeInDays", 5);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.migrate.history.maxAgeInDays")
  );
  Assert.equal(
    await importHistory({ source: "firefox", id: "x", name: null, dir: root }),
    1
  );
  Assert.ok(!(await PlacesUtils.history.hasVisits("https://nested.example/")));
});

add_task(async function history_without_places_inserts_nothing() {
  const root = await makeRoot("history-none");
  Assert.equal(
    await importHistory({ source: "firefox", id: "x", name: null, dir: root }),
    0
  );
});

/**
 * A history Places takes none of is a failure, so the import says history
 * failed; one it takes some of counts what it took.
 */
add_task(async function history_places_refuses_whole_is_a_failure() {
  // Places stores no `about:` page (`nsNavHistory::CanAddURI`).
  const refused = n =>
    Array.from({ length: n }, (_, i) => ({
      url: `about:robots?${i}`,
      visits: [
        { date: new Date(), transition: PlacesUtils.history.TRANSITIONS.LINK },
      ],
    }));
  await Assert.rejects(
    insertPages(refused(2)),
    err => err.code === "history_refused",
    "a history Places took none of rejects"
  );

  await PlacesUtils.history.clear();
  // A whole batch refused, then a page Places takes in the next batch.
  const pages = [
    ...refused(500),
    {
      url: "https://taken.example/",
      visits: [
        { date: new Date(), transition: PlacesUtils.history.TRANSITIONS.LINK },
      ],
    },
  ];
  Assert.equal(await insertPages(pages), 1, "the page Places took counts");
  Assert.ok(await PlacesUtils.history.hasVisits("https://taken.example/"));
});

/**
 * A bookmark a running Firefox has written to its write-ahead log and not yet
 * checkpointed into `places.sqlite` still arrives in Favorites.
 */
add_task(async function a_running_firefoxs_newest_bookmark_imports() {
  const favorites = await emptyFavorites();
  const root = await makeRoot("running");
  await makePlaces(root);
  const path = PathUtils.join(root, "places.sqlite");
  // Firefox holds places.sqlite open in WAL mode while it runs.
  const running = await Sqlite.openConnection({ path });
  try {
    await running.execute("PRAGMA journal_mode = WAL");
    await running.execute("PRAGMA wal_autocheckpoint = 0");
    await running.execute(
      "INSERT INTO moz_places (id, url, title, guid) VALUES (50, 'https://newest.example/', 'Newest', 'place50_____')"
    );
    await running.execute(
      `INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid)
       VALUES (50, 1, 50, 3, 2, 'Newest', 'bookmark0050')`
    );
    Assert.greater(
      (await IOUtils.stat(`${path}-wal`)).size,
      0,
      "the bookmark is only in the write-ahead log"
    );

    const profile = { source: "firefox", id: "x", name: null, dir: root };
    const report = await runImport(
      [
        {
          browser: { source: profile.source, profiles: [profile] },
          harvest: await harvestBrowser({
            source: profile.source,
            profiles: [profile],
          }),
          windows: [],
          bookmarks: "favorites",
          bookmarksName: "Firefox",
          history: false,
        },
      ],
      { engine: { mutate: async () => null }, favorites }
    );
    Assert.deepEqual(report.failed, []);
    const [newest] = favorites.favoritesWithUrl("https://newest.example/");
    Assert.equal(newest?.parentGuid, "toolbar_____");
    Assert.equal(
      favorites.favoritesWithUrl("https://tool.example/").length,
      1,
      "the older bookmarks arrive with it"
    );
  } finally {
    await running.close();
  }
});

add_task(function firefox_is_looked_for_in_each_linux_package() {
  if (AppConstants.platform === "macosx" || AppConstants.platform === "win") {
    Assert.equal(defaultRoots().length, 1, AppConstants.platform);
    return;
  }
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const roots = defaultRoots().map(root => root.slice(home.length + 1));
  for (const packaged of [
    "snap/firefox/common/.mozilla/firefox",
    ".var/app/org.mozilla.firefox/.mozilla/firefox",
    ".var/app/org.mozilla.firefox/config/mozilla/firefox",
  ]) {
    Assert.ok(roots.includes(packaged), packaged);
  }
});
