/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the files that use Sval with agent access on share. The agent gate
 * holds the first load of any tab that could be an agent's until its window
 * has filed it (`SvalAgentGate` `holdForFiling`), so these files assert what
 * the user sees: each page loaded, visible to itself and painted. Each file
 * loads this with `loadSubScript` into its own scope.
 */

/* exported SvalAgents, SvalQuickPeek, SvalPeek, SvalPanelModel, SvalTree, RED,
            agentAccessOn, titledRed, middlePixel, shows, linkFromAnotherApp,
            secondWindow, failFirstLoad, errorPageShown, movedInShows, dialogIn, typeIn,
            newWorkspace, switchVia, tearOffVia, rowIn, clickRow, rowNameIn,
            switcherNameIn, contextMenuIn, menuCommand, nodeOfTab,
            selectedShows, clickRowShows, workspaceWith, rowIdsIn,
            shownTabIdsIn, openSwitcherIn, closeSwitcherIn, switcherIdsIn,
            newWindowCommand, newTabCommand */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { SvalQuickPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
);
const { SvalPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

/** A page painted red edge to edge, which a blank or grey page is not. */
const RED = ROOT + "sval_agent_red.html";

/** The colour a snapshot fills where the page paints nothing. */
const BACKDROP = "rgb(128, 128, 128)";

/**
 * Turns agent access on, as Settings › Agents does, until `onEnd` runs.
 *
 * @param {Function} [onEnd] Registers the teardown: the task's end by
 *   default, or `registerCleanupFunction` for a whole file.
 */
async function agentAccessOn(onEnd = atTaskEnd) {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.agents.enabled", true]],
  });
  onEnd(() => SpecialPowers.popPrefEnv());
  await TestUtils.waitForCondition(() => SvalAgents.store, "access is open");
}

/**
 * A served page titled `title` and painted red, so the panel names its row
 * by a title of its own. `title` is letters, digits and spaces, which the
 * query keeps as written.
 *
 * @param {string} title
 * @returns {string}
 */
function titledRed(title) {
  const markup = `<!doctype html><title>${title}</title><body style="margin:0;background:red"></body>`;
  return `${ROOT}sval_switcher_page.sjs?${encodeURIComponent(markup)}`;
}

/**
 * @param {object} browser
 * @returns {Promise<number[]>} the RGBA of the middle of what `browser`'s
 *   page paints, over BACKDROP.
 */
async function middlePixel(browser) {
  const bitmap = await browser.browsingContext.currentWindowGlobal.drawSnapshot(
    null,
    1,
    BACKDROP
  );
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return Array.from(
    ctx.getImageData(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      1,
      1
    ).data
  );
}

/**
 * Asserts what the user sees of `browser`: its page is `url`, loaded, live
 * to its page, rendered into the compositor, and painted red.
 *
 * @param {object} browser
 * @param {string} url
 * @param {string} what
 */
async function shows(browser, url, what) {
  await pageReady(browser, url);
  await explained(
    TestUtils.waitForCondition(
      () => browser.docShellIsActive,
      `${what}: its page is live`
    ),
    () => loadState(browser)
  );
  await explained(
    TestUtils.waitForCondition(
      () => browser.renderLayers,
      `${what}: its page renders`
    ),
    () => loadState(browser)
  );
  await explained(
    TestUtils.waitForCondition(
      () => browser.hasLayers,
      `${what}: the compositor has its layers`
    ),
    () => loadState(browser)
  );
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.visibilityState
    ),
    "visible",
    `${what}: its page is visible to itself`
  );
  Assert.deepEqual(
    await middlePixel(browser),
    [255, 0, 0, 255],
    `${what}: its page has painted`
  );
}

/**
 * Asserts that `win` shows `url` in its selected tab, as `shows` does, and
 * that the address bar shows it.
 *
 * @param {Window} win
 * @param {string} url
 * @param {string} what
 */
async function selectedShows(win, url, what) {
  await shows(win.gBrowser.selectedBrowser, url, what);
  // The address bar shows the address decoded (`losslessDecodeURI`).
  Assert.equal(
    Services.io.newURI(win.gURLBar.untrimmedValue).spec,
    url,
    `${what}: the address bar shows its address`
  );
}

