/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from import_engine_head.js */

const { findProfiles, harvest, importHistory } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportOrion.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { Sqlite } = ChromeUtils.importESModule(
  "resource://gre/modules/Sqlite.sys.mjs"
);
const { findBrowsers, harvestBrowser } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
);
const { runImport } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImport.sys.mjs"
);

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

do_get_profile();

const DAY_MS = 86400000;

const esc = s =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A JS value as an XML plist fragment. Orion writes binary property lists;
// PropertyListUtils reads both forms into the same values.
function plist(value) {
  if (Array.isArray(value)) {
    return `<array>${value.map(plist).join("")}</array>`;
  }
  if (typeof value === "boolean") {
    return value ? "<true/>" : "<false/>";
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `<integer>${value}</integer>`
      : `<real>${value}</real>`;
  }
  if (typeof value === "object") {
    return `<dict>${Object.entries(value)
      .map(([k, v]) => `<key>${esc(k)}</key>${plist(v)}`)
      .join("")}</dict>`;
  }
  return `<string>${esc(String(value))}</string>`;
}

function writePlist(path, value) {
  return IOUtils.writeUTF8(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${plist(value)}</plist>`
  );
}

const orionTab = (tabId, url, title, extra = {}) => ({
  isActive: false,
  isPinned: false,
  localTabIdentifier: `TAB-${tabId}`,
  tabId,
  title,
  url,
  ...extra,
});

// Shaped as a real Orion 1.0 profile's files.
const BROWSER_STATE = [
  {
    index: 0,
    isPrivate: false,
    localWindowID: "WIN-1",
    windowID: 1,
    windowName: "Window 1",
    tabStates: [
      orionTab(2, "https://a.example/", "A"),
      orionTab(3, "orion://newtab/", "Start Page", { isActive: true }),
      orionTab(4, "https://b.example/", "B", { isPinned: true }),
    ],
  },
  {
    index: 1,
    isPrivate: true,
    windowID: 2,
    windowName: "Window 2",
    tabStates: [orionTab(5, "https://secret.example/", "S")],
  },
];

const item = (id, parentId, index, type, title, url) => ({
  dateAdded: 1792190885173.6,
  id,
  index,
  ...(parentId === null ? {} : { parentId }),
  title,
  type,
  ...(url ? { url } : {}),
});

const FAVOURITES = {
  0: item("0", null, 0, "folder", ""),
  1: item("1", "0", 1, "folder", "Bookmarks Bar"),
  2: item("2", "0", 2, "folder", "Bookmarks"),
  3: item("3", "0", 0, "folder", "Favorites"),
  10: item("10", "1", 1, "folder", "Nested"),
  11: item("11", "10", 0, "bookmark", "Deep", "https://deep.example/"),
  12: item("12", "1", 0, "bookmark", "Bar", "https://bar.example/"),
  13: item("13", "2", 0, "bookmark", "Other", "https://other.example/"),
  14: item("14", "2", 1, "bookmark", "Script", "javascript:void(0)"),
  103: item("103", "3", 1, "bookmark", "Feedback", "https://orionfeedback.org"),
  104: item("104", "3", 0, "bookmark", "Guide", "https://help.kagi.com/orion/"),
};

async function makeOrion(name) {
  const root = await makeTempDir(`sval-orion-${name}`);
  const dir = PathUtils.join(root, "Defaults");
  await IOUtils.makeDirectory(dir);
  return { root, dir };
}

add_task(async function profiles_come_from_the_profiles_file() {
  const { root, dir } = await makeOrion("profiles");
  const work = PathUtils.join(root, "ABC-123");
  await IOUtils.makeDirectory(work);
  await writePlist(PathUtils.join(root, "profiles"), {
    defaults: { color: 3, identifier: "Defaults", name: "Primary" },
    profiles: [
      { color: 1, identifier: "ABC-123", name: "Work" },
      { color: 2, identifier: "GONE", name: "Deleted" },
    ],
  });
  Assert.deepEqual(await findProfiles([root]), [
    { source: "orion", id: "Defaults", name: "Primary", dir },
    { source: "orion", id: "ABC-123", name: "Work", dir: work },
  ]);

  // Without the file, the default profile is still there.
  const bare = await makeOrion("bare");
  Assert.deepEqual(await findProfiles([bare.root]), [
    { source: "orion", id: "Defaults", name: null, dir: bare.dir },
  ]);
  Assert.deepEqual(
    await findProfiles([PathUtils.join(bare.root, "absent")]),
    []
  );
});

add_task(async function harvest_reads_windows_and_bookmarks() {
  const { dir } = await makeOrion("harvest");
  await writePlist(PathUtils.join(dir, "browser_state.plist"), BROWSER_STATE);
  await writePlist(PathUtils.join(dir, "favourites.plist"), FAVOURITES);
  const h = await harvest({ source: "orion", id: "Defaults", dir });
  Assert.deepEqual(h.windows, [
    {
      kind: "window",
      name: null,
      emoji: null,
      color: null,
      children: [
        { type: "tab", title: "A", url: "https://a.example/" },
        { type: "tab", title: "B", url: "https://b.example/" },
      ],
    },
  ]);
  Assert.deepEqual(h.bookmarks, {
    toolbar: [
      { type: "bookmark", title: "Guide", url: "https://help.kagi.com/orion/" },
      { type: "bookmark", title: "Feedback", url: "https://orionfeedback.org" },
      { type: "bookmark", title: "Bar", url: "https://bar.example/" },
      {
        type: "folder",
        title: "Nested",
        children: [
          { type: "bookmark", title: "Deep", url: "https://deep.example/" },
        ],
      },
    ],
    menu: [],
    other: [
      { type: "bookmark", title: "Other", url: "https://other.example/" },
    ],
  });
  Assert.equal(h.logins, null, "Orion's keychain is never read");
  Assert.equal(h.skipped, 2, "the start page and the bookmarklet");
});

// Orion 1.1.3's own binary property lists, in data/import/orion: two
// profiles, each with one window and Orion's default Favorites. Each tab's
// archived WebKit session state is removed.
add_task(async function a_real_orion_install() {
  const root = do_get_file("data/import/orion").path;
  const second = "163B64B3-444F-49BC-B50E-22A59AE0A1B9";
  const profiles = await findProfiles([root]);
  Assert.deepEqual(profiles, [
    {
      source: "orion",
      id: "Defaults",
      name: "Primary",
      dir: PathUtils.join(root, "Defaults"),
    },
    {
      source: "orion",
      id: second,
      name: "The Orange One",
      dir: PathUtils.join(root, second),
    },
  ]);

  const tab = (title, url) => ({ type: "tab", title, url });
  const orionWindow = children => ({
    kind: "window",
    name: null,
    emoji: null,
    color: null,
    children,
  });
  const kagi = tab(
    "Kagi - Reclaim the Web & Restore Your Privacy",
    "https://kagi.com/"
  );
  // The Favorites folder sorts before the empty Bookmarks Bar, and its
  // bookmarks sort by their index, not by their ids.
  const bookmarks = {
    toolbar: [
      {
        type: "bookmark",
        title: "Orion User Guide",
        url: "https://help.kagi.com/orion/index.html",
      },
      {
        type: "bookmark",
        title: "Orion Feedback",
        url: "https://orionfeedback.org",
      },
    ],
    menu: [],
    other: [],
  };

  Assert.deepEqual(await harvest(profiles[0]), {
    windows: [orionWindow([tab("Google", "https://www.google.com/"), kagi])],
    bookmarks,
    logins: null,
    encryptedSession: false,
    // The start page.
    skipped: 1,
  });
  Assert.deepEqual(await harvest(profiles[1]), {
    windows: [
      orionWindow([
        tab("wikipedia - Kagi Search", "https://kagi.com/search?q=wikipedia"),
        tab("YESTERDAY™ iYour 1-stop resource!", "https://yesterday.com/"),
        kagi,
      ]),
    ],
    bookmarks,
    logins: null,
    encryptedSession: false,
    skipped: 0,
  });
});

// Orion is one browser however many profiles it keeps, and each profile
// is a workspace (import spec §3): the real install above is one thing to
// import from, and importing it brings one workspace per profile, named for
// the profile, with the Favorites both profiles share arriving once.
add_task(async function a_real_orion_install_is_one_browser() {
  const root = do_get_file("data/import/orion").path;
  const browsers = await findBrowsers({ orion: [root] });
  Assert.equal(browsers.length, 1, "one Orion");
  const [orion] = browsers;
  Assert.equal(orion.profiles.length, 2, "with both its profiles");

  const combined = await harvestBrowser(orion);
  Assert.deepEqual(
    combined.windows.map(win => [win.kind, win.name, win.profile]),
    [
      ["profile", "Primary", "Defaults"],
      ["profile", "The Orange One", "163B64B3-444F-49BC-B50E-22A59AE0A1B9"],
    ],
    "one workspace per profile, named for it"
  );

  const favorites = await emptyFavorites();
  const mutations = [];
  const engine = {
    async mutate(op) {
      mutations.push(op);
    },
  };
  let n = 0;
  const report = await runImport(
    [
      {
        browser: orion,
        harvest: combined,
        windows: combined.windows.map(win => ({
          import: true,
          name: win.name,
        })),
        bookmarks: "favorites",
        bookmarksName: "Orion Bookmarks",
        history: false,
      },
    ],
    { engine, favorites, mintId: () => `id-${++n}` }
  );
  Assert.deepEqual(report.failed, []);
  Assert.equal(report.workspaces.length, 2, "two workspaces");
  const ops = mutations.flatMap(batch => batch.ops);
  Assert.deepEqual(
    ops.filter(op => op.kind === "addWorkspace").map(op => op.name),
    ["Primary", "The Orange One"]
  );
  const tabsIn = id =>
    ops
      .filter(op => op.kind === "addTab" && op.parent === id)
      .map(op => op.url);
  const [primary, orange] = report.workspaces;
  Assert.deepEqual(tabsIn(primary), [
    "https://www.google.com/",
    "https://kagi.com/",
  ]);
  Assert.deepEqual(tabsIn(orange), [
    "https://kagi.com/search?q=wikipedia",
    "https://yesterday.com/",
    "https://kagi.com/",
  ]);
  Assert.equal(report.favorites, 2, "the shared Favorites arrive once");
  Assert.equal(
    favorites.all().filter(row => row.kind === "favorite").length,
    2,
    "and the document holds them once"
  );
});

add_task(async function a_corrupt_file_throws_a_clean_error() {
  const { dir } = await makeOrion("corrupt");
  await IOUtils.writeUTF8(
    PathUtils.join(dir, "browser_state.plist"),
    "https://leak.example/"
  );
  await Assert.rejects(
    harvest({ source: "orion", id: "Defaults", dir }),
    e =>
      /^Orion \w+ could not be read \(\w+\)$/.test(e.message) &&
      !e.message.includes("leak") &&
      !e.message.includes(dir)
  );
});

add_task(async function history_is_inserted_into_places() {
  const { dir } = await makeOrion("history");
  const db = await Sqlite.openConnection({
    path: PathUtils.join(dir, "history"),
  });
  const sqlTime = ms =>
    new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  try {
    // Orion's own schema, trimmed to what the reader reads.
    await db.execute(
      `CREATE TABLE history_items (ID INTEGER PRIMARY KEY AUTOINCREMENT,
         URL TEXT, TITLE TEXT, HOST TEXT,
         LAST_VISIT_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         VISIT_COUNT INTEGER, TYPED_COUNT INTEGER)`
    );
    await db.execute(
      `CREATE TABLE visits (ID INTEGER PRIMARY KEY AUTOINCREMENT,
         HISTORY_ITEM_ID INTEGER,
         VISIT_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         REFERRING_VISIT_ID INTEGER, TRANSITION_TYPE TEXT)`
    );
    const items = [
      [1, "https://orion-history.example/", "Recent"],
      [2, "https://orion-old.example/", "Old"],
      [3, "orion://settings/", "Settings"],
    ];
    for (const row of items) {
      await db.execute(
        "INSERT INTO history_items (ID, URL, TITLE) VALUES (?, ?, ?)",
        row
      );
    }
    const now = Date.now();
    const visits = [
      [1, 1, "typed"],
      [1, 2, "link"],
      [2, 400, "link"],
      [3, 1, "typed"],
    ];
    for (const [id, age, transition] of visits) {
      await db.execute(
        "INSERT INTO visits (HISTORY_ITEM_ID, VISIT_TIME, TRANSITION_TYPE) VALUES (?, ?, ?)",
        [id, sqlTime(now - age * DAY_MS), transition]
      );
    }
  } finally {
    await db.close();
  }

  const count = await importHistory({ source: "orion", id: "Defaults", dir });
  Assert.equal(count, 1, "one recent, importable page");
  const visits = [];
  await PlacesUtils.history
    .fetch("https://orion-history.example/", {
      includeVisits: true,
    })
    .then(info => visits.push(...(info?.visits ?? [])));
  Assert.equal(visits.length, 2);
  Assert.ok(
    visits.some(v => v.transition === PlacesUtils.history.TRANSITIONS.TYPED)
  );
  Assert.equal(
    await PlacesUtils.history.fetch("https://orion-old.example/"),
    null,
    "a visit older than the max age is left behind"
  );
  await PlacesUtils.history.clear();
});

add_task(async function history_without_a_database_inserts_nothing() {
  const { dir } = await makeOrion("no-history");
  Assert.equal(
    await importHistory({ source: "orion", id: "Defaults", dir }),
    0
  );
});
