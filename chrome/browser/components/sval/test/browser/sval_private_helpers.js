/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the private-window test files share: marker strings, the searches
 * that prove none of them reached the disk, a private session driven
 * through everything a person does in one, and the setup that puts this
 * window's panel on the profile's own engine. Each file loads this with
 * `loadSubScript` into its own scope.
 */

/* exported SvalPrivateSession, SvalIdentity, SvalSharedFolder, SHARED_STEP_TIMEOUT_MS, SessionSaver, SvalKagi, SvalSettingsSync, SvalTabs, SVAL_FILES, marker, pageFor, filesUnder, sha256, snapshot, svalPaths, textsOf, findMarkers, flushEverything, openPrivate, privateTree, openMarked, drivePrivateSession, assertProfileTreeClean, privateSetup, SvalPrivateJars, ISOLATION_PAGE, jarOf, openIsolationPage, writeSiteData, readSiteData, cookiesIn, openPopupFrom, closePrivate, tabMenuItem, zoomStored, answerNameDialog, answerContainerDialogIn */

const { SvalPrivateSession } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPrivateSession.sys.mjs"
);
const { SessionSaver } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/SessionSaver.sys.mjs"
);
const { SvalKagi } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
);
const { SvalSettingsSync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
);
const { SvalHistorySync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
);
const { SvalFavoritesStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);
const { SvalArchive } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalArchive.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalSharedFolder, SHARED_STEP_TIMEOUT_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const { SvalTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const { SvalPrivateJars } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs"
);

/** A page that keeps site data, shows an icon and opens a sign-in popup. */
const ISOLATION_PAGE =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com"
  ) + "sval_private_isolation.html";

/**
 * @param {Window} win A private window.
 * @returns {number} the jar its session's tabs use.
 */
function jarOf(win) {
  return win.gBrowser.defaultUserContextId;
}

/**
 * Opens `url` in a new tab of `win`.
 *
 * @param {Window} win
 * @param {string} [url]
 * @returns {Promise<object>} the tab, loaded.
 */
function openIsolationPage(win, url = ISOLATION_PAGE) {
  return within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    15_000,
    "a page loading"
  );
}

/**
 * Writes `value` into the page's cookie and localStorage.
 *
 * @param {Element} browser
 * @param {string} value
 */
function writeSiteData(browser, value) {
  return SpecialPowers.spawn(browser, [value], v => {
    content.document.cookie = `sval=${v}; Secure; SameSite=Lax; max-age=600`;
    content.localStorage.setItem("sval", v);
  });
}

/**
 * @param {Element} browser
 * @returns {Promise<{cookie: string|null, storage: string|null}>} what the
 *   page reads back of {@link writeSiteData}.
 */
function readSiteData(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    cookie: /(?:^|; )sval=([^;]*)/.exec(content.document.cookie)?.[1] ?? null,
    storage: content.localStorage.getItem("sval"),
  }));
}

/**
 * @param {number} jar
 * @returns {object[]} the private cookies the test site has in `jar`.
 */
function cookiesIn(jar) {
  return Services.cookies.getCookiesFromHost("example.com", {
    privateBrowsingId: 1,
    userContextId: jar,
  });
}

/**
 * Presses the page's sign-in button, which opens a popup window of it.
 *
 * @param {Element} browser
 * @returns {Promise<Window>} the popup, loaded.
 */
async function openPopupFrom(browser) {
  const opened = BrowserTestUtils.waitForNewWindow({ url: ISOLATION_PAGE });
  await BrowserTestUtils.synthesizeMouseAtCenter("#popup", {}, browser);
  return within(opened, 15_000, "the popup opening");
}

/**
 * Closes a private window, if it is open, and waits for its session's data
 * to be cleared.
 *
 * @param {Window} win
 */
async function closePrivate(win) {
  if (!win.closed) {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "a private window closing"
    );
  }
  await within(
    SvalPrivateJars._clearedForTests(),
    10_000,
    "the closed window's session clearing"
  );
}

/**
 * Opens the tab context menu for `tab` and reads one of its items.
 *
 * @param {Window} win
 * @param {object} tab
 * @param {string} id
 * @returns {Promise<{hidden: boolean}>}
 */