/**
 * Selects the tab of `id` by clicking its row in `win`'s panel, and asserts
 * its page `url` loads and paints.
 *
 * @param {Window} win
 * @param {string} id
 * @param {string} url
 * @param {string} what
 */
async function clickRowShows(win, id, url, what) {
  clickRow(win, id);
  await TestUtils.waitForCondition(
    () =>
      win.SvalPanel.observer.tabFor(id) &&
      win.gBrowser.selectedTab === win.SvalPanel.observer.tabFor(id),
    `${what}: its row selects its tab`
  );
  await switchDone(win);
  await selectedShows(win, url, what);
}

/**
 * A link from another app, as every platform hands one to a running Sval
 * (`runCommandLine`), and the peek it opens, whatever its page does.
 *
 * @param {string} url
 * @returns {Promise<Window>}
 */
async function linkFromAnotherApp(url) {
  const opened = BrowserTestUtils.waitForNewWindow();
  runCommandLine(["-url", url]);
  const win = await within(opened, 20_000, "the peek");
  Assert.ok(SvalPeek.isPeek(win), "a peek");
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the peek closing"
      );
    }
  });
  const context = win.browsingContext;
  context.forceAppWindowActive = true;
  atTaskEnd(() => {
    if (!context.isDiscarded) {
      context.forceAppWindowActive = false;
    }
  });
  return win;
}

/**
 * @param {?Function} [open] Opens the window another way, and resolves
 *   with it.
 * @returns {Promise<Window>} a second Sval window, opened as ⌘N opens one,
 *   its panel started and its pages visible to themselves. A workspace the
 *   window made for itself goes when the task ends, after the window.
 */
async function secondWindow(open = null) {
  const before = new Set(Object.keys(SvalPanel.nodes));
  let shown = null;
  atTaskEnd(async () => {
    // A window's own workspace that it closed untouched went with it.
    if (
      shown &&
      !before.has(shown) &&
      (await SvalPanel.engine.tree()).nodes?.[shown]
    ) {
      await removeWorkspace(shown);
      await SvalPanel.refresh();
    }
  });
  const win = open
    ? await within(open(), 10_000, "a second window")
    : await within(
        BrowserTestUtils.openNewBrowserWindow(),
        10_000,
        "a second window"
      );
  atTaskEnd(async () => {
    if (!win.closed) {
      shown = SvalWindowWorkspace.of(win).id;
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the second window closing"
      );
    }
  });
  await within(win.SvalPanel.started, 10_000, "its panel's startup");
  shown = SvalWindowWorkspace.of(win).id;
  expectWorkspaceTabs(win);
  const context = win.browsingContext;
  context.forceAppWindowActive = true;
  atTaskEnd(() => {
    if (!context.isDiscarded) {
      context.forceAppWindowActive = false;
    }
  });
  return win;
}

/**
 * Fails the first load of `url` with `status`, at the point where the agent
 * gate refuses one (`http-on-modify-request`, in the parent).
 *
 * @param {string} url
 * @param {number} status
 * @returns {Promise<void>} Resolves once the load has been failed.
 */
