/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* `SvalPanel` is declared by a classic script the chrome window loads, so
 * there is no module to import it from. */
/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */
/* import-globals-from sval_feedback_helpers.js */

/** The import page, opened from the panel. */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_feedback_helpers.js",
  this
);
const { SOURCE_NAMES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
);

const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);
const { importReportText } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportModel.sys.mjs"
);

/**
 * @param {number} workspaces
 * @param {number} [favorites]
 * @returns {string} the summary the page gives for what arrived.
 */
function summaryOf(workspaces, favorites = 0) {
  return importReportText({
    workspaces: new Array(workspaces).fill(null),
    favorites,
    history: 0,
  });
}

/**
 * Opens the import page from the panel and waits for its Import.
 *
 * @param {object} options What `SvalPanel.openImport` takes.
 * @returns {Promise<{done: Promise, doc: Document}>}
 */
async function openImportPage(options) {
  // A task that fails with the page open would leave it over the window,
  // where it holds the next task's page in `gDialogBox`'s queue and stops
  // tabs being selected (`window-modal-open` in tabbrowser's `selectedTab`).
  atTaskEnd(closeLeftoverDialog);
  const done = SvalPanel.openImport(options);
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "the page opens");
  await dialogShown(gDialogBox.dialog, "the page's load");
  const doc = gDialogBox.dialog._frame.contentDocument;
  return { done, doc };
}

/**
 * The import page, end to end from the panel: a Space becomes a workspace
 * with its name, emoji, group and tabs, its Favorite lands in Favorites, and
 * the page stays open through the import, showing each browser's row and
 * what arrived until Done, with nothing in the panel's footer (import spec
 * §3, §5; messages spec §7).
 */
add_task(async function the_dialog_stays_open_until_done() {
  const { engine } = await withFreshPanel();
  const { store } = await favoritesFixture();
  const home = await arcFixture();

  const { done, doc } = await openImportPage({ roots: { arc: { home } } });
  await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-im-window-name"),
    "the page lists the Space"
  );
  Assert.equal(
    doc.querySelector(".sval-im-window-name").value,
    "Home",
    "a Space keeps its own name"
  );
  Assert.ok(
    doc.querySelector(".sval-im-source input[type=checkbox]").checked,
    "the only browser found is ticked"
  );
  // Import draws the run's first step before the run reads its first file,
  // so what is asserted here is the page as it starts.
  doc.querySelector(".sval-im-import").click();

  const row = doc.querySelector(".sval-im-progress-row");
  Assert.ok(gDialogBox.isOpen, "the page stays open while it runs");
  Assert.ok(BrowserTestUtils.isHidden(doc.querySelector(".sval-im-picker")));
  Assert.equal(row.dataset.state, "running", "Arc's row is running");
  Assert.equal(row.querySelector(".sval-im-progress-name").textContent, "Arc");
  Assert.equal(
    row.querySelector(".sval-im-progress-logo").getAttribute("src"),
    "chrome://browser/content/sval/import-brands/arc.png",
    "with Arc's logo beside its name"
  );
  const doneButton = doc.querySelector(".sval-im-done");
  Assert.ok(doneButton.disabled, "Done waits for the import");
  const bar = doc.querySelector(".sval-im-bar");
  Assert.equal(bar.value, 0);
  Assert.equal(bar.max, 1);
  Assert.ok(bar.getAttribute("aria-label"), "the bar is named");

  await TestUtils.waitForCondition(
    () => !doneButton.disabled,
    "the import ends"
  );
  Assert.equal(row.dataset.state, "done", "Arc's row is ticked");
  Assert.equal(bar.value, 1, "the bar is full");
  Assert.equal(
    doc.querySelector(".sval-im-result").textContent,
    summaryOf(1, 1),
    "the result counts what arrived"
  );
  Assert.equal(
    doc.querySelector(".sval-im-said[role=status]").textContent,
    summaryOf(1, 1),
    "and says it through the page's live region"
  );
  Assert.equal(doc.activeElement, doneButton, "Done takes focus");
  Assert.ok(gDialogBox.isOpen, "the page waits for Done");

  doneButton.click();
  const report = await within(done, 20_000, "the import's report");
  Assert.equal(report.workspaces.length, 1);
  Assert.equal(report.favorites, 1);
  const nodes = (await engine.tree()).nodes;
  const [id] = report.workspaces;
  Assert.equal(nodes[id].content.name, "Home");
  Assert.equal(nodes[id].appearance.emoji, "🏠");
  const children = await childrenOf(engine, id);
  Assert.deepEqual(
    children.map(c => nodes[c].content.name),
    ["Reading", "Loose"],
    "the folder became a group, before the loose tab"
  );
  Assert.deepEqual(
    (await childrenOf(engine, children[0])).map(c => nodes[c].content.url),
    ["https://example.com/one", "https://example.com/two"]
  );
  // Arc's Favorites are pins (pins-root spec §7).
  const [pin] = store.pinsWithUrl("https://example.com/fav");
  Assert.equal(pin?.parentGuid, "pins________");
});

