/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { defaultRoots, findProfiles, harvest, importHistory } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalImportChromium.sys.mjs"
  );
const { findBrowsers, harvestBrowser } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
);
const { heldOpen, withCopy } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportFiles.sys.mjs"
);
const { countHarvest } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportModel.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { Sqlite } = ChromeUtils.importESModule(
  "resource://gre/modules/Sqlite.sys.mjs"
);

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

do_get_profile();

// Firefox's Chrome migrator lists a profile's extensions while gathering its
// resources. Sval turns that off, and so must a test that runs the migrator.
Services.prefs.setBoolPref("browser.migrate.chrome.extensions.enabled", false);

function makeRoot(name) {
  return makeTempDir(`sval-chromium-${name}`);
}

// An SNSS writer: Chromium's session commands (`session_service_commands.cc`)
// and the `base::Pickle`s two of them carry.

/** Little-endian fields, appended in order. */
class Bytes {
  constructor() {
    this.parts = [];
  }
  int(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    this.parts.push(b);
    return this;
  }
  uint(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.parts.push(b);
    return this;
  }
  raw(bytes) {
    this.parts.push(Uint8Array.from(bytes));
    return this;
  }
  pad(n) {
    this.parts.push(new Uint8Array(n));
    return this;
  }
  aligned(bytes) {
    this.raw(bytes);
    return this.pad((4 - (bytes.length % 4)) % 4);
  }
  string(s) {
    const bytes = new TextEncoder().encode(s);
    return this.int(bytes.length).aligned(bytes);
  }
  string16(s) {
    const bytes = new Uint8Array(s.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < s.length; i++) {
      view.setUint16(i * 2, s.charCodeAt(i), true);
    }
    return this.int(s.length).aligned(bytes);
  }
  bytes() {
    const length = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/**
 * A `base::Pickle`: its uint32 payload size, then the payload.
 *
 * @param {Bytes} body
 * @returns {Uint8Array}
 */
function pickle(body) {
  const payload = body.bytes();
  return new Bytes().uint(payload.length).raw(payload).bytes();
}

/**
 * A group token: sixteen bytes, uint64 high then uint64 low.
 *
 * @param {number} n
 * @returns {number[]}
 */
const token = n => Array.from({ length: 16 }, (_, i) => (i === 0 ? n : 0));

/** An SNSS file under construction. */
class Session {
  constructor() {
    this.commands = [];
  }
  cmd(id, payload) {
    this.commands.push({ id, payload });
    return this;
  }
  tabWindow(win, tab) {
    return this.cmd(0, new Bytes().int(win).int(tab).bytes());
  }
  tabIndex(tab, index) {
    return this.cmd(2, new Bytes().int(tab).int(index).bytes());
  }
  navigation(tab, index, url, title) {
    // The fields after the title are ignored by the reader, as are any of a
    // real entry's later ones.
    const body = new Bytes()
      .int(tab)
      .int(index)
      .string(url)
      .string16(title)
      .string("")
      .int(0);
    return this.cmd(6, pickle(body));
  }
  selected(tab, index) {
    return this.cmd(7, new Bytes().int(tab).int(index).bytes());
  }
  windowType(win, type) {
    return this.cmd(9, new Bytes().int(win).int(type).bytes());
  }
  prunedFromBack(tab, index) {
    return this.cmd(5, new Bytes().int(tab).int(index).bytes());
  }
  tabClosed(tab) {
    return this.cmd(16, new Bytes().int(tab).pad(4).pad(8).bytes());
  }
  windowClosed(win) {
    return this.cmd(17, new Bytes().int(win).pad(4).pad(8).bytes());
  }
  tabGroup(tab, group) {
    const body = new Bytes().int(tab).pad(4);
    if (group === null) {
      body.pad(16).raw([0]);
    } else {
      body.raw(token(group)).raw([1]);
    }
    return this.cmd(25, body.pad(7).bytes());
  }
  groupMetadata(group, title, color) {
    const body = new Bytes()
      .raw(token(group))
      .string16(title)
      .uint(color)
      .raw([0])
      .pad(3);
    return this.cmd(27, pickle(body));
  }
  edgeWorkspace(win) {
    const uuid = new TextEncoder().encode(
      "00000000-0000-4000-8000-000000000000"
    );
    return this.cmd(
      48,
      new Bytes().int(44).int(win).int(uuid.length).aligned(uuid).bytes()
    );
  }
  // Vivaldi's tab extension data, as a real Vivaldi 7 profile writes it: a
  // pickle of the tab id and its `vivExtData` JSON.
  vivaldiExtData(tab, ext) {
    return this.cmd(
      21,
      pickle(new Bytes().int(tab).string(JSON.stringify(ext)))
    );
  }
  marker() {
    return this.cmd(255, new Uint8Array(0));
  }
  /**
   * Adds one tab with a single navigation.
   *
   * @param {number} win
   * @param {number} tab
   * @param {number} index
   * @param {string} url
   * @param {string} title
   * @param {number|null} [group]
   * @returns {Session}
   */
  tab(win, tab, index, url, title, group = null) {
    this.tabWindow(win, tab)
      .tabIndex(tab, index)
      .navigation(tab, 0, url, title);
    this.selected(tab, 0);
    if (group !== null) {
      this.tabGroup(tab, group);
    }
    return this;
  }
  bytes({ truncate = false, magic = 0x53534e53, version = 3 } = {}) {
    const out = new Bytes().int(magic).int(version);
    for (const { id, payload } of this.commands) {
      const size = payload.length + 1;
      out.raw([size & 0xff, size >> 8, id]).raw(payload);
    }
    if (truncate) {
      // A command header promising more bytes than the file holds.
      out.raw([200, 0, 6, 1, 2, 3]);
    }
    return out.bytes();
  }
}

async function writeSession(profileDir, name, session, options) {
  const dir = PathUtils.join(profileDir, "Sessions");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  await IOUtils.write(PathUtils.join(dir, name), session.bytes(options));
}

async function makeProfile(root, id) {
  const dir = PathUtils.join(root, id);
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  return dir;
}

async function writeLoginData(dir, count) {
  const conn = await Sqlite.openConnection({
    path: PathUtils.join(dir, "Login Data"),
  });
  await conn.execute(
    "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB)"
  );
  for (let i = 0; i < count; i++) {
    await conn.execute("INSERT INTO logins VALUES (:url, :user, x'00')", {
      url: `https://login${i}.example/`,
      user: `user${i}`,
    });
  }
  await conn.close();
}

const BOOKMARKS = {
  version: 1,
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks bar",
      children: [
        { type: "url", name: "Bar one", url: "https://bar.example/" },
        {
          type: "folder",
          name: "Reading",
          children: [
            { type: "url", name: "Deep", url: "https://deep.example/" },
            { type: "url", name: "Bookmarklet", url: "javascript:void(0)" },
          ],
        },
      ],
    },
    other: {
      type: "folder",
      name: "Other bookmarks",
      children: [
        { type: "url", name: "Other one", url: "https://other.example/" },
      ],
    },
    synced: {
      type: "folder",
      name: "Mobile bookmarks",
      children: [{ type: "url", name: "Phone", url: "https://phone.example/" }],
    },
  },
};