function failFirstLoad(url, status) {
  const { promise, resolve } = Promise.withResolvers();
  const observer = {
    observe(subject) {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (channel.URI.spec === url) {
        Services.obs.removeObserver(observer, "http-on-modify-request");
        channel.cancel(status);
        resolve();
      }
    },
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  atTaskEnd(() => {
    try {
      Services.obs.removeObserver(observer, "http-on-modify-request");
    } catch {}
  });
  return promise;
}

/**
 * Asserts that `browser` shows the error page of a load of `url` that
 * failed, at that address, once the page has drawn with its fonts. A reload
 * before then cancels the page's font load, which Gecko logs as an error
 * (`gfxUserFontEntry::FontDataDownloadComplete`). An error page's document
 * stays `interactive`: it never fires a load of its own.
 *
 * @param {object} browser
 * @param {string} url
 * @param {string} what
 * @param {string} [page] The error page's address, without its query.
 */
async function errorPageShown(browser, url, what, page = "about:neterror") {
  await committed(
    browser,
    b => b.documentURI?.spec.startsWith(`${page}?`),
    `${what}: it shows why its page did not load`
  );
  await within(
    SpecialPowers.spawn(browser, [page], errorPage =>
      ContentTaskUtils.waitForCondition(
        () =>
          content.document.documentURI.startsWith(`${errorPage}?`) &&
          content.document.readyState !== "loading" &&
          // A layout flush starts the loads of the fonts the page draws in.
          content.document.body.offsetHeight >= 0 &&
          content.document.fonts.status === "loaded",
        "the error page drawn with its fonts"
      )
    ),
    10_000,
    `${what}: the error page drawing`
  );
  Assert.equal(browser.currentURI.spec, url, `${what}: at the page's address`);
}

/**
 * Moves the peek's page into the main window's workspace, as its open
 * button does, and asserts the page loads there.
 *
 * @param {Window} win A peek.
 * @param {string} url
 * @param {object} [options]
 * @param {Function} [options.whenOpened] Called once the page's tab opens
 *   in the main window, after the move has decided how to bring it there.
 * @returns {Promise<object>} the tab it moved to.
 */
async function movedInShows(win, url, { whenOpened } = {}) {
  const opened = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabOpen"
  );
  const closed = BrowserTestUtils.domWindowClosed(win);
  win.document.getElementById("sval-peek-open-main").click();
  const tab = expectOpened(
    (await within(opened, 10_000, "the moved page")).target
  );
  whenOpened?.();
  atTaskEnd(async () => {
    BrowserTestUtils.removeTab(tab);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  });
  await within(closed, 10_000, "the peek closing");
  await selectTab(tab);
  await shows(tab.linkedBrowser, url, "the page moved into the workspace");
  return tab;
}

/**
 * Waits past a dialog closing in `win`'s dialog box for the next one, and
 * for its page to draw `selector`. A dialog that has just been answered
 * stays `gDialogBox.dialog`, `_isClosing`, until its frame unloads.
 *
 * @param {Window} win
 * @param {string} selector
 * @returns {Promise<Document>} the dialog's document.
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
 * Types `text` into `field`, as the page's own `input` listeners read it.
 *
 * @param {Element} field
 * @param {string} text
 */
function typeIn(field, text) {
  field.value = text;
  const win = field.documentGlobal;
  field.dispatchEvent(new win.Event("input", { bubbles: true }));
}

/**
 * Makes a workspace named `name` through the switcher's "New workspace…",
 * answering its dialog, and asserts `win` shows it and names it. The
 * workspace goes when the task ends, with `win` back on the workspace it
 * showed before.
 *
 * @param {string} name
 * @param {Window} [win]
 * @returns {Promise<string>} its id.
 */