async function tabMenuItem(win, tab, id) {
  const menu = win.document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  const trigger = new win.Event("");
  tab.dispatchEvent(trigger);
  menu.openPopup(tab, "end_after", 0, 0, true, false, trigger);
  await within(shown, 10_000, "the tab menu opening");
  const read = { hidden: win.document.getElementById(id).hidden };
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the tab menu closing");
  return read;
}

/**
 * @param {string} url
 * @returns {Promise<number|undefined>} the site zoom the profile's content
 *   prefs hold for `url`, the ones written to disk.
 */
function zoomStored(url) {
  return new Promise(resolve => {
    let value;
    Cc["@mozilla.org/content-pref/service;1"]
      .getService(Ci.nsIContentPrefService2)
      .getByDomainAndName(url, "browser.content.full-zoom", null, {
        handleResult(pref) {
          value = pref.value;
        },
        handleCompletion() {
          resolve(value);
        },
      });
  });
}

/** Sval's own files and directories in a profile. */
const SVAL_FILES = [
  "sval",
  "sval-local-settings.json",
  "sval-identity.json",
  "sval-local-key",
  "sval-secrets.json",
  "agents.json",
  "xulstore.json",
];

/** @returns {string} a token that appears nowhere unless this test put it there. */
function marker() {
  return `svalmark${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * @param {string} mark
 * @returns {string} a page whose URL and title both carry `mark`.
 */
function pageFor(mark) {
  return `data:text/html,<title>${mark}</title><p>${mark}</p>`;
}

/**
 * Every regular file under `dir`, recursively. Links are not followed.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesUnder(dir) {
  const out = [];
  if (!(await IOUtils.exists(dir))) {
    return out;
  }
  const walk = async at => {
    let children;
    try {
      children = await IOUtils.getChildren(at);
    } catch {
      return;
    }
    for (const child of children) {
      let info;
      try {
        info = await IOUtils.stat(child);
      } catch {
        continue;
      }
      if (info.type === "directory") {
        await walk(child);
      } else if (info.type === "regular") {
        out.push(child);
      }
    }
  };
  const info = await IOUtils.stat(dir);
  if (info.type === "directory") {
    await walk(dir);
  } else {
    out.push(dir);
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} the SHA-256 of `bytes`, as hex.
 */
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Path to hash for every file under each of `roots`.
 *
 * @param {string[]} roots
 * @returns {Promise<Map<string, string>>}
 */
async function snapshot(roots) {
  const out = new Map();
  for (const root of roots) {
    for (const file of await filesUnder(root)) {
      try {
        out.set(file, await sha256(await IOUtils.read(file)));
      } catch {
        // A file Firefox removed between the listing and the read.
      }
    }
  }
  return out;
}

/** Sval's own paths in this profile. */
function svalPaths() {
  return SVAL_FILES.map(name => PathUtils.join(PathUtils.profileDir, name));
}

/**
 * The text of `file` as it could carry a marker: decompressed when it is one
 * of SessionStore's mozLz4 files, otherwise its bytes one character each,
 * which keeps an ASCII marker intact wherever it sits in a binary file.
 * UTF-16 is searched too, for SQLite and the like.
 *
 * The `latin1` label is windows-1252 (Encoding Standard), which decodes every
 * byte to one UTF-16 unit and every ASCII byte to itself. `TextDecoder` does
 * that natively; the profile holds tens of megabytes of caches and databases.
 *
 * @param {string} file
 * @returns {Promise<string[]>}
 */
async function textsOf(file) {
  const texts = [];
  if (/lz4$/.test(file)) {
    try {
      texts.push(await IOUtils.readUTF8(file, { decompress: true }));
    } catch {}
  }
  let bytes;
  try {
    bytes = await IOUtils.read(file);
  } catch {
    return texts;
  }
  const latin = new TextDecoder("latin1").decode(bytes);
  texts.push(latin, latin.replaceAll("\0", ""));
  return texts;
}

/**
 * Every file under `roots` holding any of `marks`.
 *
 * @param {string[]} roots
 * @param {string[]} marks
 * @returns {Promise<string[]>} `path: marker` for each find.
 */
async function findMarkers(roots, marks) {
  const found = [];
  for (const root of roots) {
    for (const file of await filesUnder(root)) {
      for (const text of await textsOf(file)) {
        for (const mark of marks) {
          if (text.includes(mark)) {
            found.push(`${file}: ${mark}`);
          }
        }
      }
    }
  }
  return [...new Set(found)];
}

/**
 * Makes everything that could be waiting to reach the disk reach it: the
 * window's tab observer's held flushes, a shared-folder helper still at work,
 * the identity file's queued writes, a session save, the profile engine's
 * pending publish, the local settings, and XULStore's delayed write.
 *
 * The observer holds its settings write on a timer, and an earlier file's
 * work can still be queued on the identity file or the helper, so a snapshot
 * taken before these settle can see the normal profile's own write land
 * inside a private session's.
 *
 * A pass can hand history sync a write of its own: when a week's pass
 * publishes visits, `SvalHistorySync` announces that week in its index, and
 * the index is the next pass's to publish. So the publish repeats, each time
 * history sync's queue settles, until a pass finds nothing unpublished;
 * otherwise an earlier file's visits put an index write inside the snapshot.
 *
 * XULStore writes `xulstore.json` on a timer 30 seconds after a change
 * (`WRITE_DELAY_MS` in `XULStore.sys.mjs`), so a window an earlier test file
 * opened can land its write inside a later snapshot. The timer's callback is
 * the store's `observe`, which starts the write at once. IOUtils runs its
 * operations in order on one queue, so every IOUtils read after this sees the
 * file written.
 */
async function flushEverything() {
  await within(
    SvalPanel.observer?.settled(),
    10_000,
    "the window's observer's held work"
  );
  await within(
    SvalSharedFolder._whenIdle(),
    SHARED_STEP_TIMEOUT_MS,
    "a shared-folder helper's exit"
  );
  await within(
    SvalIdentity._identityWrites.idle(),
    10_000,
    "the identity file's queued writes"
  );
  await SessionSaver.run();
  // A pass hands its report to each module that feeds the profile's engine,
  // and each answers on a queue of its own: history announces a week in its
  // index, settings seeds, Favorites and the Archive write their documents.
  // Any of them can hand the engine a change the next publish writes, so
  // each settles before every publish. A pass whose extra document fails
  // leaves its changes unpublished, and every publish after it runs again;
  // that fails here rather than spinning.
  // A title an earlier test's page set is written when its hold ends, which
  // would be in the middle of what the caller compares.
  SvalHistorySync.instance?._writeHeldTitlesForTests();
  for (let passes = 0; ; passes++) {
    await within(
      Promise.all([
        SvalHistorySync.instance?.whenIdle(),
        SvalSettingsSync.shared?.sync?.whenIdle(),
        SvalFavoritesStore.instance?.whenIdle(),
        SvalArchive.instance?.whenIdle(),
      ]),
      10_000,
      "the queued work of what feeds the profile's engine"
    );
    if (!(await SvalPanel.engine?.publishPending?.())) {
      break;
    }
    if (passes >= 5) {
      throw new Error("the profile engine's publish did not settle");
    }
  }
  await SvalPanel.settings?.flush?.();
  Services.xulStore.QueryInterface(Ci.nsIObserver).observe(null, "", "");
}

/**
 * A private window with its panel started.
 *
 * @returns {Promise<DOMWindow>}
 */
async function openPrivate() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window's opening"
  );
  await within(win.SvalPanel.started, 10_000, "the private panel's startup");
  return win;
}

/**
 * @param {DOMWindow} win A private window.
 * @returns {Promise<object>} the nodes its panel draws from.
 */
async function privateTree(win) {
  return (await win.SvalPanel.engine.tree()).nodes;
}

/**
 * Opens a tab on a marker page in `win` and waits for its node.
 *
 * @param {DOMWindow} win
 * @param {string} mark
 *
 * @returns {Promise<{tab: object, id: string}>}
 */
async function openMarked(win, mark) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, pageFor(mark)),
    10_000,
    "a marked page's load"
  );
  let id = null;
  await TestUtils.waitForCondition(async () => {
    id = win.SvalPanel.observer.nodeIdFor(tab);
    return id && (await privateTree(win))[id];
  }, "the tab has a node in the private tree");
  return { tab, id };
}

/**
 * The document of `win`'s dialog once it has drawn `selector`. A dialog opens
 * in the window whose panel asked (`gDialogBox` is per window), so a private
 * window's is found in that window. A dialog that is closing is still
 * `gDialogBox.dialog` until it goes, so it is passed over for the one after
 * it.
 *
 * @param {Window} win
 * @param {string} selector What the dialog draws once its script has run.
 * @returns {Promise<Document>}
 */
async function dialogIn(win, selector) {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = win.gDialogBox.dialog;
    return dialog && !dialog._isClosing;
  }, "a dialog opens");
  await dialogShown(dialog, "the dialog's load");
  const doc = dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector(selector),
    `the dialog has drawn ${selector}`
  );
  return doc;
}

/**
 * Waits until the dialog whose document is `doc` has left `win`.
 *
 * @param {Window} win
 * @param {Document} doc
 */
async function dialogGoneFrom(win, doc) {
  await TestUtils.waitForCondition(
    () => win.gDialogBox.dialog?._frame?.contentDocument !== doc,
    "the dialog closes"
  );
}

/**
 * Types `value` into the field of the Sval dialog `win` shows
 * (`openSvalDialog`) and presses its primary button, as a person does.
 *
 * @param {Window} win
 * @param {string} value
 */
async function answerNameDialog(win, value) {
  const doc = await dialogIn(win, "sval-dialog sval-button");
  const input = doc.querySelector(".sval-dialog-input");
  input.value = value;
  input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  doc.querySelector('sval-dialog [data-button="ok"]').click();
  await dialogGoneFrom(win, doc);
}

/**
 * Answers the new group or workspace dialog `win` shows (`SvalNewWorkspace`)
 * as a person does: types `name`, picks the swatch for `color`, chooses
 * `emoji` in the picker its Emoji button opens, and presses Create. The
 * dialog closes for the picker and opens again with what was entered.
 *
 * @param {Window} win
 * @param {object} answer
 * @param {string} answer.name
 * @param {string} [answer.color] A palette token.
 * @param {string} [answer.emoji]
 */
async function answerContainerDialogIn(win, { name, color, emoji }) {
  let doc = await dialogIn(win, ".sval-nw-swatch");
  const field = doc.querySelector(".sval-nw-name");
  field.value = name;
  field.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  if (color) {
    doc.querySelector(`.sval-nw-swatch[data-token="${color}"]`).click();
  }
  if (emoji) {
    doc.querySelector(".sval-nw-emoji").click();
    await dialogGoneFrom(win, doc);
    const picker = await dialogIn(win, ".sval-emoji-choice");
    const choice = [...picker.querySelectorAll(".sval-emoji-choice")].find(
      b => b.textContent === emoji
    );
    // The grid has one Tab stop, which the accessibility checker looks for
    // only in the clicked cell's own row group.
    AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
    choice.click();
    AccessibilityUtils.resetEnv();
    await dialogGoneFrom(win, picker);
    doc = await dialogIn(win, ".sval-nw-swatch");
  }
  doc.querySelector(".sval-nw-create").click();
  await dialogGoneFrom(win, doc);
}

/**
 * Moves the row `id` into `group` through its row menu's "Move to group", as
 * a person does, and waits for the private tree to hold it there.
 *
 * @param {Window} win
 * @param {string} id
 * @param {string} group
 */
async function moveIntoGroupIn(win, id, group) {
  const menu = win.SvalPanel._els.contextMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(
    win.SvalPanel._rowElementFor(id),
    { type: "contextmenu", button: 2 },
    win
  );
  await within(shown, 10_000, "the row menu opening");
  await pickMenuItem({ popup: menu }, `moveParent:${group}`);
  await TestUtils.waitForCondition(
    async () => (await privateTree(win))[id]?.placement.parent === group,
    "the row moves into the group"
  );
}

/**
 * Drives a private window through everything a person does in one, with a
 * marker at every place a string can go. Returns the markers.
 *
 * @param {DOMWindow} win A private window.
 * @param {Function} [afterStep] Awaited after each step with the markers so
 *   far and the private node ids so far.
 * @returns {Promise<string[]>}
 */
async function drivePrivateSession(win, afterStep = async () => {}) {
  const marks = [];
  const mark = () => {
    const m = marker();
    marks.push(m);
    return m;
  };
  const step = async () =>
    afterStep(marks, Object.keys(await privateTree(win)));
  const panel = win.SvalPanel;
  const a = await openMarked(win, mark());
  const b = await openMarked(win, mark());
  const c = await openMarked(win, mark());
  await step();

  // A group with a marker name, a colour and an emoji, holding two tabs.
  const groupName = mark();
  await panel.selection.select(a.id);
  const adding = panel.run("addGroup", null);
  await answerContainerDialogIn(win, {
    name: groupName,
    color: "blue",
    emoji: "\u{1F984}",
  });
  await within(adding, 10_000, "the group's making");
  let nodes = await privateTree(win);
  const group = Object.keys(nodes).find(
    id => nodes[id].content?.name === groupName
  );
  Assert.ok(group, "the group was made in the private tree");
  Assert.equal(nodes[group].appearance?.color, "blue", "in the colour chosen");
  Assert.equal(
    nodes[group].appearance?.emoji,
    "\u{1F984}",
    "with the emoji chosen"
  );
  await moveIntoGroupIn(win, b.id, group);
  await moveIntoGroupIn(win, c.id, group);
  await step();

  // Renamed, collapsed, expanded, selected, reordered.
  const renamed = mark();
  const renaming = panel.run("rename", { id: group });
  await answerNameDialog(win, renamed);
  await within(renaming, 10_000, "the rename");
  await panel._setCollapsed(group, true);
  await panel._setCollapsed(group, false);
  await panel.selection.select(c.id);
  await selectTab(b.tab);
  win.gBrowser.moveTabTo(a.tab, { tabIndex: 0 });
  await step();

  // A navigation, so content changes are followed too.
  const navigated = mark();
  BrowserTestUtils.startLoadingURIString(
    a.tab.linkedBrowser,
    pageFor(navigated)
  );
  await within(
    BrowserTestUtils.browserLoaded(a.tab.linkedBrowser),
    10_000,
    "the navigation's load"
  );
  await TestUtils.waitForCondition(
    async () =>
      (await privateTree(win))[a.id]?.content?.url?.includes(navigated),
    "the navigation reached the private tree"
  );
  await step();

  // Closed, and one brought back.
  await panel._close(c.id);
  BrowserTestUtils.removeTab(b.tab);
  await TestUtils.waitForCondition(
    async () => !(await privateTree(win))[b.id],
    "the closed tab's node is gone"
  );
  SessionStore.undoCloseTab(win, 0);
  await TestUtils.waitForCondition(
    () => win.gBrowser.tabs.length >= 3,
    "the closed tab came back"
  );
  await step();

  nodes = await privateTree(win);
  Assert.ok(
    Object.values(nodes).some(n => n.content?.name === renamed),
    "the rename landed in the private tree"
  );
  return marks;
}

/**
 * The profile engine's tree holds none of `marks` and none of `ids`.
 *
 * @param {string[]} marks
 * @param {string[]} [ids]
 */
async function assertProfileTreeClean(marks, ids = []) {
  const json = await SvalPanel.engine.treeJson();
  for (const m of marks) {
    Assert.ok(!json.includes(m), `the profile's tree holds no ${m}`);
  }
  for (const id of ids) {
    Assert.ok(!json.includes(id), `the profile's tree holds no private ${id}`);
  }
}

async function privateSetup() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  // These tests compare the private session against the profile's own
  // engine, settings and files, which Known Good state puts this window's
  // panel back on.
  Assert.ok(
    SvalPanel.engine && !SvalPanel.engine.isPrivate,
    "the profile's panel runs"
  );
  registerCleanupFunction(() =>
    within(SvalPrivateSession.end(), 10_000, "the private session's end")
  );
}
