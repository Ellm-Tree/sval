/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from import_engine_head.js */

const { defaultRoots, findProfiles, harvest } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportZen.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

do_get_profile();

const WORK = "{8f1d5a1e-0000-4000-8000-000000000001}";
const HOME = "{8f1d5a1e-0000-4000-8000-000000000002}";

const tab = (url, title, extra = {}) => ({
  entries: [{ url, title }],
  index: 1,
  zenSyncId: `tab-${url}`,
  ...extra,
});

// Shaped as `ZenSessionManager` writes `zen-sessions.jsonlz4`: one sidebar
// for every window, its tabs in Zen's order.
const SIDEBAR = {
  lastCollected: 1,
  spaces: [
    {
      uuid: HOME,
      name: "Home",
      icon: "chrome://browser/skin/zen-icons/selectable/star.svg",
      position: 2000,
      theme: null,
    },
    {
      uuid: WORK,
      name: "Work",
      icon: "💼",
      position: 1000,
      theme: {
        type: "gradient",
        gradientColors: [
          { c: [40, 200, 60], isPrimary: false },
          { c: [220, 30, 30], isPrimary: true },
        ],
        opacity: 0.5,
        texture: 0,
      },
    },
  ],
  folders: [
    {
      id: "folder-outer",
      name: "Projects",
      pinned: true,
      parentId: null,
      workspaceId: WORK,
      emptyTabIds: [],
    },
    {
      id: "folder-inner",
      name: "Current",
      pinned: true,
      parentId: "folder-outer",
      workspaceId: WORK,
      emptyTabIds: [],
    },
    {
      id: "folder-empty",
      name: "Empty",
      pinned: true,
      parentId: null,
      workspaceId: WORK,
      emptyTabIds: ["tab-empty"],
    },
    {
      id: "split-1",
      splitViewGroup: true,
      parentId: "folder-outer",
      workspaceId: WORK,
      emptyTabIds: [],
    },
  ],
  groups: [
    { id: "group-1", name: "Reading", color: "purple" },
    { id: "split-2", name: "", color: "blue", splitView: true },
  ],
  // Shaped as `ZenViewSplitter.storeDataForSessionStore` writes it: a `vsep`
  // split is one row of panes, a `grid` split columns of two in a row.
  splitViewData: [
    {
      groupId: "split-1",
      gridType: "vsep",
      layoutTree: {
        type: "splitter",
        direction: "row",
        // The user moved Split two to the left, in the split only.
        children: [
          {
            type: "leaf",
            tabId: "tab-https://split-two.example/",
            sizeInParent: 40,
          },
          {
            type: "leaf",
            tabId: "tab-https://split.example/",
            sizeInParent: 60,
          },
        ],
      },
      tabs: ["tab-https://split.example/", "tab-https://split-two.example/"],
    },
    {
      groupId: "split-2",
      gridType: "grid",
      layoutTree: {
        type: "splitter",
        direction: "row",
        children: [
          {
            type: "splitter",
            direction: "column",
            sizeInParent: 70,
            children: [
              {
                type: "leaf",
                tabId: "tab-https://g1.example/",
                sizeInParent: 50,
              },
              {
                type: "leaf",
                tabId: "tab-https://g2.example/",
                sizeInParent: 50,
              },
            ],
          },
          { type: "leaf", tabId: "tab-https://g3.example/", sizeInParent: 30 },
        ],
      },
      tabs: [
        "tab-https://g1.example/",
        "tab-https://g2.example/",
        "tab-https://g3.example/",
      ],
    },
  ],
  tabs: [
    tab("https://mail.example/", "Mail", {
      pinned: true,
      zenEssential: true,
      zenStaticLabel: "Inbox",
    }),
    tab("https://outer.example/", "Outer", {
      pinned: true,
      zenWorkspace: WORK,
      groupId: "folder-outer",
    }),
    tab("https://inner.example/", "Inner", {
      pinned: true,
      zenWorkspace: WORK,
      groupId: "folder-inner",
    }),
    tab("https://split.example/", "Split", {
      pinned: true,
      zenWorkspace: WORK,
      groupId: "split-1",
    }),
    tab("https://split-two.example/", "Split two", {
      pinned: true,
      zenWorkspace: WORK,
      groupId: "split-1",
    }),
    tab("about:blank", "", {
      zenWorkspace: WORK,
      groupId: "folder-empty",
      zenIsEmpty: true,
    }),
    tab("https://work.example/", "Work tab", { zenWorkspace: WORK }),
    tab("https://glance.example/", "Glance", {
      zenWorkspace: WORK,
      zenIsGlance: true,
    }),
    tab("https://read.example/", "Read", {
      zenWorkspace: HOME,
      groupId: "group-1",
    }),
    ...["g1", "g2", "g3"].map(name =>
      tab(`https://${name}.example/`, name, {
        zenWorkspace: HOME,
        groupId: "split-2",
      })
    ),
    tab("about:preferences", "Settings", { zenWorkspace: HOME }),
    tab("https://home.example/", "Home tab", { zenWorkspace: HOME }),
    tab("https://lost.example/", "Lost", { zenWorkspace: "{gone}" }),
  ],
};