const tab = (title, url) => ({ type: "tab", title, url });

add_task(async function profiles_come_from_local_state() {
  const chrome = await makeRoot("profiles-chrome");
  const edge = await makeRoot("profiles-edge");
  const dia = await makeRoot("profiles-dia");
  const absent = tempPath("sval-chromium-absent");
  await makeProfile(chrome, "Default");
  await makeProfile(chrome, "Profile 1");
  await IOUtils.writeJSON(PathUtils.join(chrome, "Local State"), {
    profile: {
      info_cache: {
        Default: { name: "Personal" },
        "Profile 1": { name: "Work" },
        // Listed, but its directory is gone.
        "Profile 9": { name: "Deleted" },
      },
    },
  });
  // Dia's Default has the name Dia made up, and its sign-in profile is
  // Dia's own.
  await makeProfile(dia, "Default");
  await makeProfile(dia, "Profile 2");
  await IOUtils.writeJSON(PathUtils.join(dia, "Local State"), {
    profile: {
      info_cache: {
        Default: { name: "Profile 1", is_using_default_name: true },
        "Profile 2": { name: "Embedded_SSO_Temp" },
      },
    },
  });
  // Edge without a Local State still offers its Default profile.
  await makeProfile(edge, "Default");

  const profiles = await findProfiles([
    { source: "chrome", dir: chrome },
    { source: "edge", dir: edge },
    { source: "dia", dir: dia },
    { source: "chrome", dir: absent },
  ]);
  Assert.deepEqual(profiles, [
    {
      source: "chrome",
      id: "Default",
      name: "Personal",
      dir: PathUtils.join(chrome, "Default"),
    },
    {
      source: "chrome",
      id: "Profile 1",
      name: "Work",
      dir: PathUtils.join(chrome, "Profile 1"),
    },
    {
      source: "edge",
      id: "Default",
      name: null,
      dir: PathUtils.join(edge, "Default"),
    },
    {
      source: "dia",
      id: "Default",
      name: null,
      dir: PathUtils.join(dia, "Default"),
    },
  ]);

  Assert.deepEqual(
    await findProfiles([{ source: "chrome", dir: absent }]),
    [],
    "a browser that is not installed has no profiles"
  );
});

