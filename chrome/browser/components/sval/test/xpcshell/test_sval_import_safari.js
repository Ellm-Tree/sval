/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { MigrationUtils } = ChromeUtils.importESModule(
  "resource:///modules/MigrationUtils.sys.mjs"
);

const Safari = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSafari.sys.mjs"
);
const { Sqlite } = ChromeUtils.importESModule(
  "resource://gre/modules/Sqlite.sys.mjs"
);

const TABS_DIR = [
  "Library",
  "Containers",
  "com.apple.Safari",
  "Data",
  "Library",
  "Safari",
];

let counter = 0;
async function fakeHome() {
  const home = PathUtils.join(do_get_profile().path, `home${counter++}`);
  await IOUtils.makeDirectory(PathUtils.join(home, "Library", "Safari"));
  await IOUtils.makeDirectory(PathUtils.join(home, ...TABS_DIR));
  return home;
}

// Writes rows into a `SafariTabs.db` laid out as Safari 26's.
async function writeTabsDb(home, { marks, windows }) {
  const db = await Sqlite.openConnection({
    path: PathUtils.join(home, ...TABS_DIR, "SafariTabs.db"),
  });
  try {
    await db.execute(`CREATE TABLE bookmarks (
      id INTEGER PRIMARY KEY, special_id INTEGER DEFAULT 0, parent INTEGER,
      type INTEGER, title TEXT, url TEXT, hidden INTEGER DEFAULT 0,
      order_index INTEGER NOT NULL, external_uuid TEXT,
      deleted INTEGER DEFAULT 0, subtype INTEGER DEFAULT 0)`);
    await db.execute(`CREATE TABLE windows (
      id INTEGER PRIMARY KEY, active_tab_group_id INTEGER,
      local_tab_group_id INTEGER, private_tab_group_id INTEGER,
      uuid TEXT NOT NULL DEFAULT '')`);
    for (const m of marks) {
      await db.execute(
        `INSERT INTO bookmarks (id, parent, type, title, url, hidden,
           order_index, external_uuid, deleted, subtype)
         VALUES (:id, :parent, :type, :title, :url, :hidden, :order_index,
           :external_uuid, :deleted, :subtype)`,
        {
          parent: null,
          title: null,
          url: null,
          hidden: 0,
          order_index: 0,
          external_uuid: null,
          deleted: 0,
          subtype: 0,
          ...m,
        }
      );
    }
    for (const w of windows) {
      await db.execute(
        `INSERT INTO windows (id, active_tab_group_id, local_tab_group_id,
           private_tab_group_id) VALUES (:id, :local, :local, :private)`,
        w
      );
    }
  } finally {
    await db.close();
  }
}

const esc = s =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A JS value as an XML plist fragment: objects are dicts, arrays arrays.
function plist(value) {
  if (Array.isArray(value)) {
    return `<array>${value.map(plist).join("")}</array>`;
  }
  if (value === true) {
    return "<true/>";
  }
  if (typeof value === "object") {
    return `<dict>${Object.entries(value)
      .map(([k, v]) => `<key>${esc(k)}</key>${plist(v)}`)
      .join("")}</dict>`;
  }
  return `<string>${esc(String(value))}</string>`;
}