const EXPECTED_WINDOWS = [
  {
    kind: "space",
    name: "Work",
    emoji: "💼",
    color: "red",
    children: [
      {
        type: "group",
        name: "Projects",
        color: null,
        children: [
          { type: "tab", title: "Outer", url: "https://outer.example/" },
          {
            type: "group",
            name: "Current",
            color: null,
            children: [
              { type: "tab", title: "Inner", url: "https://inner.example/" },
            ],
          },
          // A split view in its folder, its `vsep` panes in the order and
          // at the widths it shows them.
          {
            type: "split",
            name: null,
            shares: [40, 60],
            children: [
              {
                type: "tab",
                title: "Split two",
                url: "https://split-two.example/",
              },
              { type: "tab", title: "Split", url: "https://split.example/" },
            ],
          },
        ],
      },
      { type: "tab", title: "Work tab", url: "https://work.example/" },
    ],
  },
  {
    kind: "space",
    name: "Home",
    emoji: null,
    color: null,
    children: [
      {
        type: "group",
        name: "Reading",
        color: "purple",
        children: [
          { type: "tab", title: "Read", url: "https://read.example/" },
        ],
      },
      // A `grid` split, side by side with equal widths.
      {
        type: "split",
        name: null,
        shares: null,
        children: ["g1", "g2", "g3"].map(name => ({
          type: "tab",
          title: name,
          url: `https://${name}.example/`,
        })),
      },
      { type: "tab", title: "Home tab", url: "https://home.example/" },
    ],
  },
  {
    kind: "window",
    name: null,
    emoji: null,
    color: null,
    children: [{ type: "tab", title: "Lost", url: "https://lost.example/" }],
  },
];

async function makeZen(name) {
  const root = await makeTempDir(`sval-zen-${name}`);
  const dir = PathUtils.join(root, "Profiles", "xyz.Default (release)");
  await IOUtils.makeDirectory(dir);
  await IOUtils.writeUTF8(
    PathUtils.join(root, "profiles.ini"),
    [
      "[Profile0]",
      "Name=Default (release)",
      "IsRelative=1",
      "Path=Profiles/xyz.Default (release)",
      "",
      "[General]",
      "Version=2",
      "",
    ].join("\n")
  );
  return { root, dir };
}

add_task(async function profiles_are_zen_profiles() {
  const { root, dir } = await makeZen("list");
  Assert.deepEqual(await findProfiles([root]), [
    {
      source: "zen",
      id: "Profiles/xyz.Default (release)",
      name: "Default (release)",
      dir,
    },
  ]);
});

add_task(function zen_is_looked_for_where_it_keeps_its_profiles() {
  const roots = defaultRoots().map(root => PathUtils.filename(root));
  const expected = {
    macosx: ["zen"],
    win: ["zen"],
  }[AppConstants.platform] ?? [".zen", "zen", ".zen"];
  Assert.deepEqual(roots, expected, AppConstants.platform);
});