add_task(async function harvest_replays_the_session() {
  const root = await makeRoot("harvest");
  const dir = await makeProfile(root, "Default");

  const s = new Session();
  // Window 1: an ungrouped tab, a two-tab group, a one-tab group, an internal
  // page and a closed tab. Indexes are written out of order on purpose.
  s.tab(1, 10, 0, "https://ungrouped.example/", "Ungrouped");
  // Tab 10 navigated twice more, went back one, then lost its forward entry.
  s.navigation(10, 1, "https://ungrouped.example/second", "Second");
  s.navigation(10, 2, "https://ungrouped.example/third", "Third");
  s.selected(10, 1);
  s.prunedFromBack(10, 2);
  s.tab(1, 12, 2, "https://work.example/b", "Work B", 1);
  s.tab(1, 11, 1, "https://work.example/a", "Work A", 1);
  s.tab(1, 13, 3, "https://fun.example/", "Fun", 2);
  s.tab(1, 14, 4, "chrome://settings/", "Settings");
  s.tab(1, 15, 5, "https://closed.example/", "Closed");
  s.tabClosed(15);
  s.groupMetadata(1, "Work", 0);
  // Last write wins: the group was renamed and recoloured.
  s.groupMetadata(1, "Work stuff", 1);
  s.groupMetadata(2, "Fun", 2);
  // Window 2: one group of each of Chromium's colours, and a tab that left
  // its group.
  for (let c = 0; c < 9; c++) {
    s.tab(2, 100 + c, c, `https://c${c}.example/`, `C${c}`, 10 + c);
    s.groupMetadata(10 + c, `Colour ${c}`, c);
  }
  s.tab(2, 120, 9, "https://left.example/", "Left", 10);
  s.tabGroup(120, null);
  // A popup and a closed window import nothing.
  s.tab(3, 30, 0, "https://popup.example/", "Popup");
  s.windowType(3, 1);
  s.tab(4, 40, 0, "https://gone.example/", "Gone");
  s.windowClosed(4);
  s.marker();
  // A command after the marker still applies.
  s.navigation(13, 0, "https://fun.example/later", "Fun later");
  await writeSession(dir, "Session_13300000000000000", s, { truncate: true });

  // A newer file without a marker is an incomplete write and is passed over.
  await writeSession(
    dir,
    "Session_13300000000000001",
    new Session().tab(1, 1, 0, "https://incomplete.example/", "Incomplete")
  );

  await IOUtils.writeJSON(PathUtils.join(dir, "Bookmarks"), BOOKMARKS);
  await writeLoginData(dir, 3);

  const result = await harvest({
    source: "chrome",
    id: "Default",
    name: null,
    dir,
  });

  const colours = [
    "gray",
    "blue",
    "red",
    "yellow",
    "green",
    "pink",
    "purple",
    "cyan",
    "orange",
  ];
  Assert.deepEqual(result, {
    windows: [
      {
        kind: "window",
        name: null,
        emoji: null,
        color: null,
        children: [
          tab("Second", "https://ungrouped.example/second"),
          {
            type: "group",
            name: "Work stuff",
            color: "blue",
            children: [
              tab("Work A", "https://work.example/a"),
              tab("Work B", "https://work.example/b"),
            ],
          },
          {
            type: "group",
            name: "Fun",
            color: "red",
            children: [tab("Fun later", "https://fun.example/later")],
          },
        ],
      },
      {
        kind: "window",
        name: null,
        emoji: null,
        color: null,
        children: [
          ...colours.map((color, c) => ({
            type: "group",
            name: `Colour ${c}`,
            color,
            children: [tab(`C${c}`, `https://c${c}.example/`)],
          })),
          tab("Left", "https://left.example/"),
        ],
      },
    ],
    bookmarks: {
      toolbar: [
        { type: "bookmark", title: "Bar one", url: "https://bar.example/" },
        {
          type: "folder",
          title: "Reading",
          children: [
            { type: "bookmark", title: "Deep", url: "https://deep.example/" },
          ],
        },
      ],
      menu: [],
      other: [
        { type: "bookmark", title: "Other one", url: "https://other.example/" },
        { type: "bookmark", title: "Phone", url: "https://phone.example/" },
      ],
    },
    logins: 3,
    encryptedSession: false,
    // The settings page and the bookmarklet.
    skipped: 2,
  });
});

// User data directories as Chrome 154 and Edge 155 wrote them, under
// data/import. Each session file is the browser's own log, with every
// navigation's page state, referrer and tracking query removed and the
// window archives and session storage ids dropped; the rest of each command
// is as written. Chrome's Default profile has no Bookmarks file, as a fresh
// profile does not.
const FIXTURES = do_get_file("data/import").path;