/**
 * A browser whose files could not be opened says so in the page and offers
 * a bookmarks file instead (messages spec §7), which imports into Favorites
 * with a row of its own. Zen's bookmarks are read as the import runs, so a
 * file the system refuses then is one that cannot be opened.
 */
add_task(async function a_failed_source_offers_a_bookmarks_file() {
  await withFreshPanel();
  await favoritesFixture();
  const zen = await zenFixture();
  atTaskEnd(() => SvalTestDeny.allow(zen.sidebar));
  const { done, doc } = await importZenAfter(zen, () =>
    SvalTestDeny.read(zen.sidebar)
  );
  const doneButton = doc.querySelector(".sval-im-done");
  const line = doc.querySelector('.sval-im-result-line[data-status="error"]');
  Assert.ok(line, "the failure has a line of its own");
  Assert.deepEqual(
    resultLines(doc),
    [[summaryOf(1)], ["zen:open", "retrySource", "importBookmarksFile"]],
    "beside what arrived"
  );
  const text = line.querySelector(".sval-im-result-text").textContent;
  Assert.ok(
    doc.querySelector(".sval-im-said").textContent.includes(text),
    "and is said"
  );

  const dir = await makeTempDir("sval-import-file");
  const path = PathUtils.join(dir, "bookmarks.html");
  await IOUtils.writeUTF8(
    path,
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n" +
      '<DT><A HREF="https://example.com/from-file">From file</A>\n</DL><p>\n'
  );
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  atTaskEnd(() => MockFilePicker.cleanup());
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  MockFilePicker.setFiles([file]);
  line.querySelector("[data-command=importBookmarksFile]").click();
  const rows = doc.getElementsByClassName("sval-im-progress-row");
  await TestUtils.waitForCondition(
    () =>
      rows.length === 2 &&
      rows[1].dataset.state === "done" &&
      !doneButton.disabled,
    "the file is imported"
  );
  Assert.equal(
    rows[1].querySelector(".sval-im-progress-name").textContent,
    "bookmarks.html"
  );
  Assert.deepEqual(
    resultLines(doc),
    [[summaryOf(1, 1)], ["zen:open", "retrySource", "importBookmarksFile"]],
    "what arrived, and Zen's failure still standing"
  );
  doneButton.click();
  const report = await within(done, 20_000, "the import's report");
  Assert.equal(report.workspaces.length, 1);
  Assert.equal(report.favorites, 1);
});

/**
 * A Zen profile with one Space holding one tab.
 *
 * @returns {Promise<{root: string, sidebar: string, write: Function}>} the
 *   directory holding `profiles.ini`, the sidebar file's path, and what
 *   writes that file whole.
 */
async function zenFixture() {
  const root = await makeTempDir("sval-import-zen-root");
  const dir = PathUtils.join(root, "Profiles", "abc.Default (release)");
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  await IOUtils.writeUTF8(
    PathUtils.join(root, "profiles.ini"),
    [
      "[Profile0]",
      "Name=Default (release)",
      "IsRelative=1",
      "Path=Profiles/abc.Default (release)",
      "Default=1",
      "",
    ].join("\n")
  );
  const sidebar = PathUtils.join(dir, "zen-sessions.jsonlz4");
  const space = "{8f1d5a1e-0000-4000-8000-000000000001}";
  const write = () =>
    IOUtils.writeJSON(
      sidebar,
      {
        spaces: [{ uuid: space, name: "Home", position: 1000 }],
        tabs: [
          {
            entries: [{ url: "https://example.com/", title: "Example" }],
            index: 1,
            zenWorkspace: space,
          },
        ],
        folders: [],
        groups: [],
      },
      { compress: true }
    );
  await write();
  return { root, sidebar, write };
}

/**
 * Opens the import page over Zen, lets `between` change Zen's files once the
 * page has read them, then imports and waits for the result.
 *
 * @param {object} zen {@link zenFixture}'s answer.
 * @param {Function} between
 * @returns {Promise<{done: Promise, doc: Document}>}
 */
