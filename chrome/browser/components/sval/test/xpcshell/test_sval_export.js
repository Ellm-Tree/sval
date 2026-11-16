/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Export (`SvalExport.sys.mjs`, `SvalExportModel.sys.mjs`, export spec §7):
 * each file read back the way its target's importer reads it.
 */

const { exportBytes } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExport.sys.mjs"
);
const { exportableWorkspaces, windowsOf, WORKSPACES_FOLDER } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalExportModel.sys.mjs"
  );
const { parseBookmarksHtml } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportHtml.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { BookmarkJSONUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/BookmarkJSONUtils.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { SvalFavoritesStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);
const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

do_get_profile();

/**
 * An engine holding two workspaces of the user's, one with a group, an
 * empty one, and an agent's.
 */
async function engineWithWorkspaces() {
  const engine = new SvalEngine({
    root: await makeTempDir("sval-export"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => engine.terminate());
  const now = Date.now();
  const id = () => crypto.randomUUID();
  const work = id();
  const group = id();
  const play = id();
  const ops = [
    { kind: "addWorkspace", id: work, name: "Work", icon: null },
    {
      kind: "addTab",
      id: id(),
      parent: work,
      name: "Mail",
      url: "https://mail.example/",
    },
    { kind: "addGroup", id: group, parent: work, name: "Research", icon: null },
    {
      kind: "addTab",
      id: id(),
      parent: group,
      name: "Paper",
      url: "https://paper.example/",
    },
    {
      kind: "addTab",
      id: id(),
      parent: group,
      name: "",
      url: "https://notes.example/",
    },
    {
      kind: "addTab",
      id: id(),
      parent: work,
      name: "New tab",
      url: "about:newtab",
    },
    {
      kind: "addTab",
      id: id(),
      parent: work,
      name: "Docs",
      url: "https://docs.example/",
    },
    { kind: "addWorkspace", id: play, name: "Play & <fun>", icon: null },
    {
      kind: "addTab",
      id: id(),
      parent: play,
      name: "Video",
      url: "https://video.example/?a=1&b=2",
    },
    { kind: "addWorkspace", id: id(), name: "", icon: null },
  ];
  await engine.mutate({ kind: "batch", ops, now });
  await engine.mutate({
    kind: "addAgentWorkspace",
    name: "Agent work",
    agentLabel: "Test Agent",
    id: id(),
    now,
  });
  return engine;
}

/**
 * The profile's Favorites over `engine`, holding two favorites and a folder
 * in Favorites and one in Other Favorites.
 *
 * @param {SvalEngine} engine
 */
async function withFavorites(engine) {
  const store = await SvalFavoritesStore.startFor(engine);
  registerCleanupFunction(() => SvalFavoritesStore.stopShared());
  await store.insertTree([
    { title: "News", url: "https://news.example/" },
    {
      title: "Shops",
      children: [{ title: "Books", url: "https://books.example/" }],
    },
  ]);
  await store.insertTree([{ title: "Later", url: "https://later.example/" }], {
    parentGuid: "unfiled_____",
  });
}

async function allWorkspaces(engine) {
  const { nodes } = await engine.tree();
  return exportableWorkspaces(nodes).map(w => w.id);
}

/**
 * A bookmarks file as Chromium's importer reads it
 * (`content_bookmark_parser_utils.cc` `ParseBookmarksUnsafe`), then files it
 * into an empty bookmarks bar as `ProfileWriter::AddBookmarks` does: an
 * entry's path is the folders around it, the folder marked
 * `PERSONAL_TOOLBAR_FOLDER` is the bar, whose entries go straight onto an
 * empty bar, and everything else goes into a folder named "Imported" on the
 * bar.
 *
 * @param {string} text The file.
 * @returns {object} The bar, a tree of `{ title, url }` and
 *   `{ title, children }`.
 */
function chromiumImport(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const entries = [];
  const walk = (dl, path, toolbarIndex) => {
    for (const dt of dl.querySelectorAll(":scope > dt, :scope > p > dt")) {
      const h3 = dt.querySelector(":scope > h3");
      const a = dt.querySelector(":scope > a");
      if (h3) {
        const toolbar =
          h3.getAttribute("personal_toolbar_folder")?.toLowerCase() === "true";
        const inner = [...path, h3.textContent];
        const list =
          dt.querySelector(":scope > dl") ??
          (dt.nextElementSibling?.localName === "dl"
            ? dt.nextElementSibling
            : null);
        walk(list, inner, toolbar ? inner.length : toolbarIndex);
      } else if (a) {
        entries.push({
          inToolbar: !!toolbarIndex,
          path: toolbarIndex ? path.slice(toolbarIndex - 1) : path,
          title: a.textContent,
          url: a.getAttribute("href"),
        });
      }
    }
  };
  walk(doc.querySelector("dl"), [], 0);
  const bar = { title: "bar", children: [] };
  const imported = { title: "Imported", children: [] };
  const folderAt = (parent, names) => {
    let node = parent;
    for (const name of names) {
      let next = node.children.find(c => c.children && c.title === name);
      if (!next) {
        next = { title: name, children: [] };
        node.children.push(next);
      }
      node = next;
    }
    return node;
  };
  for (const entry of entries) {
    const target = entry.inToolbar
      ? folderAt(bar, entry.path.slice(1))
      : folderAt(imported, entry.path);
    target.children.push({ title: entry.title, url: entry.url });
  }
  if (imported.children.length) {
    bar.children.push(imported);
  }
  return bar;
}

add_task(async function agent_workspaces_are_not_offered() {
  const engine = await engineWithWorkspaces();
  const { nodes } = await engine.tree();
  Assert.deepEqual(
    exportableWorkspaces(nodes).map(w => w.name),
    ["Work", "Play & <fun>", "Untitled Workspace"],
    "the user's workspaces, in switcher order, and no agent's"
  );
  const agent = Object.keys(nodes).find(k => nodes[k].agent);
  Assert.deepEqual(
    windowsOf(nodes, [agent]),
    [],
    "an agent's workspace is not written even when asked for"
  );
});

add_task(async function chrome_gets_favorites_on_the_bar_and_flat_workspaces() {
  const engine = await engineWithWorkspaces();
  await withFavorites(engine);
  const html = await exportBytes(
    {
      target: "chrome",
      workspaces: await allWorkspaces(engine),
      favorites: true,
    },
    { engine }
  );
  const bar = chromiumImport(html);
  Assert.deepEqual(
    bar.children.slice(0, 2),
    [
      { title: "News", url: "https://news.example/" },
      {
        title: "Shops",
        children: [{ title: "Books", url: "https://books.example/" }],
      },
    ],
    "Favorites land straight on an empty bar"
  );
  const imported = bar.children.at(-1);
  Assert.equal(imported.title, "Imported");
  Assert.deepEqual(
    imported.children[0],
    {
      title: "Later",
      url: "https://later.example/",
    },
    "Other Favorites go where Chromium puts the file's other bookmarks"
  );
  const workspaces = imported.children.find(c => c.title === WORKSPACES_FOLDER);
  Assert.deepEqual(
    workspaces.children,
    [
      {
        title: "Work",
        children: [
          { title: "Mail", url: "https://mail.example/" },
          { title: "Paper", url: "https://paper.example/" },
          { title: "https://notes.example/", url: "https://notes.example/" },
          { title: "Docs", url: "https://docs.example/" },
        ],
      },
      {
        title: "Play & <fun>",
        children: [{ title: "Video", url: "https://video.example/?a=1&b=2" }],
      },
    ],
    "each workspace is one folder of its tabs in panel order, which Open " +
      "all in new tab group opens whole; Sval's own pages and empty " +
      "workspaces are left out"
  );
});

add_task(async function svals_import_reads_the_html_back() {
  const engine = await engineWithWorkspaces();
  await withFavorites(engine);
  const html = await exportBytes(
    {
      target: "other",
      workspaces: await allWorkspaces(engine),
      favorites: true,
    },
    { engine }
  );
  const { roots } = parseBookmarksHtml(html);
  Assert.deepEqual(
    roots.toolbar.map(m => m.title),
    ["News", "Shops"]
  );
  const workspaces = roots.other.find(m => m.title === WORKSPACES_FOLDER);
  Assert.deepEqual(
    workspaces.children[0],
    {
      type: "folder",
      title: "Work",
      children: [
        { type: "bookmark", title: "Mail", url: "https://mail.example/" },
        {
          type: "folder",
          title: "Research",
          children: [
            { type: "bookmark", title: "Paper", url: "https://paper.example/" },
            {
              type: "bookmark",
              title: "https://notes.example/",
              url: "https://notes.example/",
            },
          ],
        },
        { type: "bookmark", title: "Docs", url: "https://docs.example/" },
      ],
    },
    "another browser keeps groups as folders inside the workspace's"
  );
  Assert.equal(workspaces.children[1].title, "Play & <fun>");
});

/**
 * The pins export as a folder named "Pins" at the end of Favorites, so a pin
 * exports as a bookmark (pins-root spec §7).
 */
add_task(async function the_pins_export_as_a_folder_at_the_end_of_favorites() {
  const engine = await engineWithWorkspaces();
  await withFavorites(engine);
  await SvalFavoritesStore.instance.insertTree([], {
    pins: [
      { title: "Mail", url: "https://mail.example/" },
      {
        title: "Team",
        children: [{ title: "Wiki", url: "https://wiki.example/" }],
      },
    ],
  });
  const html = await exportBytes(
    { target: "other", workspaces: [], favorites: true },
    { engine }
  );
  const { roots } = parseBookmarksHtml(html);
  Assert.deepEqual(
    roots.toolbar.map(m => m.title),
    ["News", "Shops", "Pins"]
  );
  Assert.deepEqual(roots.toolbar.at(-1).children, [
    { type: "bookmark", title: "Mail", url: "https://mail.example/" },
    {
      type: "folder",
      title: "Team",
      children: [
        { type: "bookmark", title: "Wiki", url: "https://wiki.example/" },
      ],
    },
  ]);
});

add_task(async function firefox_imports_the_json_into_its_roots() {
  const engine = await engineWithWorkspaces();
  await withFavorites(engine);
  const json = await exportBytes(
    {
      target: "firefox",
      workspaces: await allWorkspaces(engine),
      favorites: true,
    },
    { engine }
  );
  await PlacesUtils.bookmarks.eraseEverything();
  const path = tempPath("sval-export", ".json");
  await IOUtils.writeUTF8(path, json);
  // What Firefox's "Import from a file" runs for a JSON file
  // (`BookmarksFileMigrator`).
  await BookmarkJSONUtils.importFromFile(path);
  const titles = async guid =>
    (await PlacesUtils.promiseBookmarksTree(guid)).children?.map(
      c => c.title
    ) ?? [];
  Assert.deepEqual(await titles(PlacesUtils.bookmarks.toolbarGuid), [
    "News",
    "Shops",
  ]);
  Assert.deepEqual(await titles(PlacesUtils.bookmarks.unfiledGuid), [
    "Later",
    WORKSPACES_FOLDER,
  ]);
  const unfiled = await PlacesUtils.promiseBookmarksTree(
    PlacesUtils.bookmarks.unfiledGuid
  );
  const work = unfiled.children[1].children[0];
  Assert.equal(work.title, "Work");
  Assert.deepEqual(
    work.children.map(c => c.title),
    ["Mail", "Research", "Docs"]
  );
  Assert.deepEqual(
    work.children[1].children.map(c => c.uri),
    ["https://paper.example/", "https://notes.example/"]
  );
  await PlacesUtils.bookmarks.eraseEverything();
});

/**
 * The entries of a ZIP, read by Gecko's own reader, as text.
 *
 * @param {Uint8Array} bytes
 */
async function readZip(bytes) {
  const path = tempPath("sval-export", ".zip");
  await IOUtils.write(path, bytes);
  const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
    Ci.nsIZipReader
  );
  reader.open(new FileUtils.File(path));
  const out = {};
  try {
    for (const name of reader.findEntries(null)) {
      const stream = reader.getInputStream(name);
      out[name] = NetUtil.readInputStreamToString(stream, stream.available(), {
        charset: "UTF-8",
      });
      stream.close();
    }
  } finally {
    reader.close();
  }
  return out;
}

const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

add_task(async function safari_gets_its_own_zip_with_history() {
  const engine = await engineWithWorkspaces();
  await withFavorites(engine);
  await PlacesUtils.history.clear();
  const visitedAt = new Date("2026-10-01T12:00:00Z");
  await PlacesUtils.history.insert({
    url: "https://visited.example/",
    title: "Visited",
    visits: [{ date: visitedAt }, { date: new Date(visitedAt - 1000) }],
  });
  const now = new Date("2026-10-18T09:00:00Z");
  const entries = await readZip(
    await exportBytes(
      {
        target: "safari",
        workspaces: await allWorkspaces(engine),
        favorites: true,
        history: true,
      },
      { engine, date: now }
    )
  );
  Assert.deepEqual(Object.keys(entries).sort(), [
    "Bookmarks.html",
    "History.json",
  ]);
  const bar = chromiumImport(entries["Bookmarks.html"]);
  Assert.ok(
    bar.children
      .at(-1)
      .children.find(c => c.title === WORKSPACES_FOLDER)
      .children[0].children.every(c => c.url),
    "a Safari workspace is one folder of tabs too"
  );
  const history = JSON.parse(entries["History.json"]);
  Assert.equal(history.metadata.data_type, "history");
  Assert.equal(history.metadata.browser_name, "Sval");
  Assert.equal(history.metadata.export_time_usec, now.getTime() * 1000);
  Assert.equal(typeof history.metadata.schema_version, "number");
  Assert.deepEqual(history.history, [
    {
      url: "https://visited.example/",
      title: "Visited",
      time_usec: visitedAt.getTime() * 1000,
      visits_count: 2,
    },
  ]);

  const without = await readZip(
    await exportBytes(
      { target: "safari", workspaces: [], favorites: true, history: false },
      { engine, date: now }
    )
  );
  Assert.deepEqual(
    Object.keys(without),
    ["Bookmarks.html"],
    "history only when ticked"
  );
  await PlacesUtils.history.clear();
});

add_task(async function complete_data_holds_every_document_in_plain_json() {
  const engine = await engineWithWorkspaces();
  await engine.addDocument("settings");
  await engine.mutate({
    kind: "setSetting",
    document: "settings",
    key: "browser.sval.example",
    valueJson: "true",
    now: Date.now(),
  });
  await engine.addDocument("history-index");
  await engine.mutate({
    kind: "touchShard",
    document: "history-index",
    name: "history-2020-W01",
    now: Date.now(),
  });
  // A past week no pass holds, only in the profile.
  await engine.writeLocally("history-2020-W01", [
    {
      kind: "addVisit",
      url: "https://old.example/",
      title: "Old",
      transition: 1,
      visitedAt: Date.UTC(2020, 0, 1),
      now: Date.now(),
    },
  ]);

  const entries = await readZip(
    await exportBytes({ target: "sval" }, { engine })
  );
  Assert.deepEqual(Object.keys(entries).sort(), [
    "README.txt",
    "history-2020-W01.json",
    "history-index.json",
    "settings.json",
    "workspaces.json",
  ]);
  Assert.deepEqual(
    JSON.parse(entries["workspaces.json"]),
    JSON.parse(await engine.treeJson()),
    "the tree, agents' workspaces included"
  );
  Assert.deepEqual(
    JSON.parse(entries["settings.json"]),
    JSON.parse(await engine.exportJson("settings"))
  );
  Assert.ok(
    entries["history-2020-W01.json"].includes("https://old.example/"),
    "a past week of history comes out of the profile"
  );
  Assert.ok(entries["README.txt"].includes("workspaces.json"));
});