const group = (name, color, children) => ({
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
const roots = (toolbar, other = []) => ({ toolbar, menu: [], other });
const bookmark = (title, url) => ({ type: "bookmark", title, url });

add_task(async function a_real_chrome_user_data_directory() {
  const root = PathUtils.join(FIXTURES, "chrome");
  const profiles = await findProfiles([{ source: "chrome", dir: root }]);
  Assert.deepEqual(profiles, [
    {
      source: "chrome",
      id: "Default",
      // "Your Chrome" is a name Chrome made up, so the profile has none.
      name: null,
      dir: PathUtils.join(root, "Default"),
    },
    {
      source: "chrome",
      id: "Profile 1",
      name: "Second",
      dir: PathUtils.join(root, "Profile 1"),
    },
  ]);

  // The first tab is pinned. The oracle.com tab went back a page and on to
  // another, so Chrome pruned the forward entry it left.
  Assert.deepEqual(await harvest(profiles[0]), {
    windows: [
      plainWindow([
        tab("Razor - Wikipedia", "https://en.wikipedia.org/wiki/Razor"),
        group("group1", "purple", [
          tab(
            "Microsoft – AI, Cloud, Productivity, Computing, Gaming & Apps",
            "https://www.microsoft.com/en-us"
          ),
          tab(
            "What Is SaaS? | Oracle",
            "https://www.oracle.com/applications/what-is-saas/"
          ),
        ]),
        tab("Home | Official LEGO® Shop US", "https://www.lego.com/en-us"),
      ]),
    ],
    bookmarks: null,
    logins: null,
    encryptedSession: false,
    skipped: 0,
  });

  // A tab was closed, and Chrome had not yet logged the last tab's title.
  Assert.deepEqual(await harvest(profiles[1]), {
    windows: [
      plainWindow([
        tab("Wikipedia", "https://www.wikipedia.org/"),
        group("group2", "cyan", [
          tab("Reddit - The heart of the internet", "https://www.reddit.com/"),
          tab("", "https://www.apple.com/"),
        ]),
      ]),
    ],
    bookmarks: roots([
      bookmark(
        "amazon - Google Search",
        "https://www.google.com/search?q=amazon"
      ),
    ]),
    logins: null,
    encryptedSession: false,
    skipped: 0,
  });
});

// Vivaldi 8 on Linux, quit from its Work workspace. Work holds a stack named
// and coloured in Vivaldi's stack editor, Home an unnamed one and the
// emoji picked in the workspace dialog. The welcome page, outside every
// workspace, is Vivaldi's own and is skipped.
add_task(async function a_real_vivaldi_user_data_directory() {
  const root = PathUtils.join(FIXTURES, "vivaldi");
  const [profile] = await findProfiles([{ source: "vivaldi", dir: root }]);
  const vivaldi = await harvest(profile);
  const shape = node =>
    node.type === "group"
      ? { stack: node.name, color: node.color, urls: node.children.map(shape) }
      : node.url;
  Assert.deepEqual(
    vivaldi.windows.map(w => ({
      kind: w.kind,
      name: w.name,
      emoji: w.emoji,
      children: w.children.map(shape),
    })),
    [
      {
        kind: "workspace",
        name: "Work",
        emoji: null,
        children: [
          "https://docs.python.org/3/",
          "https://github.com/mozilla-firefox/firefox/pulls",
          {
            stack: "Sprint",
            color: "purple",
            urls: [
              "https://developer.mozilla.org/en-US/",
              "https://linear.app/",
            ],
          },
          "https://www.figma.com/",
        ],
      },
      {
        kind: "workspace",
        name: "Home",
        emoji: "\u2708\ufe0f",
        children: [
          {
            stack: null,
            color: null,
            urls: [
              "https://en.wikipedia.org/wiki/Fjord",
              "https://www.visitnorway.com/",
            ],
          },
          "https://www.rei.com/c/tents",
          "https://www.seriouseats.com/",
        ],
      },
    ]
  );
  Assert.equal(vivaldi.skipped, 1, "the welcome page is skipped");
});

// The same Chrome is one browser, and each of its profiles one workspace
// named for the profile (import spec §3), the one Chrome made up a name for
// by its directory. Each carries its profile, which decides its cookie jar.
add_task(async function a_real_chromes_profiles_are_one_browser() {
  const root = PathUtils.join(FIXTURES, "chrome");
  const browsers = await findBrowsers({
    chromium: [{ source: "chrome", dir: root }],
  });
  Assert.deepEqual(
    browsers.map(b => [b.source, b.profiles.map(p => p.id)]),
    [["chrome", ["Default", "Profile 1"]]]
  );
  const combined = await harvestBrowser(browsers[0]);
  Assert.deepEqual(
    combined.windows.map(win => [win.kind, win.name, win.profile]),
    [
      ["profile", "Default", "Default"],
      ["profile", "Second", "Profile 1"],
    ]
  );
  Assert.deepEqual(
    combined.bookmarks,
    roots([
      bookmark(
        "amazon - Google Search",
        "https://www.google.com/search?q=amazon"
      ),
    ]),
    "the profiles' bookmarks are one tree"
  );
});

add_task(async function a_real_edge_user_data_directory() {
  const root = PathUtils.join(FIXTURES, "edge");
  const profiles = await findProfiles([{ source: "edge", dir: root }]);
  Assert.deepEqual(profiles, [
    {
      source: "edge",
      id: "Default",
      // "Profile 1" is a name Edge made up, so the profile has none.
      name: null,
      dir: PathUtils.join(root, "Default"),
    },
  ]);
  // Two plain windows: this Edge has no Edge Workspace. The first window's
  // first group also holds a New Tab page, which is skipped.
  Assert.deepEqual(await harvest(profiles[0]), {
    windows: [
      plainWindow([
        group("group1", "cyan", [
          tab("wikipedia - Search", "https://www.bing.com/search?q=wikipedia"),
        ]),
        group("Wikipedia", "yellow", [
          tab("Wikipedia", "https://www.wikipedia.org/"),
        ]),
      ]),
      plainWindow([
        tab(
          "Golf Clubs, Golf Bags, and Equipment | PING",
          "https://ping.com/en-us"
        ),
        group("PINK", "pink", [
          tab(
            "DOOR Smarter Access and Building Intelligence for Multifamily",
            "https://door.com/"
          ),
        ]),
        tab(
          "Booking.com | Official site | The best hotels, flights, car rentals & accommodations",
          "https://www.booking.com/index.html"
        ),
      ]),
    ],
    bookmarks: roots([
      bookmark(
        "Golf Clubs, Golf Bags, and Equipment | PING",
        "https://ping.com/en-us"
      ),
    ]),
    logins: null,
    encryptedSession: false,
    skipped: 1,
  });
});

// Edge on Windows, signed in, quit from its menu with two Edge Workspaces
// open: one made from a window of tab groups, one made blank. Account data
// and sync metadata are removed. Its sync database holds the two
// Workspaces' records and one of a Workspace's tabs, as Edge wrote them,
// rewritten by LevelDB into a database of their own.
add_task(async function a_real_windows_edges_workspaces() {
  const root = PathUtils.join(FIXTURES, "edge-windows");
  const [profile] = await findProfiles([{ source: "edge", dir: root }]);
  // Edge's New Tab page is logged as the MSN page it shows, and is skipped.
  const workspace = (name, color, children) => ({
    kind: "edgeWorkspace",
    name,
    emoji: null,
    color,
    children,
  });
  Assert.deepEqual(await harvest(profile), {
    windows: [
      workspace("Norway Trip Planning", "green", [
        group("Norway trip", "orange", [
          tab(
            "Norway Travel 2026 - Lonely Planet | Europe",
            "https://www.lonelyplanet.com/destinations/norway"
          ),
          tab(
            "Visit Norway | Official travel guide to Norway",
            "https://www.visitnorway.com/"
          ),
          tab(
            "Booking.com | Official site | The best hotels, flights, car rentals & accommodations",
            "https://www.booking.com/?chal_t=1793657796087&force_referer="
          ),
        ]),
        group("Research", "blue", [
          tab(
            "JavaScript | MDN",
            "https://developer.mozilla.org/en-US/docs/Web/JavaScript"
          ),
          tab(
            "GitHub - mozilla-firefox/firefox: The official repository of Mozilla's Firefox web browser. \u00b7 GitHub",
            "https://github.com/mozilla-firefox/firefox"
          ),
        ]),
        group("Shopping", "green", [
          tab(
            "Shop Affordable Home Furnishings & Home Goods - IKEA",
            "https://www.ikea.com/us/en/"
          ),
          tab("Tents | REI Co-op", "https://www.rei.com/c/tents"),
        ]),
        tab(
          "Welcome to Microsoft Edge",
          "https://explore.microsoft.com/en-us/edge/welcome?form=MT00LJ&form=MT004A&sg=0&OCID=MT004A&cs=3513901856"
        ),
      ]),
      workspace("work", "purple", [
        tab(
          "Linear \u2013 The system for product development",
          "https://linear.app/"
        ),
        tab(
          "GitHub - microsoft/vscode: Visual Studio Code \u00b7 GitHub",
          "https://github.com/microsoft/vscode"
        ),
        tab("Hacker News", "https://news.ycombinator.com/"),
      ]),
    ],
    bookmarks: {
      toolbar: [
        bookmark("Hacker News", "https://news.ycombinator.com/"),
        {
          type: "folder",
          title: "Recipes",
          children: [
            bookmark("Serious Eats", "https://www.seriouseats.com/"),
            bookmark("NYT Cooking", "https://cooking.nytimes.com/"),
          ],
        },
      ],
      menu: [],
      other: [],
    },
    logins: null,
    encryptedSession: false,
    skipped: 1,
  });
});

add_task(async function newest_file_when_none_has_a_marker() {
  const root = await makeRoot("nomarker");
  const dir = await makeProfile(root, "Default");
  await writeSession(
    dir,
    "Session_9",
    new Session().tab(1, 1, 0, "https://nine.example/", "Nine")
  );
  await writeSession(
    dir,
    "Session_10",
    new Session().tab(1, 1, 0, "https://ten.example/", "Ten")
  );
  const result = await harvest({ source: "chrome", id: "Default", dir });
  Assert.deepEqual(result.windows[0].children, [
    tab("Ten", "https://ten.example/"),
  ]);
  Assert.equal(result.bookmarks, null, "no Bookmarks file, no bookmarks");
  Assert.equal(result.logins, null, "no Login Data, no count");
});

add_task(async function edge_workspaces_are_marked() {
  const root = await makeRoot("edge");
  const dir = await makeProfile(root, "Default");
  const s = new Session()
    .tab(1, 1, 0, "https://plain.example/", "Plain")
    .tab(2, 2, 0, "https://space.example/", "Space")
    .edgeWorkspace(2)
    .marker();
  await writeSession(dir, "Session_1", s);

  const edge = await harvest({ source: "edge", id: "Default", dir });
  Assert.deepEqual(
    edge.windows.map(w => w.kind),
    ["window", "edgeWorkspace"]
  );

  // Command 48 means nothing in Chrome's log.
  const chrome = await harvest({ source: "chrome", id: "Default", dir });
  Assert.deepEqual(
    chrome.windows.map(w => w.kind),
    ["window", "window"]
  );

  // An Edge session without it is all plain windows.
  await writeSession(
    dir,
    "Session_2",
    new Session()
      .tab(1, 1, 0, "https://plain.example/", "Plain")
      .tab(2, 2, 0, "https://other.example/", "Other")
      .marker()
  );
  const without = await harvest({ source: "edge", id: "Default", dir });
  Assert.deepEqual(
    without.windows.map(w => w.kind),
    ["window", "window"]
  );
});

add_task(async function vivaldi_workspaces_become_windows() {
  const root = await makeRoot("vivaldi");
  const dir = await makeProfile(root, "Default");
  const WORK = 1783459383453;
  const FUN = 1783369298034;
  const GONE = 1783381338872;
  // Shaped as a real profile's `vivaldi.workspaces.list`: an icon from
  // Vivaldi's set is an SVG, an emoji icon is carried.
  await IOUtils.writeJSON(PathUtils.join(dir, "Preferences"), {
    vivaldi: {
      workspaces: {
        list: [
          { icon: "<svg></svg>", iconId: 2, id: FUN, name: "Fun", emoji: "🚀" },
          { icon: "<svg></svg>", iconId: 17, id: WORK, name: "Work" },
        ],
      },
    },
  });
  const ext = workspaceId => ({
    ext_id: "",
    urlForThumbnail: "",
    // Vivaldi writes the id as a double.
    ...(workspaceId === undefined ? {} : { workspaceId: workspaceId + 0.0 }),
  });
  const s = new Session()
    .tab(1, 1, 0, "https://plain.example/", "Plain")
    .vivaldiExtData(1, ext())
    .tab(1, 2, 1, "https://work-a.example/", "Work A")
    .vivaldiExtData(2, ext(WORK))
    .tab(1, 3, 2, "https://fun.example/", "Fun")
    .vivaldiExtData(3, ext(FUN))
    // A second window's tab in the same workspace joins it.
    .tab(2, 4, 0, "https://work-b.example/", "Work B")
    .vivaldiExtData(4, ext(WORK))
    // A workspace the list no longer has still imports, unnamed, last.
    .tab(2, 5, 1, "https://gone.example/", "Gone")
    .vivaldiExtData(5, ext(GONE))
    .marker();
  await writeSession(dir, "Session_1", s);

  const vivaldi = await harvest({ source: "vivaldi", id: "Default", dir });
  Assert.deepEqual(
    vivaldi.windows.map(w => ({
      kind: w.kind,
      name: w.name,
      emoji: w.emoji,
      urls: w.children.map(c => c.url),
    })),
    [
      {
        kind: "window",
        name: null,
        emoji: null,
        urls: ["https://plain.example/"],
      },
      {
        kind: "workspace",
        name: "Fun",
        emoji: "🚀",
        urls: ["https://fun.example/"],
      },
      {
        kind: "workspace",
        name: "Work",
        emoji: null,
        urls: ["https://work-a.example/", "https://work-b.example/"],
      },
      {
        kind: "workspace",
        name: null,
        emoji: null,
        urls: ["https://gone.example/"],
      },
    ]
  );

  // Command 21 is Chromium's last active time, so Brave's log is read as
  // Chrome's: two plain windows.
  const brave = await harvest({ source: "brave", id: "Default", dir });
  Assert.deepEqual(
    brave.windows.map(w => [w.kind, w.children.length]),
    [
      ["window", 3],
      ["window", 2],
    ]
  );

  // Without Preferences every workspace still imports, unnamed.
  await IOUtils.remove(PathUtils.join(dir, "Preferences"));
  const unnamed = await harvest({ source: "vivaldi", id: "Default", dir });
  Assert.deepEqual(
    unnamed.windows.map(w => [w.kind, w.name]),
    [
      ["window", null],
      ["workspace", null],
      ["workspace", null],
      ["workspace", null],
    ]
  );
});

/**
 * Vivaldi's tab stacks are its tab groups: each arrives as a group in its
 * workspace, with its title and colour, between the tabs around it, as
 * Vivaldi's tab bar shows it.
 */
add_task(async function vivaldi_tab_stacks_become_groups() {
  const root = await makeRoot("vivaldi-stacks");
  const dir = await makeProfile(root, "Default");
  const WORK = 1783459383453;
  await IOUtils.writeJSON(PathUtils.join(dir, "Preferences"), {
    vivaldi: { workspaces: { list: [{ id: WORK, name: "Work" }] } },
  });
  // Shaped as a real Vivaldi 8 profile's `vivExtData`: every tab of a stack
  // carries the stack's id, title and colour.
  const ext = stack => ({
    ext_id: "",
    workspaceId: WORK + 0.0,
    ...(stack && {
      group: stack.id,
      fixedGroupTitle: stack.title,
      groupColor: stack.color,
    }),
  });
  const READING = {
    id: "0b7c3e1a-1111-4f00-8000-000000000001",
    title: "Reading",
    color: "color8",
  };
  const ERRANDS = {
    id: "0b7c3e1a-2222-4f00-8000-000000000002",
    title: "",
    color: "",
  };
  const s = new Session()
    .tab(1, 1, 0, "https://read-a.example/", "Read A")
    .vivaldiExtData(1, ext(READING))
    .tab(1, 2, 1, "https://read-b.example/", "Read B")
    .vivaldiExtData(2, ext(READING))
    .tab(1, 3, 2, "https://loose.example/", "Loose")
    .vivaldiExtData(3, ext(null))
    .tab(1, 4, 3, "https://errand.example/", "Errand")
    .vivaldiExtData(4, ext(ERRANDS))
    // A tab taken out of a stack is written again without it.
    .tab(1, 5, 4, "https://left.example/", "Left")
    .vivaldiExtData(5, ext(ERRANDS))
    .vivaldiExtData(5, ext(null))
    .marker();
  await writeSession(dir, "Session_1", s);

  const vivaldi = await harvest({ source: "vivaldi", id: "Default", dir });
  Assert.deepEqual(
    vivaldi.windows,
    [
      {
        kind: "workspace",
        name: "Work",
        emoji: null,
        color: null,
        children: [
          {
            type: "group",
            name: "Reading",
            color: "cyan",
            children: [
              tab("Read A", "https://read-a.example/"),
              tab("Read B", "https://read-b.example/"),
            ],
          },
          tab("Loose", "https://loose.example/"),
          {
            type: "group",
            name: null,
            color: null,
            children: [tab("Errand", "https://errand.example/")],
          },
          tab("Left", "https://left.example/"),
        ],
      },
    ],
    "each stack is a group, named and coloured as Vivaldi shows it"
  );
});

/**
 * Holds `path` open the way a running Chrome or Edge holds its session log on
 * Windows: for writing, shared with no one.
 *
 * @param {string} path
 * @returns {Function} Releases the file.
 */
function holdExclusively(path) {
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );
  const kernel32 = ctypes.open("kernel32.dll");
  const HANDLE = ctypes.voidptr_t;
  const CreateFileW = kernel32.declare(
    "CreateFileW",
    ctypes.winapi_abi,
    HANDLE,
    ctypes.char16_t.ptr,
    ctypes.uint32_t,
    ctypes.uint32_t,
    ctypes.voidptr_t,
    ctypes.uint32_t,
    ctypes.uint32_t,
    HANDLE
  );
  const CloseHandle = kernel32.declare(
    "CloseHandle",
    ctypes.winapi_abi,
    ctypes.bool,
    HANDLE
  );
  const GENERIC_WRITE = 0x40000000;
  const OPEN_EXISTING = 3;
  const FILE_ATTRIBUTE_NORMAL = 0x80;
  const handle = CreateFileW(
    path,
    GENERIC_WRITE,
    0,
    null,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    null
  );
  Assert.notEqual(
    ctypes.cast(handle, ctypes.intptr_t).value.toString(),
    "-1",
    "the session file is held"
  );
  return () => {
    CloseHandle(handle);
    kernel32.close();
  };
}

add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function a_running_browsers_session_says_to_quit_it() {
    const root = await makeRoot("held");
    const open = await makeProfile(root, "Default");
    const quit = await makeProfile(root, "Profile 1");
    await writeSession(
      open,
      "Session_1",
      new Session().tab(1, 1, 0, "https://open.example/", "Open").marker()
    );
    await writeSession(
      quit,
      "Session_1",
      new Session().tab(1, 1, 0, "https://quit.example/", "Quit").marker()
    );
    const release = holdExclusively(
      PathUtils.join(open, "Sessions", "Session_1")
    );
    try {
      const both = await harvestBrowser({
        source: "chrome",
        profiles: [
          { source: "chrome", id: "Default", name: null, dir: open },
          { source: "chrome", id: "Profile 1", name: null, dir: quit },
        ],
      });
      Assert.deepEqual(
        [both.unread, both.held, countHarvest(both).tabs],
        [1, 1, 1],
        "the profile Chrome has open is counted as held, the other imports"
      );
      const err = await harvestBrowser({
        source: "chrome",
        profiles: [{ source: "chrome", id: "Default", name: null, dir: open }],
      }).catch(e => e);
      Assert.ok(heldOpen(err), "a browser with every profile open is held");
    } finally {
      release();
    }
  }
);

