/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A bookmarks HTML file as an import source (`SvalImportHtml.sys.mjs`,
 * favorites-native spec §15.3).
 */

const { harvest, parseBookmarksHtml } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportHtml.sys.mjs"
);
const { harvestBrowser } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
);
const { runImport } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImport.sys.mjs"
);
const { exportBytes } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExport.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalFavoritesStore, FAVORITES_ROOT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

do_get_profile();

/**
 * The process's Favorites over an engine of their own, empty, which import
 * and export reach as the profile's.
 *
 * @returns {Promise<{store: object, engine: object}>}
 */
async function emptyFavorites() {
  const engine = new SvalEngine({
    root: await makeTempDir("sval-import-html"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => engine.terminate());
  const store = await SvalFavoritesStore.startFor(engine);
  registerCleanupFunction(() => SvalFavoritesStore.stopShared());
  return { store, engine };
}

/**
 * Chromium's export: the bar marked, and Other bookmarks written loose at the
 * top under a "Bookmarks" heading.
 */
const CHROMIUM = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://bar.example/" TAGS="work" SHORTCUTURL="b">Bar</A>
        <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    </DL><p>
    <DT><A HREF="https://other.example/">Other</A>
    <DT><H3>Reading</H3>
    <DL><p>
        <DT><A HREF="https://read.example/">Read</A>
    </DL><p>
</DL><p>
`;

add_task(function chromiums_export_reads_into_the_three_roots() {
  const { roots, skipped } = parseBookmarksHtml(CHROMIUM);
  Assert.deepEqual(roots.toolbar, [
    { type: "bookmark", title: "Bar", url: "https://bar.example/" },
  ]);
  Assert.deepEqual(roots.menu, []);
  Assert.deepEqual(roots.other, [
    { type: "bookmark", title: "Other", url: "https://other.example/" },
    {
      type: "folder",
      title: "Reading",
      children: [
        { type: "bookmark", title: "Read", url: "https://read.example/" },
      ],
    },
  ]);
  Assert.equal(skipped, 1, "a bookmarklet is left out");
});

add_task(async function a_files_local_file_addresses_are_left_out() {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><A HREF="file:///Users/me/notes.html">Notes</A>
    <DT><A HREF="https://web.example/">Web</A>
</DL><p>
`;
  const path = tempPath("sval-file-addresses", ".html");
  await IOUtils.writeUTF8(path, html);

  const read = await harvest({ source: "html", dir: path });
  Assert.deepEqual(read.bookmarks.menu, [
    { type: "bookmark", title: "Web", url: "https://web.example/" },
  ]);
  Assert.equal(read.skipped, 1, "the file: address is counted as skipped");
});

add_task(async function svals_export_comes_back_as_it_left() {
  const { store, engine } = await emptyFavorites();
  await store.insertTree([
    { title: "A", url: "https://a.example/" },
    { title: "Folder", children: [{ title: "B", url: "https://b.example/" }] },
  ]);
  await store.insertTree([{ title: "C", url: "https://c.example/" }], {
    parentGuid: "unfiled_____",
  });
  const path = tempPath("sval-favorites", ".html");
  await IOUtils.writeUTF8(
    path,
    await exportBytes(
      { target: "other", workspaces: [], favorites: true },
      { engine }
    )
  );

  const read = await harvest({ source: "html", dir: path });
  Assert.ok(read.file, "the harvest says it is a file");
  Assert.deepEqual(read.windows, []);
  Assert.deepEqual(read.bookmarks.toolbar, [
    { type: "bookmark", title: "A", url: "https://a.example/" },
    {
      type: "folder",
      title: "Folder",
      children: [{ type: "bookmark", title: "B", url: "https://b.example/" }],
    },
  ]);
  Assert.deepEqual(read.bookmarks.other, [
    { type: "bookmark", title: "C", url: "https://c.example/" },
  ]);
});

add_task(async function a_legacy_encoded_file_reads_as_it_was_written() {
  const html =
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1252">' +
    "<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1><DL><p>" +
    '<DT><A HREF="https://cafe.example/">Caf\u00e9</A></DL><p>';
  const bytes = Uint8Array.from(html, c => c.charCodeAt(0));
  const path = tempPath("sval-legacy", ".html");
  await IOUtils.write(path, bytes);

  const read = await harvest({ source: "html", dir: path });
  Assert.deepEqual(read.bookmarks.other, [
    { type: "bookmark", title: "Caf\u00e9", url: "https://cafe.example/" },
  ]);
});

add_task(
  async function a_file_imports_into_favorites_without_tags_or_keywords() {
    const { store } = await emptyFavorites();
    const path = tempPath("sval-chromium", ".html");
    await IOUtils.writeUTF8(path, CHROMIUM);
    const profile = {
      source: "html",
      id: path,
      name: "bookmarks.html",
      dir: path,
    };
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
          bookmarksName: "bookmarks",
          history: false,
        },
      ],
      { engine: { mutate: async () => null } }
    );
    Assert.equal(report.favorites, 3);
    const [bar] = store.favoritesWithUrl("https://bar.example/");
    Assert.equal(bar.parentGuid, FAVORITES_ROOT);
    const [other] = store.favoritesWithUrl("https://other.example/");
    const folder = store.get(other.parentGuid);
    Assert.deepEqual(
      [folder.name, folder.parentGuid],
      ["Other Bookmarks", FAVORITES_ROOT],
      "other bookmarks are a folder in Favorites"
    );
    Assert.deepEqual(
      PlacesUtils.tagging.getTagsForURI(Services.io.newURI(bar.url)),
      [],
      "no tag"
    );
    Assert.equal(
      await PlacesUtils.keywords.fetch({ url: bar.url }),
      null,
      "no keyword"
    );
    let marks = 0;
    await PlacesUtils.bookmarks.fetch({ url: bar.url }, () => marks++);
    Assert.equal(marks, 0, "Places holds no bookmark of it");
  }
);

add_task(async function importing_a_file_twice_adds_no_second_favorite() {
  const { store } = await emptyFavorites();
  const favoriteUrls = () =>
    store
      .all()
      .filter(row => row.url)
      .map(row => row.url)
      .sort();
  // Two spellings of one page, neither as a favorite holds it, and a page
  // spelled the way one does.
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><A HREF="HTTPS://Spelled.EXAMPLE">Upper</A>
    <DT><A HREF="https://spelled.example">Lower</A>
    <DT><A HREF="https://plain.example/">Plain</A>
</DL><p>
`;
  const path = tempPath("sval-twice", ".html");
  await IOUtils.writeUTF8(path, html);
  const profile = { source: "html", id: path, name: "twice.html", dir: path };
  const importFile = async () =>
    runImport(
      [
        {
          browser: { source: profile.source, profiles: [profile] },
          harvest: await harvestBrowser({
            source: profile.source,
            profiles: [profile],
          }),
          windows: [],
          bookmarks: "favorites",
          bookmarksName: "twice",
          history: false,
        },
      ],
      { engine: { mutate: async () => null } }
    );

  await importFile();
  const first = favoriteUrls();
  Assert.deepEqual(first, [
    "https://plain.example/",
    "https://spelled.example/",
  ]);

  const again = await importFile();
  Assert.equal(again.favorites, 0, "the second import reports none added");
  Assert.deepEqual(favoriteUrls(), first, "Favorites are unchanged");
});