async function newWorkspace(name, win = window) {
  const panel = win.SvalPanel;
  const left = SvalWindowWorkspace.of(win).id;
  let id = null;
  atTaskEnd(async () => {
    if (!id) {
      return;
    }
    if (!win.closed && SvalWindowWorkspace.of(win).id === id) {
      await win.SvalPanel.switchTo(left);
      await switchDone(win);
    }
    await removeWorkspace(id);
    await SvalPanel.refresh();
    await within(
      SvalPanel.observer?.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  });
  const made = panel.run("addWorkspace", null);
  const doc = await dialogIn(win, ".sval-nw-name");
  typeIn(doc.querySelector(".sval-nw-name"), name);
  doc.querySelector(".sval-nw-create").click();
  await within(made, 10_000, "the new workspace");
  await switchDone(win);
  id = SvalWindowWorkspace.of(win).id;
  Assert.notEqual(id, left, `${name}: the window moved to it`);
  Assert.equal(switcherNameIn(win), name, `${name}: the switcher names it`);
  return id;
}

/**
 * @param {Window} win
 * @returns {string} the workspace name `win`'s switcher shows.
 */
function switcherNameIn(win) {
  return win.SvalPanel._els.switcher.querySelector(".sval-switcher-name")
    .textContent;
}

/**
 * Opens `win`'s switcher, as a click on it does, and chooses the entry
 * `selector` matches.
 *
 * @param {Window} win
 * @param {string} selector
 */
async function fromSwitcher(win, selector) {
  const menu = await openSwitcherIn(win);
  await chooseMenuItem(menu.querySelector(selector), menu, selector);
}

/**
 * Opens `win`'s switcher, as a click on it does.
 *
 * @param {Window} win
 * @returns {Promise<Element>} the open `menupopup`.
 */
async function openSwitcherIn(win) {
  // A popup opens only in the focused window on Windows.
  await within(SimpleTest.promiseFocus(win), 10_000, "the window's focus");
  const menu = win.SvalPanel._els.switcherMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  win.SvalPanel._els.switcher.click();
  await within(shown, 10_000, "the switcher opening");
  return menu;
}

/**
 * Closes the open switcher `menu` without choosing anything.
 *
 * @param {Element} menu
 */
async function closeSwitcherIn(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the switcher closing");
}

/**
 * What `win`'s switcher lists, read from the open menu as a person reads it.
 *
 * @param {Window} win
 * @returns {Promise<{listed: string[], free: string[]}>} the workspaces it
 *   lists, in order, and those it offers a window of their own, which are the
 *   ones no window shows (spec §10.7).
 */
async function switcherIdsIn(win) {
  const menu = await openSwitcherIn(win);
  const listed = Array.from(
    menu.querySelectorAll("[data-workspace-id]"),
    el => el.dataset.workspaceId
  );
  const free = Array.from(
    menu.querySelectorAll("[data-open-workspace-id]"),
    el => el.dataset.openWorkspaceId
  );
  await closeSwitcherIn(menu);
  return { listed, free };
}

/**
 * Goes to workspace `id` in `win` through its switcher.
 *
 * @param {Window} win
 * @param {string} id
 */
async function switchVia(win, id) {
  await fromSwitcher(win, `[data-workspace-id="${CSS.escape(id)}"]`);
  await switchDone(win);
  Assert.equal(SvalWindowWorkspace.of(win).id, id, "the window switched");
}

/**
 * Opens workspace `id` in a new window through `win`'s switcher, "Open in
 * new window", and waits for the new window's panel.
 *
 * @param {Window} win
 * @param {string} id
 * @returns {Promise<Window>}
 */
async function tearOffVia(win, id) {
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  await fromSwitcher(win, `[data-open-workspace-id="${CSS.escape(id)}"]`);
  const opened = await within(opening, 20_000, "the new window's opening");
  atTaskEnd(async () => {
    if (!opened.closed) {
      await within(
        BrowserTestUtils.closeWindow(opened),
        10_000,
        "the new window closing"
      );
    }
  });
  await within(
    opened.SvalPanel.started,
    20_000,
    "the new window's panel starting"
  );
  expectWorkspaceTabs(opened);
  const context = opened.browsingContext;
  context.forceAppWindowActive = true;
  atTaskEnd(() => {
    if (!context.isDiscarded) {
      context.forceAppWindowActive = false;
    }
  });
  Assert.equal(SvalWindowWorkspace.of(opened).id, id, "it shows the one");
  return opened;
}

/**
 * @param {Window} win
 * @param {string} id A node id.
 * @returns {Element|null} the row `win`'s panel draws for it.
 */
function rowIn(win, id) {
  return win.SvalPanel._els.tree.querySelector(
    `.sval-row[data-node-id="${CSS.escape(id)}"]:not(.sval-row-leaving)`
  );
}

/**
 * Clicks the row of `id` in `win`'s panel, as a pointer user does.
 *
 * @param {Window} win
 * @param {string} id
 */
function clickRow(win, id) {
  // The rows are a tree with a roving tabindex: Tab reaches the focused row
  // and the arrow keys the rest.
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  rowIn(win, id).click();
  AccessibilityUtils.resetEnv();
}

/**
 * @param {Window} win
 * @param {string} id
 * @returns {string|undefined} the name the row for `id` shows.
 */
function rowNameIn(win, id) {
  return rowIn(win, id)?.querySelector(".sval-row-name").textContent;
}

/**
 * @param {object} tab
 * @returns {Promise<string>} the node its window filed it under, once filed.
 */
async function nodeOfTab(tab) {
  const observer = tab.documentGlobal.SvalPanel.observer;
  let id;
  await TestUtils.waitForCondition(async () => {
    await within(observer.settled(), 10_000, "observer settling");
    id = observer.nodeIdFor(tab);
    return id;
  }, "the tab is filed");
  return id;
}

/**
 * Opens the row menu on `id`'s row in `win`, as a right-click does.
 *
 * @param {Window} win
 * @param {string} id
 * @returns {Promise<Element>} the open menu.
 */
function contextMenuIn(win, id) {
  return rightClickOpens(rowIn(win, id), win.SvalPanel._els.contextMenu);
}

/**
 * Chooses the item `selector` matches in the open row menu `menu`.
 *
 * @param {Element} menu
 * @param {string} selector
 */
function menuCommand(menu, selector) {
  return chooseMenuItem(menu.querySelector(selector), menu, selector);
}

/**
 * @param {Window} win
 * @returns {string[]} the node ids of the rows `win`'s panel draws, in order.
 */
function rowIdsIn(win) {
  return Array.from(
    win.SvalPanel._els.tree.querySelectorAll(
      ".sval-row[data-node-id]:not(.sval-row-leaving)"
    ),
    row => row.dataset.nodeId
  );
}

/**
 * @param {Window} win
 * @returns {string[]} the nodes of the tabs `win` has on show: those it
 *   holds, less the tabs a switch kept loaded and hid.
 */
function shownTabIdsIn(win) {
  return win.gBrowser.visibleTabs.map(taggedId).filter(Boolean);
}

/**
 * Adds a workspace named `name` to the profile's document, holding a tab for
 * each of `pages`, as a workspace made on another day does. It goes when the
 * task ends, with this window back on the workspace it shows now.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {Array<{url: string, title: string}>} [options.pages] Its tabs, in
 *   order. A tab named for its page's own title leaves the observer nothing
 *   to write when the page loads.
 * @param {boolean} [options.isolated] Whether it has a jar of its own.
 * @returns {Promise<{id: string, tabs: string[]}>} its id and its tabs'.
 */
async function workspaceWith(name, { pages = [], isolated = false } = {}) {
  const { engine } = SvalPanel;
  const home = SvalWindowWorkspace.of(window).id;
  const id = await engine.mutate({
    kind: "addWorkspace",
    name,
    isolated,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    if (SvalWindowWorkspace.of(window).id === id) {
      await SvalPanel.switchTo(home);
      await switchDone(window);
    }
    if ((await engine.tree()).nodes?.[id]) {
      await removeWorkspace(id);
    }
    await SvalPanel.refresh();
    await within(
      SvalPanel.observer?.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  });
  const tabs = [];
  for (const { url, title } of pages) {
    tabs.push(
      await engine.mutate({
        kind: "addTab",
        parent: id,
        name: title,
        url,
        id: crypto.randomUUID(),
        now: Date.now(),
      })
    );
  }
  await SvalPanel.refresh();
  return { id, tabs };
}

/**
 * Opens a window from `win` with the New Window command, as its key does,
 * and waits for the new window's panel. The window closes when the task
 * ends, and a workspace it made for itself goes after it.
 *
 * @param {Window} win
 * @returns {Promise<Window>}
 */
function newWindowCommand(win) {
  return secondWindow(() =>
    newWindowAfter(() => EventUtils.synthesizeKey("n", { accelKey: true }, win))
  );
}

/**
 * Opens a tab in `win` with the New Tab command's key.
 *
 * @param {Window} win
 * @returns {Promise<object>} the tab, in front.
 */
async function newTabCommand(win) {
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  EventUtils.synthesizeKey("t", { accelKey: true }, win);
  const tab = expectOpened(
    (await within(opened, 10_000, "the new tab")).target
  );
  await switchDone(win);
  return tab;
}