add_task(function every_chromium_browser_is_looked_for() {
  const sources = new Set(defaultRoots().map(root => root.source));
  const expected = ["brave", "chrome", "edge", "vivaldi"];
  if (AppConstants.platform === "macosx") {
    // Dia's Windows build is a beta with no documented data directory.
    expected.push("dia");
  }
  Assert.deepEqual([...sources].sort(), expected.sort(), AppConstants.platform);
});

// Windows keeps no group or other bits for IOUtils to read.
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function a_databases_copy_is_the_users_alone() {
    const source = PathUtils.join(
      await makeTempDir("sval-copy-source"),
      "Login Data"
    );
    const conn = await Sqlite.openConnection({ path: source });
    await conn.execute("CREATE TABLE logins (id INTEGER)");
    await conn.close();
    await IOUtils.setPermissions(source, 0o644, false);

    const modes = await withCopy(source, async db => {
      const copy = db.unsafeRawConnection.databaseFile.path;
      return [
        (await IOUtils.stat(PathUtils.parent(copy))).permissions,
        (await IOUtils.stat(copy)).permissions,
      ];
    });
    Assert.equal(modes[1] & 0o077, 0o044, "the copy is readable by others");
    Assert.equal(
      modes[0] & 0o777,
      0o700,
      "inside a folder only the user opens"
    );
  }
);