async function importZenAfter(zen, between) {
  const { done, doc } = await openImportPage({ roots: { zen: [zen.root] } });
  const importButton = await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-im-import:not(:disabled)"),
    "the page lists Zen"
  );
  await between();
  importButton.click();
  const doneButton = doc.querySelector(".sval-im-done");
  await TestUtils.waitForCondition(() => !doneButton.disabled, "it ends");
  return { done, doc };
}

/**
 * Counts the nodes named "Home" in the window's document, which holds what
 * earlier tasks imported too, so a task compares two counts.
 *
 * @param {object} engine
 * @returns {Promise<number>} how many nodes are named "Home".
 */
async function homes(engine) {
  return Object.values((await engine.tree()).nodes).filter(
    n => n.content?.name === "Home"
  ).length;
}

/**
 * @param {Document} doc
 * @returns {string[][]} each result line: a summary's sentence, or a
 *   failure's `source:kind`, then its buttons' commands.
 */
function resultLines(doc) {
  return [...doc.querySelectorAll(".sval-im-result-line")].map(line => [
    line.dataset.status == "success"
      ? line.querySelector(".sval-im-result-text").textContent
      : `${line.dataset.source}:${line.dataset.kind}`,
    ...[...line.querySelectorAll("button")].map(b => b.dataset.command),
  ]);
}

/**
 * Bookmarks whose file no longer decodes at Import fail their browser as
 * data not understood, with the reader's own cause, while its windows still
 * land (messages spec §7).
 */
add_task(async function a_reader_meeting_corrupt_data_says_couldnt_read() {
  await appDataInTemp();
  const { engine } = await withFreshPanel();
  await favoritesFixture();
  const zen = await zenFixture();
  const before = await homes(engine);
  const { done, doc } = await importZenAfter(zen, () =>
    IOUtils.writeUTF8(zen.sidebar, "not lz4")
  );
  Assert.equal(
    doc.querySelector(".sval-im-progress-row").dataset.state,
    "failed"
  );
  Assert.deepEqual(resultLines(doc), [
    [summaryOf(1)],
    ["zen:data", "importBookmarksFile", "sendReport"],
  ]);
  Assert.equal(await homes(engine), before + 1, "the windows landed");

  // Send Report… closes the page, and the feedback form opens in its place
  // with the failure as its context (feedback spec §2).
  doc.querySelector("[data-command=sendReport]").click();
  const report = await within(done, 20_000, "the import's report");
  Assert.deepEqual(report.failed, ["zen"]);
  const form = await feedbackShown();
  Assert.stringContains(
    formParts(form).context.textContent,
    SOURCE_NAMES.zen,
    "with the failure as its context"
  );
  formParts(form).cancel.click();
  Assert.ok(form.hidden, "Cancel closes it");
});

/**
 * Bookmarks whose file the system refuses at Import fail their browser as
 * files not opened; Try Again then brings them without making the windows'
 * workspace a second time (messages spec §7).
 */
add_task(async function a_reader_refused_its_file_says_couldnt_open() {
  const { engine } = await withFreshPanel();
  await favoritesFixture();
  const zen = await zenFixture();
  const allow = () => SvalTestDeny.allow(zen.sidebar);
  atTaskEnd(allow);
  const before = await homes(engine);
  const { done, doc } = await importZenAfter(zen, () =>
    SvalTestDeny.read(zen.sidebar)
  );
  Assert.deepEqual(resultLines(doc), [
    [summaryOf(1)],
    ["zen:open", "retrySource", "importBookmarksFile"],
  ]);

  await allow();
  const doneButton = doc.querySelector(".sval-im-done");
  doc.querySelector("[data-command=retrySource]").click();
  await TestUtils.waitForCondition(
    () =>
      doc.querySelector(".sval-im-progress-row").dataset.state === "done" &&
      !doneButton.disabled,
    "Try Again reads it"
  );
  Assert.equal(
    await homes(engine),
    before + 1,
    "the workspace is not made twice"
  );
  doneButton.click();
  const report = await within(done, 20_000, "the import's report");
  Assert.deepEqual(report.failed, []);
  Assert.equal(report.workspaces.length, 1);
});

/**
 * A browser the page could not read is not imported: importing another
 * brings nothing from it, and the page's row for it has said why.
 */