async function writeBookmarks(home, root) {
  await IOUtils.writeUTF8(
    PathUtils.join(home, "Library", "Safari", "Bookmarks.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${plist(root)}</plist>`
  );
}

const list = (Title, Children, extra = {}) => ({
  WebBookmarkType: "WebBookmarkTypeList",
  Title,
  Children,
  ...extra,
});
const leaf = (title, URLString, extra = {}) => ({
  WebBookmarkType: "WebBookmarkTypeLeaf",
  URLString,
  URIDictionary: { title },
  ...extra,
});

const tab = (title, url) => ({ type: "tab", title, url });
const win = (kind, name, children) => ({
  kind,
  name,
  emoji: null,
  color: null,
  children,
});

// One window with three tabs, its private group, Safari's bookkeeping
// folders, a named Tab Group, a deleted tab and a deleted group.
const MARKS = [
  { id: 0, type: 1, title: "Root", external_uuid: "Root" },
  { id: 1, parent: 0, type: 1, title: "", hidden: 1, external_uuid: "pinned" },
  { id: 2, parent: 0, type: 1, external_uuid: "privatePinned", hidden: 1 },
  { id: 3, parent: 0, type: 1, external_uuid: "recentlyClosed", hidden: 1 },
  { id: 4, parent: 0, type: 1, external_uuid: "DefaultProfile", subtype: 2 },
  { id: 10, type: 1, title: "Local", hidden: 1, external_uuid: "U-1" },
  { id: 11, type: 1, title: "Private", hidden: 1, external_uuid: "U-2" },
  { id: 12, parent: 0, type: 1, title: "Travel", order_index: 1 },
  { id: 13, parent: 0, type: 1, title: "Gone", order_index: 2, deleted: 1 },
  { id: 14, parent: 0, type: 1, title: "Empty", order_index: 3 },
  // Window tabs, stored out of order.
  {
    id: 20,
    parent: 10,
    type: 0,
    title: "B",
    url: "https://b.test/",
    order_index: 1,
  },
  {
    id: 21,
    parent: 10,
    type: 0,
    title: "A",
    url: "https://a.test/",
    order_index: 0,
  },
  {
    id: 22,
    parent: 10,
    type: 0,
    title: "C",
    url: "https://c.test/",
    order_index: 2,
  },
  {
    id: 23,
    parent: 10,
    type: 0,
    title: "Closed",
    url: "https://x.test/",
    order_index: 3,
    deleted: 1,
  },
  {
    id: 24,
    parent: 10,
    type: 0,
    title: "Internal",
    url: "about:blank",
    order_index: 4,
  },
  { id: 30, parent: 11, type: 0, title: "Secret", url: "https://secret.test/" },
  { id: 31, parent: 1, type: 0, title: "Pin", url: "https://pin.test/" },
  { id: 32, parent: 3, type: 0, title: "Old", url: "https://old.test/" },
  {
    id: 40,
    parent: 12,
    type: 0,
    title: "Flights",
    url: "https://flights.test/",
  },
  { id: 41, parent: 13, type: 0, title: "Gone tab", url: "https://gone.test/" },
];

const BOOKMARKS = list("", [
  list("History", [], { ShouldOmitFromUI: true }),
  list("BookmarksBar", [
    leaf("Bar", "https://bar.test/"),
    list("Folder", [leaf("Inner", "https://inner.test/")]),
    leaf("Bookmarklet", "javascript:void(0)"),
  ]),
  list("BookmarksMenu", [leaf("Menu", "https://menu.test/")]),
  list("Hidden", [leaf("Nope", "https://nope.test/")], {
    ShouldOmitFromUI: true,
  }),
  list("com.apple.ReadingList", [leaf("Read me", "https://read.test/")], {
    ShouldOmitFromUI: true,
  }),
  leaf("Loose", "https://loose.test/"),
]);

add_task(async function harvests_windows_tab_groups_and_bookmarks() {
  const home = await fakeHome();
  await writeTabsDb(home, {
    marks: MARKS,
    windows: [{ id: 1, local: 10, private: 11 }],
  });
  await writeBookmarks(home, BOOKMARKS);

  const profiles = await Safari.findProfiles({ home });
  Assert.deepEqual(profiles, [
    {
      source: "safari",
      id: "default",
      name: null,
      dir: home,
      lastUsedPath: PathUtils.join(home, "Library", "Safari"),
    },
  ]);
  Assert.ok(await Safari.hasFullDiskAccess({ home }));

  const harvest = await Safari.harvest(profiles[0]);
  Assert.deepEqual(harvest, {
    windows: [
      win("window", null, [
        tab("Pin", "https://pin.test/"),
        tab("A", "https://a.test/"),
        tab("B", "https://b.test/"),
        tab("C", "https://c.test/"),
      ]),
      win("tabGroup", "Travel", [tab("Flights", "https://flights.test/")]),
    ],
    bookmarks: {
      toolbar: [
        { type: "bookmark", title: "Bar", url: "https://bar.test/" },
        {
          type: "folder",
          title: "Folder",
          children: [
            { type: "bookmark", title: "Inner", url: "https://inner.test/" },
          ],
        },
      ],
      menu: [{ type: "bookmark", title: "Menu", url: "https://menu.test/" }],
      other: [
        {
          type: "folder",
          title: await MigrationUtils.getLocalizedString(
            "migration-imported-safari-reading-list"
          ),
          children: [
            { type: "bookmark", title: "Read me", url: "https://read.test/" },
          ],
        },
        { type: "bookmark", title: "Loose", url: "https://loose.test/" },
      ],
    },
    logins: null,
    encryptedSession: false,
    // about:blank and the bookmarklet.
    skipped: 2,
  });
});

// Safari 26.6's own files under a home in data/import/safari: one window
// with two pinned tabs, a named Tab Group, and the bookmarks of a Safari
// that has none. Sync records, CloudKit ids, storage ids and the window's
// restoration archive are removed.
add_task(async function a_real_safari_home() {
  const home = do_get_file("data/import/safari").path;
  const [profile] = await Safari.findProfiles({ home });
  // Safari's collections are empty, and an empty one is written without
  // Children; the Reading List still arrives as a folder of its own.
  Assert.deepEqual(await Safari.harvest(profile), {
    windows: [
      win("window", null, [
        tab("Example Domain", "https://example.com/"),
        tab(
          "Wikipedia, the free encyclopedia",
          "https://en.wikipedia.org/wiki/Main_Page"
        ),
        tab("Example Domain", "https://example.org/"),
        tab("Kagi Search", "https://kagi.com/"),
        tab("Kagi Search", "https://kagi.com/"),
        tab("Wikipedia", "https://www.wikipedia.org/"),
      ]),
      // The group's own bookmarks folder is not a tab.
      win("tabGroup", "group!", [
        tab("The Rust Programming Language", "https://doc.rust-lang.org/book/"),
        tab("HTML Standard", "https://html.spec.whatwg.org/"),
      ]),
    ],
    bookmarks: {
      toolbar: [],
      menu: [],
      other: [
        {
          type: "folder",
          title: await MigrationUtils.getLocalizedString(
            "migration-imported-safari-reading-list"
          ),
          children: [],
        },
      ],
    },
    logins: null,
    encryptedSession: false,
    skipped: 0,
  });
});

add_task(async function sources_missing() {
  const home = PathUtils.join(do_get_profile().path, "nohome");
  await IOUtils.makeDirectory(home);
  Assert.deepEqual(await Safari.findProfiles({ home }), []);
  Assert.deepEqual(await Safari.findProfiles({ home: null }), []);
  Assert.equal(await Safari.hasFullDiskAccess({ home }), false);

  // Safari present with neither file: nothing to import, and no error.
  const empty = await fakeHome();
  const [profile] = await Safari.findProfiles({ home: empty });
  Assert.equal(await Safari.hasFullDiskAccess({ home: empty }), false);
  Assert.deepEqual(await Safari.harvest(profile), {
    windows: [],
    bookmarks: null,
    logins: null,
    encryptedSession: false,
    skipped: 0,
  });
});

add_task(async function unknown_schema_reads_as_no_windows() {
  const home = await fakeHome();
  const db = await Sqlite.openConnection({
    path: PathUtils.join(home, ...TABS_DIR, "SafariTabs.db"),
  });
  await db.execute("CREATE TABLE bookmarks (id INTEGER, label TEXT)");
  await db.close();
  await writeBookmarks(home, list("", [leaf("Loose", "https://loose.test/")]));
  const [profile] = await Safari.findProfiles({ home });
  const harvest = await Safari.harvest(profile);
  Assert.deepEqual(harvest.windows, []);
  Assert.equal(harvest.bookmarks.other.length, 1);
});

add_task(
  async function corrupt_tabs_keep_bookmarks_and_corrupt_bookmarks_fail_cleanly() {
    const home = await fakeHome();
    await IOUtils.writeUTF8(
      PathUtils.join(home, ...TABS_DIR, "SafariTabs.db"),
      "not a database at all, https://secret.test/"
    );
    await writeBookmarks(
      home,
      list("", [leaf("Loose", "https://loose.test/")])
    );
    const [profile] = await Safari.findProfiles({ home });
    const harvest = await Safari.harvest(profile);
    Assert.deepEqual(
      harvest.windows,
      [],
      "an unreadable tab database costs the tabs"
    );
    Assert.equal(harvest.bookmarks.other.length, 1, "and keeps the bookmarks");

    const other = await fakeHome();
    await IOUtils.writeUTF8(
      PathUtils.join(other, "Library", "Safari", "Bookmarks.plist"),
      "<plist><dict><key>Title</key>"
    );
    const [second] = await Safari.findProfiles({ home: other });
    await Assert.rejects(
      Safari.harvest(second),
      /^Error: Safari bookmarks unreadable: [\w ]+$/
    );
  }
);