add_task(async function encrypted_session_only() {
  const root = await makeRoot("encrypted");
  const dir = await makeProfile(root, "Default");
  const encrypted = PathUtils.join(dir, "Sessions_Encrypted");
  await IOUtils.makeDirectory(encrypted);
  await IOUtils.write(
    PathUtils.join(encrypted, "Session_1"),
    new Session().tab(1, 1, 0, "https://a.example/", "A").bytes({ version: 5 })
  );
  await IOUtils.writeJSON(PathUtils.join(dir, "Bookmarks"), BOOKMARKS);
  const result = await harvest({ source: "chrome", id: "Default", dir });
  Assert.deepEqual(result.windows, []);
  Assert.ok(result.encryptedSession);
  Assert.equal(result.bookmarks.toolbar.length, 2, "bookmarks still read");
});

add_task(async function corrupt_files_throw_clean_errors() {
  const root = await makeRoot("corrupt");
  const dir = await makeProfile(root, "Default");
  await writeSession(
    dir,
    "Session_1",
    new Session().tab(1, 1, 0, "https://a.example/", "A"),
    { magic: 0x12345678 }
  );
  const profile = { source: "chrome", id: "Default", dir };
  await Assert.rejects(harvest(profile), e => {
    Assert.ok(!e.message.includes(root), "the message names no path");
    return /session/.test(e.message);
  });

  await IOUtils.remove(PathUtils.join(dir, "Sessions"), { recursive: true });
  await IOUtils.writeUTF8(PathUtils.join(dir, "Bookmarks"), "{ not json");
  await Assert.rejects(harvest(profile), e => {
    Assert.ok(!e.message.includes(root), "the message names no path");
    return /bookmarks/.test(e.message);
  });

  // An unreadable login store is no count, never a failure.
  await IOUtils.remove(PathUtils.join(dir, "Bookmarks"));
  await IOUtils.writeUTF8(PathUtils.join(dir, "Login Data"), "not sqlite");
  Assert.equal((await harvest(profile)).logins, null);
});