add_task(async function spaces_folders_and_essentials() {
  const { dir } = await makeZen("harvest");
  await IOUtils.writeJSON(
    PathUtils.join(dir, "zen-sessions.jsonlz4"),
    SIDEBAR,
    {
      compress: true,
    }
  );
  const h = await harvest({ source: "zen", id: "p", dir });
  Assert.deepEqual(h.windows, EXPECTED_WINDOWS);
  Assert.deepEqual(
    h.bookmarks,
    {
      toolbar: [
        {
          type: "bookmark",
          title: "Inbox",
          url: "https://mail.example/",
          pinned: true,
        },
      ],
      menu: [],
      other: [],
    },
    "Essentials are pinned Favorites, under the name the user gave them"
  );
  Assert.equal(h.logins, null);
  Assert.equal(h.skipped, 1, "the settings page is skipped");

  // Shaped as `harvestBrowser` hands it on: the import reads the profile's
  // bookmarks again from its part.
  const profile = { source: "zen", id: "p", dir };
  const { store } = await importedFavorites(
    { ...h, parts: [{ profile, harvest: h }] },
    "zen"
  );
  Assert.deepEqual(
    store.home().map(tile => tile.name),
    ["Inbox"],
    "an Essential lands in the document pinned"
  );
});

add_task(async function a_split_view_imports_as_a_split() {
  const { dir } = await makeZen("splits");
  await IOUtils.writeJSON(
    PathUtils.join(dir, "zen-sessions.jsonlz4"),
    SIDEBAR,
    { compress: true }
  );
  const [work, home] = await importedTree(
    await harvest({ source: "zen", id: "p", dir }),
    "zen"
  );
  Assert.deepEqual(
    work[0].children[2],
    {
      split: "",
      shares: [40, 60],
      panes: ["https://split-two.example/", "https://split.example/"],
    },
    "a vsep split keeps its widths"
  );
  Assert.deepEqual(
    home[1],
    {
      split: "",
      shares: null,
      panes: ["g1", "g2", "g3"].map(name => `https://${name}.example/`),
    },
    "a grid split lands side by side with equal widths"
  );
});

add_task(async function the_session_file_stands_in_for_the_sidebar() {
  const { dir } = await makeZen("session");
  await IOUtils.makeDirectory(PathUtils.join(dir, "sessionstore-backups"));
  await IOUtils.writeJSON(
    PathUtils.join(dir, "sessionstore-backups", "recovery.jsonlz4"),
    {
      windows: [
        { isPrivate: true, tabs: [tab("https://secret.example/", "S")] },
        { ...SIDEBAR },
      ],
    },
    { compress: true }
  );
  const h = await harvest({ source: "zen", id: "p", dir });
  Assert.deepEqual(h.windows, EXPECTED_WINDOWS);
});

// A profile as Zen 1.23.3b wrote it, in data/import/zen: its sidebar, its
// shutdown session and its recovery file, with form data, storage, favicons
// and closed tabs removed, and its places.sqlite with a few visits deleted.
// Three Spaces, a pinned folder in the first and two Essentials.
const REAL_PROFILE = do_get_file("data/import/zen").path;

const tabNode = (title, url) => ({ type: "tab", title, url });
const space = (name, emoji, color, children) => ({
  kind: "space",
  name,
  emoji,
  color,
  children,
});
const mark = (title, url) => ({ type: "bookmark", title, url });

const MICROSOFT = tabNode(
  "Microsoft – AI, Cloud, Productivity, Computing, Gaming & Apps",
  "https://www.microsoft.com/en-us"
);

/**
 * The real profile's Spaces, as each of its session files holds them.
 *
 * @param {object[]} lastSpace The tabs of the Space named "NAME OF SPACE!".
 * @returns {object[]}
 */
const realSpaces = lastSpace => [
  space("Space", null, "red", [
    // A pinned folder, which has no colour of its own.
    {
      type: "group",
      name: "zen basics",
      color: null,
      children: [
        tabNode("Wikipedia", "https://www.wikipedia.org/"),
        tabNode("Welcome!", "https://zen-browser.app/welcome/"),
      ],
    },
    tabNode("Reddit - The heart of the internet", "https://www.reddit.com/"),
    tabNode(
      "Associated Press News: Breaking News, Latest Headlines and Videos | AP News",
      "https://apnews.com/"
    ),
  ]),
  space("NAME", "🥰", "cyan", [tabNode("hello network", "https://hello.com/")]),
  space("NAME OF SPACE!", "🤷", "yellow", lastSpace),
];