add_task(async function a_browser_unread_at_scan_is_left_out() {
  await withFreshPanel();
  await favoritesFixture();
  const home = await arcFixture();
  const zen = await zenFixture();
  await IOUtils.writeUTF8(zen.sidebar, "not lz4");

  const { done, doc } = await openImportPage({
    roots: { arc: { home }, zen: [zen.root] },
  });
  const importButton = await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-im-import:not(:disabled)"),
    "Arc can be imported"
  );
  importButton.click();
  const doneButton = doc.querySelector(".sval-im-done");
  await TestUtils.waitForCondition(() => !doneButton.disabled, "it ends");
  Assert.deepEqual(
    [...doc.querySelectorAll(".sval-im-progress-name")].map(n => n.textContent),
    ["Arc"],
    "Zen is not run"
  );
  Assert.deepEqual(resultLines(doc), [[summaryOf(1, 1)]]);
  doneButton.click();
  const report = await within(done, 20_000, "the import's report");
  Assert.deepEqual(report.failed, []);
});

/**
 * A browser whose history alone failed brought the rest: its line speaks of
 * the history with Try Again, the rest is counted, and Try Again imports
 * the history alone (messages spec §7).
 */
add_task(async function a_browser_whose_history_failed_says_so() {
  const { engine } = await withFreshPanel();
  await favoritesFixture();
  const zen = await zenFixture();
  const { findBrowsers, harvestBrowser } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
  );
  const [browser] = await findBrowsers({ zen: [zen.root] });
  const plan = [
    {
      browser,
      harvest: await harvestBrowser(browser),
      windows: [{ import: true, name: "Home", isolated: false }],
      bookmarks: "none",
      bookmarksName: "Zen Bookmarks",
      history: true,
      autoArchive: null,
    },
  ];
  // History that is not a database: Zen's history reader cannot open it.
  const places = PathUtils.join(PathUtils.parent(zen.sidebar), "places.sqlite");
  await IOUtils.writeUTF8(places, "not a database");

  const before = await homes(engine);
  const { done, doc } = await openImportPage({ plan });
  const doneButton = doc.querySelector(".sval-im-done");
  await TestUtils.waitForCondition(() => !doneButton.disabled, "it ends");
  Assert.deepEqual(resultLines(doc), [
    [summaryOf(1)],
    ["zen:history", "retrySource"],
  ]);

  await IOUtils.remove(places);
  doc.querySelector("[data-command=retrySource]").click();
  await TestUtils.waitForCondition(
    () =>
      doc.querySelector(".sval-im-progress-row").dataset.state === "done" &&
      !doneButton.disabled,
    "Try Again imports the history"
  );
  Assert.equal(
    await homes(engine),
    before + 1,
    "the workspace is not made twice"
  );
  Assert.deepEqual(resultLines(doc), [[summaryOf(1)]]);
  doneButton.click();
  const report = await within(done, 20_000, "the import's report");
  Assert.deepEqual(report.failed, []);
  Assert.equal(report.workspaces.length, 1);
});

/**
 * A page closed while its run is under way still answers what the run
 * brought.
 */
add_task(async function a_page_closed_mid_run_still_answers_what_landed() {
  await withFreshPanel();
  await favoritesFixture();
  const home = await arcFixture();
  const { done, doc } = await openImportPage({ roots: { arc: { home } } });
  const importButton = await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-im-import:not(:disabled)"),
    "the page is ready"
  );
  importButton.click();
  doc.defaultView.close();
  await TestUtils.waitForCondition(() => !gDialogBox.isOpen, "it closes");
  const report = await within(done, 20_000, "the import's report");
  Assert.equal(report.workspaces.length, 1);
  Assert.equal(report.favorites, 1);
  Assert.deepEqual(report.failed, []);
});

/**
 * An import first run chose opens its page already running, with no picker
 * (messages spec §7).
 */
add_task(async function a_chosen_plan_opens_running() {
  await withFreshPanel();
  await favoritesFixture();
  const home = await arcFixture();
  const { findBrowsers, harvestBrowser } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
  );
  const [browser] = await findBrowsers({ arc: { home } });
  const plan = [
    {
      browser,
      harvest: await harvestBrowser(browser),
      windows: [{ import: true, name: "Home", isolated: false }],
      bookmarks: "favorites",
      bookmarksName: "Arc Bookmarks",
      history: false,
      autoArchive: null,
    },
  ];
  const { done, doc } = await openImportPage({ plan });
  Assert.ok(BrowserTestUtils.isHidden(doc.querySelector(".sval-im-picker")));
  Assert.ok(BrowserTestUtils.isHidden(doc.querySelector(".sval-im-import")));
  // A small plan can finish before the page has first painted, so the row
  // that shows the import started on its own may already say it is done.
  Assert.ok(
    ["running", "done"].includes(
      doc.querySelector(".sval-im-progress-row")?.dataset.state
    ),
    "the import started without a press"
  );
  const doneButton = doc.querySelector(".sval-im-done");
  await TestUtils.waitForCondition(() => !doneButton.disabled, "it ends");
  doneButton.click();
  const report = await within(done, 20_000, "the import's report");
  Assert.equal(report.workspaces.length, 1);
});