// History goes through Firefox's own migrator, which reads its own platform
// data directory, so that directory is pointed at a fixture here, as
// Firefox's migration tests do (`registerFakePath` in head_migration.js).
add_task(async function history_runs_only_the_history_resource() {
  const base = await makeRoot("history");
  let key;
  let segments;
  if (AppConstants.platform === "win") {
    key = "LocalAppData";
    segments = ["Google", "Chrome", "User Data"];
  } else if (AppConstants.platform === "macosx") {
    key = "ULibDir";
    segments = ["Application Support", "Google", "Chrome"];
  } else {
    key = "Home";
    segments = [".config", "google-chrome"];
  }
  const dirsvc = Services.dirsvc.QueryInterface(Ci.nsIProperties);
  let original;
  try {
    original = dirsvc.get(key, Ci.nsIFile);
    dirsvc.undefine(key);
  } catch {
    original = undefined;
  }
  const fake = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  fake.initWithPath(base);
  dirsvc.set(key, fake);
  registerCleanupFunction(() => {
    dirsvc.undefine(key);
    if (original) {
      dirsvc.set(key, original);
    }
  });

  const root = PathUtils.join(base, ...segments);
  await IOUtils.makeDirectory(root, { createAncestors: true });
  const dir = await makeProfile(root, "Default");
  await IOUtils.writeJSON(PathUtils.join(root, "Local State"), {
    profile: { info_cache: { Default: { name: "Person 1" } } },
  });
  await IOUtils.writeJSON(PathUtils.join(dir, "Bookmarks"), BOOKMARKS);

  // Chromium's time: microseconds since 1601.
  const chromeTime = ms => (ms + 11644473600000) * 1000;
  const conn = await Sqlite.openConnection({
    path: PathUtils.join(dir, "History"),
  });
  await conn.execute(
    "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)"
  );
  await conn.execute(
    "INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES ('https://visited.example/', 'Visited', 1, 0, :t, 0)",
    { t: chromeTime(Date.now() - 86400000) }
  );
  await conn.close();

  const [profile] = await findProfiles([{ source: "chrome", dir: root }]);
  Assert.equal(await importHistory(profile), 1);
  Assert.ok(
    await PlacesUtils.history.fetch("https://visited.example/"),
    "the visit is in Places"
  );
  Assert.equal(
    await PlacesUtils.bookmarks.fetch({ url: "https://bar.example/" }),
    null,
    "no bookmark was imported"
  );

  // A data directory whose Local State is gone still offers Default, and
  // its history still imports.
  await IOUtils.remove(PathUtils.join(root, "Local State"));
  const again = await Sqlite.openConnection({
    path: PathUtils.join(dir, "History"),
  });
  await again.execute(
    "INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES ('https://no-local-state.example/', 'Later', 1, 0, :t, 0)",
    { t: chromeTime(Date.now() - 86400000) }
  );
  await again.close();
  const [bare] = await findProfiles([{ source: "chrome", dir: root }]);
  Assert.equal(bare.id, "Default");
  await importHistory(bare);
  Assert.ok(
    await PlacesUtils.history.fetch("https://no-local-state.example/"),
    "the visit is in Places"
  );

  // A profile the migrator does not read from imports nothing.
  const elsewhere = await makeRoot("history-elsewhere");
  Assert.equal(
    await importHistory({
      source: "chrome",
      id: "Default",
      name: null,
      dir: await makeProfile(elsewhere, "Default"),
    }),
    0
  );
});