const REAL_BOOKMARKS = {
  // The Essentials, pinned, then the profile's own toolbar, which is empty.
  toolbar: [
    {
      ...mark(
        "50 Types of Meat with Names and Pictures - Grammareer",
        "https://www.grammareer.com/types-of-meat-with-names/"
      ),
      pinned: true,
    },
    {
      ...mark(
        "237+ Shades of Green Color (Names, HEX, RGB, & CMYK Codes) – CreativeBooster",
        "https://creativebooster.net/blogs/colors/shades-of-green-color-names-hex-rgb-codes"
      ),
      pinned: true,
    },
  ],
  menu: [
    {
      type: "folder",
      title: "Mozilla Firefox",
      children: [
        mark("Get Help", "https://support.mozilla.org/products/firefox"),
        mark(
          "Customize Firefox",
          "https://support.mozilla.org/kb/customize-firefox-controls-buttons-and-toolbars?utm_source=firefox-browser&utm_medium=default-bookmarks&utm_campaign=customize"
        ),
        mark("Get Involved", "https://www.mozilla.org/contribute/"),
        mark("About Us", "https://www.mozilla.org/about/"),
      ],
    },
  ],
  other: [],
};

add_task(async function a_real_zen_profile() {
  const root = await makeTempDir("sval-zen-real");
  await IOUtils.writeUTF8(
    PathUtils.join(root, "profiles.ini"),
    `[Profile0]\nName=main\nIsRelative=0\nPath=${REAL_PROFILE}\n`
  );
  const profiles = await findProfiles([root]);
  Assert.deepEqual(profiles, [
    { source: "zen", id: REAL_PROFILE, name: "main", dir: REAL_PROFILE },
  ]);
  // The pinned folder holds the empty tab Zen keeps in it, which is not
  // offered.
  Assert.deepEqual(await harvest(profiles[0]), {
    windows: realSpaces([
      MICROSOFT,
      tabNode("Apple", "https://www.apple.com/"),
    ]),
    bookmarks: REAL_BOOKMARKS,
    logins: null,
    encryptedSession: false,
    skipped: 0,
  });
});

add_task(async function a_real_zen_session_stands_in_for_its_sidebar() {
  // The real profile's session files without its sidebar. The recovery
  // file, read first as it is while Zen runs, lacks the microsoft.com tab
  // the shutdown session holds. Both hold an empty tab in the last Space.
  const dir = await makeTempDir("sval-zen-real-session");
  await IOUtils.makeDirectory(PathUtils.join(dir, "sessionstore-backups"));
  const recovery = ["sessionstore-backups", "recovery.jsonlz4"];
  await IOUtils.copy(
    PathUtils.join(REAL_PROFILE, ...recovery),
    PathUtils.join(dir, ...recovery)
  );
  await IOUtils.copy(
    PathUtils.join(REAL_PROFILE, "sessionstore.jsonlz4"),
    PathUtils.join(dir, "sessionstore.jsonlz4")
  );
  const profile = { source: "zen", id: "p", name: null, dir };
  Assert.deepEqual(
    (await harvest(profile)).windows,
    realSpaces([tabNode("Apple", "https://www.apple.com/")])
  );

  await IOUtils.remove(PathUtils.join(dir, ...recovery));
  Assert.deepEqual(
    (await harvest(profile)).windows,
    realSpaces([MICROSOFT, tabNode("Apple", "https://www.apple.com/")])
  );
});

add_task(async function a_corrupt_sidebar_throws_a_clean_error() {
  const { dir } = await makeZen("corrupt");
  await IOUtils.writeUTF8(PathUtils.join(dir, "zen-sessions.jsonlz4"), "nope");
  await Assert.rejects(
    harvest({ source: "zen", id: "p", dir }),
    e =>
      /^Zen sidebar could not be read \(\w+\)$/.test(e.message) &&
      !e.message.includes(dir)
  );
});

add_task(async function an_empty_profile_has_nothing() {
  const { dir } = await makeZen("empty");
  const h = await harvest({ source: "zen", id: "p", dir });
  Assert.deepEqual(h.windows, []);
  Assert.equal(h.bookmarks, null);
});