/**
 * An Arc user's card comes across with their import, and the import page
 * shows it, with its reveal, once the import ends.
 */
add_task(async function arcs_card_shows_when_the_import_ends() {
  await withFreshPanel();
  await favoritesFixture();
  const startupCard = Services.prefs.getStringPref("browser.sval.card");
  registerCleanupFunction(() =>
    Services.prefs.setStringPref("browser.sval.card", startupCard)
  );
  const home = await arcFixture();
  const root = PathUtils.join(home, "Library", "Application Support", "Arc");
  await IOUtils.writeJSON(PathUtils.join(root, "StorableMembershipCard.json"), {
    version: 1,
    shapeName: "Shape3",
    paletteNumber: 4,
    backgroundBlobInfo: [2, 10, 5, 5, 12, 11, 2, 12, 3, 2, 11, 3, 6, 14, 3],
    title: "VAGUE ARCHIVIST",
  });
  await IOUtils.writeJSON(PathUtils.join(root, "StorableAuthState.json"), {
    session: {
      user: {
        createdAt: (Date.UTC(2024, 4, 17, 12) - Date.UTC(2001, 0, 1)) / 1000,
      },
    },
  });
  // A window tall enough for the card and its welcome.
  const { outerWidth, outerHeight } = window;
  window.resizeTo(outerWidth, Math.max(outerHeight, 1000));
  registerCleanupFunction(() => window.resizeTo(outerWidth, outerHeight));
  const { done, doc } = await openImportPage({ roots: { arc: { home } } });
  const importButton = doc.querySelector(".sval-im-import");
  await TestUtils.waitForCondition(
    () => !importButton.disabled,
    "the page lists Arc"
  );
  const holder = doc.querySelector(".sval-im-card");
  Assert.ok(BrowserTestUtils.isHidden(holder), "no card before the import");
  importButton.click();
  await TestUtils.waitForCondition(
    () => holder.querySelector(".sval-mcard svg"),
    "the card shows"
  );
  Assert.ok(BrowserTestUtils.isVisible(holder));
  // The dialog grows to hold the card: nothing scrolls once it has
  // played.
  const run = doc.querySelector(".sval-im-run");
  await within(
    Promise.all(
      holder
        .querySelector(".sval-mcard")
        .getAnimations({ subtree: true })
        .map(animation => animation.finished)
    ),
    10_000,
    "the reveal"
  );
  await TestUtils.waitForCondition(
    () => run.scrollHeight <= run.clientHeight,
    "the run holds the card without scrolling"
  );
  const doneButton = doc.querySelector(".sval-im-done");
  await TestUtils.waitForCondition(
    () => doc.activeElement === doneButton,
    "Done keeps the focus"
  );
  doneButton.click();
  await within(done, 20_000, "the import's report");
  Assert.equal(
    JSON.parse(Services.prefs.getStringPref("browser.sval.card")).title,
    "VAGUE ARCHIVIST",
    "the card is the user's"
  );
});

/**
 * Arc's Favorites are pins (pins-root spec §7): the import writes them into
 * the pins root, so they show in the panel's pins row and on the home page,
 * and nothing in Favorites.
 */
add_task(async function an_arc_favorite_imports_as_a_pin() {
  await withFreshPanel();
  const { store } = await favoritesFixture();
  const home = await arcFixture();

  const { done, doc } = await openImportPage({ roots: { arc: { home } } });
  const importButton = await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-im-import:not(:disabled)"),
    "the page is ready"
  );
  importButton.click();
  const doneButton = doc.querySelector(".sval-im-done");
  await TestUtils.waitForCondition(() => !doneButton.disabled, "it ends");
  doneButton.click();
  await within(done, 20_000, "the import's report");

  const [pin] = store.pinsWithUrl("https://example.com/fav");
  Assert.ok(pin, "it arrives as a pin");
  Assert.ok(store.isPinned(pin.guid), "in the pins root");
  Assert.ok(!store.isFavorite("https://example.com/fav"), "and no favorite");
});
