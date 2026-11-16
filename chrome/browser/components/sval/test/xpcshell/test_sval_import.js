/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { importFailureKind, runImport } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImport.sys.mjs"
);
const { EXPORT_STEPS, SOURCE_NAMES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
);
const { SvalPasswordManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalFavoritesStore, FAVORITES_ROOT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);
const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

do_get_profile();

/** Empty Favorites over an engine of their own. */
async function emptyFavorites() {
  const engine = new SvalEngine({
    root: await makeTempDir("sval-import"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => engine.terminate());
  const store = new SvalFavoritesStore({ engine });
  await store.start();
  registerCleanupFunction(() => store.stop());
  return store;
}

/** An engine that keeps what it is asked to do. */
function recordingEngine() {
  return {
    mutations: [],
    async mutate(op) {
      this.mutations.push(op);
      return null;
    },
  };
}

const CHROME_DEFAULT = {
  source: "chrome",
  id: "Default",
  name: null,
  dir: "/nowhere",
};

function harvest(extra = {}) {
  const h = {
    windows: [
      {
        kind: "window",
        name: null,
        emoji: null,
        color: null,
        children: [{ type: "tab", title: "A", url: "https://a.example/" }],
      },
    ],
    bookmarks: {
      toolbar: [
        { type: "bookmark", title: "Bar", url: "https://bar.example/" },
      ],
      menu: [
        {
          type: "folder",
          title: "Folder",
          children: [
            { type: "bookmark", title: "In", url: "https://in.example/" },
          ],
        },
      ],
      other: [],
    },
    logins: null,
    encryptedSession: false,
    skipped: 0,
    ...extra,
  };
  h.parts ??= [{ profile: CHROME_DEFAULT, bookmarks: h.bookmarks }];
  return h;
}

function entry(extra = {}) {
  return {
    browser: { source: "chrome", profiles: [CHROME_DEFAULT] },
    harvest: harvest(),
    windows: [{ import: true, name: "Chrome Window 1" }],
    bookmarks: "favorites",
    bookmarksName: "Chrome Bookmarks",
    history: false,
    ...extra,
  };
}

add_task(
  async function one_source_is_one_batch_and_favorites_land_in_the_document() {
    const favorites = await emptyFavorites();
    const engine = recordingEngine();
    let n = 0;
    const report = await runImport([entry()], {
      engine,
      favorites,
      mintId: () => `id-${++n}`,
    });

    Assert.equal(engine.mutations.length, 1, "the tree changes in one call");
    const [batch] = engine.mutations;
    Assert.equal(batch.kind, "batch");
    Assert.deepEqual(
      batch.ops.map(op => op.kind),
      ["addWorkspace", "addTab"]
    );
    Assert.deepEqual(report.workspaces, ["id-1"]);
    Assert.equal(report.tabs, 1);
    Assert.equal(report.favorites, 2);
    Assert.deepEqual(report.failed, []);

    const [onToolbar] = favorites.favoritesWithUrl("https://bar.example/");
    Assert.equal(onToolbar.parentGuid, FAVORITES_ROOT);
    const [inFolder] = favorites.favoritesWithUrl("https://in.example/");
    const folder = favorites.get(inFolder.parentGuid);
    Assert.equal(folder.name, "Folder");
    Assert.equal(
      folder.parentGuid,
      FAVORITES_ROOT,
      "the menu's one folder is a folder in Favorites"
    );
  }
);

add_task(async function a_second_import_adds_no_second_bookmark() {
  const favorites = await emptyFavorites();
  const engine = recordingEngine();
  await runImport([entry({ windows: [{ import: false, name: "" }] })], {
    engine,
    favorites,
  });
  const again = await runImport(
    [entry({ windows: [{ import: false, name: "" }] })],
    { engine, favorites }
  );
  Assert.equal(again.favorites, 0, "every URL is already a favorite");
  Assert.equal(favorites.favoritesWithUrl("https://bar.example/").length, 1);
  Assert.equal(engine.mutations.length, 0, "no window was ticked");
});

/**
 * An Arc pin arrives a pin and no favorite, in its source's order after the
 * pins already there, in the same batch as the favorites (pins-root spec
 * §7).
 */
add_task(async function a_pinned_bookmark_arrives_pinned() {
  const favorites = await emptyFavorites();
  await favorites.insertTree([], {
    pins: [{ title: "Old", url: "https://old.example/" }],
  });
  const bookmarks = {
    toolbar: [
      {
        type: "bookmark",
        title: "Mail",
        url: "https://mail.example/",
        pinned: true,
      },
      { type: "bookmark", title: "Plain", url: "https://plain.example/" },
      {
        type: "folder",
        title: "Team",
        pinned: true,
        children: [
          { type: "bookmark", title: "Wiki", url: "https://wiki.example/" },
          { type: "bookmark", title: "Docs", url: "https://docs.example/" },
        ],
      },
    ],
    menu: [],
    other: [],
  };
  const report = await runImport(
    [
      entry({
        harvest: harvest({ bookmarks }),
        windows: [{ import: false, name: "" }],
      }),
    ],
    { engine: recordingEngine(), favorites }
  );
  Assert.equal(report.favorites, 4);
  Assert.deepEqual(
    favorites.home().map(tile => tile.name),
    ["Old", "Mail", "Team"],
    "the pins follow the row's own, in the source's order"
  );
  Assert.ok(
    !favorites.pinsWithUrl("https://plain.example/").length,
    "only what the source pinned is pinned"
  );
  Assert.ok(
    !favorites.isFavorite("https://mail.example/"),
    "and a pin is no favorite"
  );
});

add_task(async function the_first_window_fills_the_first_launch_workspace() {
  const engine = recordingEngine();
  let n = 0;
  const report = await runImport(
    [entry({ bookmarks: "none" }), entry({ bookmarks: "none" })],
    { engine, reuseWorkspace: "first", mintId: () => `id-${++n}` }
  );
  Assert.deepEqual(report.workspaces, ["first", "id-2"]);
  Assert.equal(engine.mutations[0].ops[0].kind, "rename");
  Assert.equal(engine.mutations[1].ops[0].kind, "addWorkspace");
});

add_task(async function a_failing_source_costs_only_itself() {
  const progress = [];
  const engine = {
    calls: 0,
    async mutate() {
      if (++this.calls === 1) {
        throw new Error("refused");
      }
    },
  };
  const report = await runImport(
    [
      entry({ bookmarks: "none" }),
      entry({
        bookmarks: "none",
        browser: {
          source: "edge",
          profiles: [{ source: "edge", id: "Default", name: null, dir: "/x" }],
        },
      }),
    ],
    { engine, onProgress: p => progress.push(p) }
  );
  Assert.deepEqual(report.failed, ["chrome"]);
  Assert.equal(report.workspaces.length, 1);
  Assert.deepEqual(
    progress,
    [
      {
        source: "chrome",
        done: 1,
        total: 2,
        ok: false,
        kind: "data",
        error: "Error",
      },
      { source: "edge", done: 2, total: 2, ok: true, kind: null, error: null },
    ],
    "each source says how it went as it finishes"
  );
});

/**
 * A source that failed part way keeps what landed, and running the same
 * entry again adds only the rest: its window's workspace is not made twice.
 */
add_task(async function a_second_run_adds_only_what_did_not_land() {
  const engine = recordingEngine();
  const e = entry();
  const first = await runImport([e], { engine, favorites: null });
  Assert.deepEqual(first.failed, ["chrome"]);
  Assert.equal(first.workspaces.length, 1, "the window landed");

  const favorites = await emptyFavorites();
  const again = await runImport([e], { engine, favorites });
  Assert.deepEqual(again.failed, []);
  Assert.equal(engine.mutations.length, 1, "no second batch of windows");
  Assert.deepEqual(again.workspaces, []);
  Assert.equal(again.favorites, 2, "the bookmarks arrive");
});

/**
 * Messages spec §7: a browser whose files could not be opened is told apart
 * from one whose data was not understood, by the error the reader met.
 */
add_task(function import_failure_kind_reads_the_cause() {
  const wrapped = name => new Error("x", { cause: new DOMException("", name) });
  for (const name of ["NotFoundError", "NotAllowedError"]) {
    Assert.equal(importFailureKind(wrapped(name)), "open", name);
  }
  Assert.equal(
    importFailureKind(wrapped("NotReadableError")),
    "data",
    "IOUtils also says NotReadableError of content it cannot decode"
  );
  Assert.equal(importFailureKind(wrapped("SyntaxError")), "data");
  Assert.equal(importFailureKind(new Error("x")), "data", "no cause");
  Assert.equal(
    importFailureKind(new DOMException("", "NotFoundError")),
    "data",
    "only a reader's wrapped cause says the files could not be opened"
  );
  Assert.equal(importFailureKind(undefined), "data");
});

add_task(function every_source_and_manager_has_its_hand_off_steps() {
  // A bookmarks file holds no passwords, so it has nothing to export, and
  // Orion offers no export of its own.
  const browsers = Object.keys(SOURCE_NAMES).filter(
    s => !["html", "orion"].includes(s)
  );
  for (const source of browsers) {
    Assert.ok(EXPORT_STEPS[source], `${source} says how to export`);
  }
  for (const manager of SvalPasswordManager.MANAGERS) {
    Assert.ok(manager.importSteps, `${manager.key} says how to import`);
  }
});

add_task(async function an_isolated_window_adds_an_isolated_workspace() {
  const engine = recordingEngine();
  let n = 0;
  const windows = [{ import: true, name: "Chrome Window 1", isolated: true }];
  await runImport([entry({ bookmarks: "none", windows })], {
    engine,
    mintId: () => `id-${++n}`,
  });
  const [batch] = engine.mutations;
  Assert.equal(batch.ops[0].kind, "addWorkspace");
  Assert.equal(batch.ops[0].isolated, true);
});

/**
 * Arc's choice for archiving idle tabs, kept by the import step's checkbox,
 * becomes the global choice as the import runs (idle-tab archive spec §7.5).
 * An entry without one leaves the choice alone.
 */
add_task(async function a_kept_archive_choice_becomes_the_global_one() {
  const pref = "browser.sval.tabs.autoArchive";
  registerCleanupFunction(() => Services.prefs.clearUserPref(pref));
  let n = 0;
  const mintId = () => `id-${++n}`;
  await runImport([entry({ bookmarks: "none", autoArchive: null })], {
    engine: recordingEngine(),
    mintId,
  });
  Assert.ok(
    !Services.prefs.prefHasUserValue(pref),
    "nothing kept, nothing set"
  );
  await runImport([entry({ bookmarks: "none", autoArchive: "12h" })], {
    engine: recordingEngine(),
    mintId,
  });
  Assert.equal(Services.prefs.getStringPref(pref), "12h");
});

/**
 * The card Arc gave its user becomes the user's card as the import runs, and
 * the report says so, so the import page can show it.
 */
add_task(async function arcs_card_becomes_the_users_card() {
  const pref = "browser.sval.card";
  registerCleanupFunction(() => Services.prefs.clearUserPref(pref));
  const arcCard = {
    title: "VAGUE ARCHIVIST",
    seed: 42,
    since: "2024-05-17",
    shape: 3,
    palette: 4,
  };
  let n = 0;
  const report = await runImport(
    [entry({ bookmarks: "none", harvest: harvest({ arcCard }) })],
    { engine: recordingEngine(), mintId: () => `id-${++n}` }
  );
  Assert.ok(report.card, "the report says the card came");
  const card = JSON.parse(Services.prefs.getStringPref(pref));
  Assert.equal(card.title, "VAGUE ARCHIVIST");
  Assert.equal(card.since, "2024-05-17");
  Assert.deepEqual(card.arc, { shape: 3, palette: 4 });
});

/**
 * An Archive that keeps what it is handed, and refuses while `refusing`.
 *
 * @param {boolean} ready Whether its document is open.
 * @returns {object}
 */
function recordingArchive(ready) {
  return {
    ready,
    refusing: false,
    handed: [],
    async importEntries(entries) {
      if (this.refusing) {
        throw new Error("sval: refused");
      }
      this.handed.push(entries);
      return entries.map((_, i) => `entry-${i}`);
    },
  };
}

function archivedHarvest() {
  return harvest({
    windows: [
      {
        kind: "space",
        name: "Space",
        emoji: null,
        color: null,
        source: "s1",
        children: [{ type: "tab", title: "A", url: "https://a.example/" }],
      },
    ],
    archived: [
      { title: "Old", url: "https://old.example/", closedAt: 5, source: "s1" },
    ],
  });
}

add_task(async function archived_tabs_go_to_the_archive_with_their_workspace() {
  const archive = recordingArchive(true);
  let n = 0;
  const report = await runImport(
    [
      entry({
        harvest: archivedHarvest(),
        windows: [{ import: true, name: "Space" }],
        bookmarks: "none",
      }),
    ],
    { engine: recordingEngine(), archive, mintId: () => `id-${++n}` }
  );
  Assert.deepEqual(report.failed, []);
  Assert.equal(report.archived, 1);
  Assert.deepEqual(archive.handed, [
    [
      {
        title: "Old",
        url: "https://old.example/",
        workspace: report.workspaces[0],
        workspaceName: "Space",
        closedAt: 5,
      },
    ],
  ]);
});

add_task(async function try_again_hands_the_archive_what_it_refused() {
  const archive = recordingArchive(true);
  archive.refusing = true;
  const engine = recordingEngine();
  const plan = [
    entry({
      harvest: archivedHarvest(),
      windows: [{ import: true, name: "Space" }],
      bookmarks: "none",
    }),
  ];
  const first = await runImport(plan, { engine, archive });
  Assert.deepEqual(first.failed, ["chrome"]);
  Assert.equal(first.archived, 0);

  archive.refusing = false;
  const again = await runImport(plan, { engine, archive });
  Assert.deepEqual(again.failed, []);
  Assert.equal(again.archived, 1);
  Assert.equal(engine.mutations.length, 1, "the windows landed once");
  Assert.equal(archive.handed[0][0].workspace, first.workspaces[0]);
});

add_task(async function an_archive_not_open_yet_takes_them_later() {
  let release;
  const archive = {
    ready: false,
    handed: [],
    importEntries(entries) {
      this.handed.push(entries);
      return new Promise(resolve => (release = resolve));
    },
  };
  const report = await runImport(
    [
      entry({
        harvest: archivedHarvest(),
        windows: [{ import: true, name: "Space" }],
        bookmarks: "none",
      }),
    ],
    { engine: recordingEngine(), archive }
  );
  Assert.deepEqual(report.failed, [], "the import ends without waiting");
  Assert.equal(archive.handed.length, 1);
  release([]);
});
