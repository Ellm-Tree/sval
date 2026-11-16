/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the switcher's browser test files share. Each file loads this with
 * `loadSubScript` into its own scope.
 */

/* exported SvalEngine, SvalTabs, SvalRestore, SvalIdentity, SvalLocalSettings, SvalPanelModel, CURRENT_WORKSPACE_KEY, SYNC_DOCUMENT, leftWhenTheTaskEnds, nameTheProfilesWorkspace, withSwitcherPanel, switcherEntries, openSwitcher, closeSwitcher, activateWorkspace, treeJson, heldIds, quiet, assertNoHandOverFailure, untilRestored, percentEncoded, TITLED_TAB_URL, dialogsOver, typeInto, pageState, markPage, withSwitcherTabs, tearOff, untilFocused, dialogDocument, fillContainerDialog, answerNewContainer */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const { SvalRestore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalRestore.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

const { CURRENT_WORKSPACE_KEY, SYNC_DOCUMENT } = SvalPanelModel;

const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
  Ci.nsIConsoleAPIStorage
);

const HAND_OVER_FAILED = "handing the window to a workspace failed";

const consoleErrors = [];

add_setup(function the_console_is_read() {
  const observe = message => {
    if (message.level !== "error") {
      return;
    }
    consoleErrors.push(
      Array.from(message.arguments ?? [])
        .map(argument => String(argument))
        .join(" ")
    );
  };
  ConsoleAPIStorage.addLogEventListener(
    observe,
    Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
  );
  registerCleanupFunction(() => {
    ConsoleAPIStorage.removeLogEventListener(observe);
  });
});

/**
 * Declares the tabs the window's workspaces open as the running task's, and
 * when it ends switches the window back to the workspace it shows now and
 * deletes `workspaces`, so the next task in the file finds the window as
 * this one did.
 *
 * @param {string[]} workspaces The task's workspaces, read when it ends, so a
 *   caller may fill the array after this call.
 */
function leftWhenTheTaskEnds(workspaces) {
  const home = SvalPanel.workspaceId;
  expectWorkspaceTabs();
  atTaskEnd(async () => {
    if (home && SvalPanel.workspaceId !== home) {
      await within(SvalPanel.switchTo(home), 10_000, "the switch back home");
    }
    const left = (await SvalPanel.engine.tree()).nodes ?? {};
    for (const id of workspaces) {
      if (id in left) {
        await removeWorkspace(id);
      }
    }
    await SvalPanel.refresh();
    await within(
      SvalPanel.observer?.settled(),
      10_000,
      "the window's observer settling"
    );
  });
}

/**
 * Names the profile's own workspace, first in sibling order, for the running
 * task, and gives it back the name it had when the task ends. The profile
 * starts it nameless, and a task that lands on it tells it by name.
 *
 * @param {string} name
 * @returns {Promise<string>} its id.
 */
async function nameTheProfilesWorkspace(name) {
  const { engine } = SvalPanel;
  const [id] = SvalPanelModel.workspaceIds(SvalPanel.nodes);
  const was = SvalPanel.nodes[id].content?.name ?? "";
  const rename = to =>
    engine.mutate({ kind: "rename", id, name: to, now: Date.now() });
  await rename(name);
  atTaskEnd(async () => {
    await rename(was);
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  return id;
}

/**
 * Adds workspaces to the window's own document, each holding one tab, and
 * switches the window to the first, as the switcher does.
 *
 * Two workspaces is the minimum that can tell "draws one workspace" from
 * "draws the tree": with one, every assertion about scope passes for free.
 * The document also holds the profile's own workspace, which the window
 * showed before, so a task asserts on `ids` and never on totals.
 *
 * The switch opens the first workspace's tab at its address. When the task
 * ends, `leftWhenTheTaskEnds` takes the window back and the workspaces away.
 *
 * @param {object} [options]
 * @param {number} [options.workspaces] How many workspaces to create.
 * @param {string[]} [options.names] Their names, in order; one workspace each.
 * @param {string} [options.tabUrl] What each workspace's tab node points at.
 *   A `%s` is replaced by the workspace's number.
 * @returns {Promise<object>} `{ engine, settings, ids, root, keys }`, where
 *   `root` and `keys` are what a peer engine on the same folder takes.
 */
async function withSwitcherPanel({
  names = null,
  workspaces = names?.length ?? 2,
  tabUrl = "https://example.com/%s",
} = {}) {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const { engine, settings } = SvalPanel;
  const keys = await svalKeys();

  const now = Date.now();
  const ids = { workspaces: [], tabs: [] };
  leftWhenTheTaskEnds(ids.workspaces);
  // Each node is appended after its parent's last child, so creation order is
  // the sibling order, and sibling order is what "the first workspace" means
  // on every device.
  for (let i = 0; i < workspaces; i++) {
    const workspace = await engine.mutate({
      kind: "addWorkspace",
      name: names?.[i] ?? `Workspace ${i + 1}`,
      id: crypto.randomUUID(),
      now,
    });
    ids.workspaces.push(workspace);
    const tab = await engine.mutate({
      kind: "addTab",
      parent: workspace,
      name: `Tab in ${i + 1}`,
      url: tabUrl.replace("%s", String(i + 1)),
      id: crypto.randomUUID(),
      now,
    });
    settings.setCollapsed(workspace, false);
    ids.tabs.push(tab);
  }
  // Published, so a peer reading the folder finds this device's file.
  await engine.sync(SYNC_DOCUMENT, now);
  await SvalPanel.refresh();
  Assert.ok(
    await within(
      SvalPanel.switchTo(ids.workspaces[0]),
      10_000,
      "the switch to the first workspace"
    ),
    "the window shows the first workspace made"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the window's observer settling"
  );

  return { engine, settings, ids, root: engine.root, keys };
}

/**
 * The switcher's workspace entries, without the tear-off submenu below them.
 *
 * The popup holds one radio entry per workspace, then "Open in New Window"
 * with the workspaces no window shows under it (spec §10.7), so a test about
 * the list reads only the entries.
 *
 * @param {Element} menu An open `menupopup`.
 * @param {string[]} [among] Only the entries for these workspaces: the
 *   profile's document holds workspaces a task did not make.
 * @returns {Element[]} the workspace entries, in order.
 */
function switcherEntries(menu, among = null) {
  return Array.from(menu.querySelectorAll("[data-workspace-id]")).filter(
    item => !among || among.includes(item.dataset.workspaceId)
  );
}

/**
 * Opens the switcher and waits for it to show, so a button that was never
 * wired, or a popup never appended, fails here.
 *
 * @returns {Promise<Element>} the open `menupopup`.
 */
async function openSwitcher() {
  // A popup opens only in the focused window on Windows, and a window an
  // earlier task tore off may still hold focus. Gecko opens a chrome
  // window's popup whether or not it has focus (`MayShowPopup` in
  // nsXULPopupManager.cpp), and on Linux a raise the test asks for carries
  // the time of the last real input (`nsWindow::SetFocus`), which a
  // synthesized event never moves, so the window manager may refuse it.
  if (AppConstants.platform == "win") {
    await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  }
  const menu = SvalPanel._els.switcherMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  SvalPanel._els.switcher.click();
  await within(shown, 10_000, "the switcher opening");
  return menu;
}

/** @param {Element} menu An open `menupopup`. @returns {Promise<void>} */
async function closeSwitcher(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the switcher closing");
}

/**
 * Activates one workspace in the open switcher.
 *
 * @param {Element} menu An open `menupopup`.
 * @param {string} id A workspace id.
 * @returns {Promise<void>}
 */
async function activateWorkspace(menu, id) {
  await chooseMenuItem(
    menu.querySelector(`[data-workspace-id="${CSS.escape(id)}"]`),
    menu,
    `${id} in the switcher`
  );
  // The switch reads the document before it moves the window.
  await within(
    SvalPanel._switching?.idle() ?? Promise.resolve(),
    10_000,
    "the switch"
  );
}

/**
 * The document's nodes as one string.
 *
 * @param {object} engine A `SvalEngine`.
 * @returns {Promise<string>}
 */
async function treeJson(engine) {
  return JSON.stringify((await engine.tree()).nodes ?? {});
}

/** Node ids this window currently holds a tab for. */
function heldIds() {
  return gBrowser.tabs.map(taggedId).filter(Boolean);
}

/**
 * Runs the idle unload as it runs once every hidden workspace's time is up
 * (`SvalTabObserver.releaseIdle`), releasing their tabs from the window.
 *
 * @param {object} observer A `SvalTabObserver`.
 * @returns {Promise<object>} what `releaseIdle` answers.
 */
function releaseHiddenNow(observer) {
  const { HIDDEN_WORKSPACE_UNLOAD_MS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
  );
  const { SvalClock: clock } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalClock.sys.mjs"
  );
  return observer.releaseIdle(clock.now() + HIDDEN_WORKSPACE_UNLOAD_MS);
}

/**
 * Node ids this window shows a tab for: those it holds, less the tabs of
 * workspaces it has left, which stay hidden and loaded
 * (`SvalFirefox.hideForWorkspace`) until the idle unload lets them go.
 */
function shownIds() {
  return gBrowser.visibleTabs.map(taggedId).filter(Boolean);
}

/**
 * Waits until the window has stopped loading and the document has stopped
 * moving, and answers with the document.
 *
 * Showing a materialised tab loads its page, and the observer then brings
 * that node up to what the tab shows, asynchronously: a title can arrive
 * several turns after the load commits. So this settles until every tab's
 * node says what that tab says, which is the observer's own definition of
 * having nothing left to write. Then a further flush changes nothing and the
 * document can be compared byte for byte. The harness serves the fixture's
 * pages with no promise of promptness, so a fixed count of tries would race
 * the title.
 *
 * The shown tab's restore is waited for first. Session store marks a tab
 * restoring and drops `pending` before its load starts
 * (`SessionStoreInternal.markTabAsRestoring`), so for a while the tab is
 * neither pending nor busy, and its address and label are the restored ones,
 * which its node already holds. The page commits after that, and the commit
 * is a write waiting for the next flush.
 *
 * @param {object} engine A `SvalEngine`.
 * @param {object} observer A `SvalTabObserver`.
 * @returns {Promise<string>} the document's nodes as one comparable string.
 */
async function quiet(engine, observer) {
  const shown = gBrowser.selectedTab;
  if (shown.linkedPanel) {
    await untilRestored(shown);
  }
  await TestUtils.waitForCondition(async () => {
    await within(observer.settled(), 10_000, "observer settling");
    await SvalPanel.refresh();
    const tree = (await engine.tree()).nodes ?? {};
    // Every tab, because a switch loads more than the tab it ends on, and a
    // title arriving for a tab the window has stopped showing moves the
    // document too.
    return gBrowser.tabs.every(tab => {
      const id = taggedId(tab);
      // Tabs the observer never writes for, so no node has to agree: an
      // untagged one (the blank tab an empty workspace is given is one), a
      // lazy one, and one showing a blank page.
      if (!id || !tab.linkedPanel || tab.isEmpty === true) {
        return true;
      }
      if (
        tab.documentGlobal.isBlankPageURL(tab.linkedBrowser.currentURI.spec)
      ) {
        return true;
      }
      const node = tree[id];
      return (
        node?.content?.url === tab.linkedBrowser.currentURI.spec &&
        node?.content?.name === tab.label
      );
    });
  }, "no tab in the window disagrees with the node it stands for");
  await assertNoHandOverFailure();
  return treeJson(engine);
}

/**
 * Fails if any hand-over has thrown.
 *
 * Read from the console: a failed hand-over is a bug and is not narrated to
 * the user (spec §10.7), so the console is its only record. A console call
 * on the parent's main thread reaches `ConsoleAPIStorage`'s listeners before
 * it returns (`MainThreadConsoleData::ProcessCallData`), so the record is
 * whole once the hand-over has ended.
 *
 * @returns {void}
 */
function assertNoHandOverFailure() {
  Assert.deepEqual(
    consoleErrors.filter(text => text.includes(HAND_OVER_FAILED)),
    [],
    "no hand-over failed"
  );
}

/**
 * Waits until session store has finished restoring `tab`'s page.
 *
 * A switch materialises a tab and session store restores its page after the
 * switch returns. A content task sent before the restore has finished can
 * land in the document the restore replaces, and is cancelled with it.
 *
 * @param {Element} tab
 */
async function untilRestored(tab) {
  await TestUtils.waitForCondition(
    () =>
      !SessionStore.getInternalObjectState(tab.linkedBrowser) &&
      !tab.linkedBrowser.webProgress.isLoadingDocument,
    "the tab's page is restored"
  );
}

/**
 * A served page titled "Tab in %s", for `withSwitcherPanel`'s `tabUrl`: a web
 * address, which a tab restores at (`SvalRestore`), whose title is the node's
 * own name, so showing it leaves the observer nothing to write.
 */
const TITLED_TAB_URL = `${ROOT}sval_switcher_page.sjs?%3Ctitle%3ETab%20in%20%s%3C/title%3E`;

/**
 * `text` with every character but a letter or digit percent-encoded, so an
 * address made of it reads back from `nsIURI` exactly as written.
 *
 * @param {string} text
 * @returns {string}
 */
function percentEncoded(text) {
  return Array.from(new TextEncoder().encode(text), byte => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

/**
 * How many dialogs are open over `tab`'s page.
 *
 * @param {Element} tab
 * @returns {number}
 */
function dialogsOver(tab) {
  const box = gBrowser.getTabDialogBox(tab.linkedBrowser);
  return (
    box.getTabDialogManager()._dialogs.length +
    box.getContentDialogManager()._dialogs.length
  );
}

/**
 * Clicks into `selector` in `tab`'s page and types `text` there, as a person
 * does.
 *
 * @param {Element} tab The selected tab.
 * @param {string} selector
 * @param {string} text
 */
async function typeInto(tab, selector, text) {
  await untilRestored(tab);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    selector,
    {},
    tab.linkedBrowser
  );
  EventUtils.sendString(text);
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(tab.linkedBrowser, [selector, text], (sel, typed) => {
        const element = content.document.querySelector(sel);
        return (element.value ?? element.textContent).includes(typed);
      }),
    "the page holds what was typed"
  );
}

/**
 * What `tab`'s page holds: the text in `selector`, and a mark only the
 * document the user typed into carries.
 *
 * @param {Element} tab
 * @param {string} selector
 * @returns {Promise<{text: string, marked: boolean}>}
 */
function pageState(tab, selector) {
  return SpecialPowers.spawn(tab.linkedBrowser, [selector], sel => {
    const element = content.document.querySelector(sel);
    return {
      text: element.value ?? element.textContent,
      marked: content.document.body.dataset.visit === "before the switch",
    };
  });
}

/**
 * Marks the document `tab` shows, so coming back to the same document can be
 * told from a reload that restored the same text.
 *
 * @param {Element} tab
 */
function markPage(tab) {
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.body.dataset.visit = "before the switch";
  });
}

/**
 * Tears `id` off through the switcher, by its entry's "Open in New Window" or
 * by a Shift+click on the entry, and waits for the new window's panel to have
 * started. The window closes when the running task ends.
 *
 * The event is dispatched for the reason {@link activateWorkspace} documents.
 * An entry with a submenu is a `menu`, which runs no `command` of its own, so
 * a Shift+click is the `mouseup` the panel takes it by.
 *
 * @param {string} id A workspace id.
 * @param {object} [options]
 * @param {boolean} [options.shiftClick] Shift+click the entry.
 * @returns {Promise<DOMWindow>} the new window.
 */
async function tearOff(id, { shiftClick = false } = {}) {
  const menu = await openSwitcher();
  const selector = shiftClick
    ? `menu[data-workspace-id="${CSS.escape(id)}"]`
    : `[data-open-workspace-id="${CSS.escape(id)}"]`;
  const item = menu.querySelector(selector);
  Assert.ok(item, `${id} is offered a window of its own`);
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  if (shiftClick) {
    const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    item.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, shiftKey: true })
    );
    menu.hidePopup();
    await within(hidden, 10_000, "the switcher closing");
  } else {
    await chooseMenuItem(item, menu, `${id}'s own window`);
  }
  const win = await within(opening, 20_000, "the torn-off window's opening");
  // Closed before `leftWhenTheTaskEnds` deletes the task's workspaces, so no
  // window is left showing one the document no longer holds.
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the test window closing"
      );
    }
  });
  await within(
    win.SvalPanel.started,
    20_000,
    "the torn-off window's panel starting"
  );
  return win;
}

/**
 * Waits until `win` is the window with focus.
 *
 * @param {DOMWindow} win
 * @param {string} why
 */
async function untilFocused(win, why) {
  await TestUtils.waitForCondition(
    () => Services.focus.activeWindow === win,
    why
  );
}

/**
 * `withSwitcherPanel` with tabs whose pages the observer leaves alone, and
 * every workspace already shown once.
 *
 * Showing each workspace first is what makes the round-trip assertion
 * meaningful. Showing a tab loads its page, and the observer then writes
 * what the tab shows into that node. Those writes land before the baseline,
 * so a later switch can be compared byte for byte. The tasks assert that the
 * baseline still holds every node the fixture created, so this warm-up
 * cannot hide a loss of its own.
 *
 * @param {object} [options]
 * @param {number} [options.workspaces] How many workspaces to create.
 * @param {string[]} [options.names] Their names, as `withSwitcherPanel`
 *   takes them.
 * @param {string} [options.body] Markup each tab's page carries after its
 *   title, for a task about what a page holds.
 * @returns {Promise<object>} `withSwitcherPanel`'s result, plus the window's
 *   `observer` and `baseline` (the settled document as one string).
 */
async function withSwitcherTabs({
  names = null,
  workspaces = names?.length ?? 2,
  body = "",
} = {}) {
  // A page whose title is the node's own name, so showing a tab leaves the
  // observer nothing to write, and "the tree is unchanged" is a statement
  // about switching alone. It is served because a tab restores only at an
  // address a web page could open (`SvalRestore`), which a top-level `data:`
  // page is not. `about:blank` would race: Firefox renames a blank tab a few
  // turns after showing it, and the observer writes that name.
  const fixture = await withSwitcherPanel({
    names,
    workspaces,
    tabUrl: TITLED_TAB_URL + percentEncoded(body),
  });
  const { observer } = SvalPanel;

  // Each other workspace in turn, ending on the first again.
  let baseline = await quiet(fixture.engine, observer);
  const [first, ...rest] = fixture.ids.workspaces;
  for (const id of [...rest, first]) {
    await within(SvalPanel.switchTo(id), 10_000, "a warm-up switch");
    baseline = await quiet(fixture.engine, observer);
  }
  // The warm-up leaves the other workspaces hidden and loaded; a task
  // starts from a window holding the workspace it shows and nothing else.
  await releaseHiddenNow(observer);
  baseline = await quiet(fixture.engine, observer);

  return { ...fixture, observer, baseline };
}

/**
 * Waits for the dialog that is open and staying open to show `selector`, and
 * answers with its document.
 *
 * A dialog just answered stays `gDialogBox.dialog` until its frame unloads,
 * with `_isClosing` set from the moment it was closed, so this waits past it
 * for the next one, and on that one's readiness.
 *
 * @param {string} selector What the page draws once it is ready.
 * @returns {Promise<Document>}
 */
async function dialogDocument(selector) {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = gDialogBox.dialog;
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
 * Makes `changes` in the open "New workspace", "New group" or Edit dialog,
 * as a person does, leaving every field `changes` does not name as it is.
 *
 * An emoji the picker draws only at a skin tone is reached through the tone
 * control, which the picker keeps for its next opening, as it does for a
 * person.
 *
 * @param {object} changes
 * @param {string} [changes.name]
 * @param {string|null} [changes.color] A palette token, or null for none.
 * @param {string|null} [changes.emoji] An emoji, or null or "" for none.
 * @returns {Promise<Document>} the dialog's document, ready for its buttons.
 */
async function fillContainerDialog(changes) {
  let doc = await dialogDocument(".sval-nw-name");
  if ("name" in changes) {
    const field = doc.querySelector(".sval-nw-name");
    field.value = changes.name;
    field.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  }
  if ("color" in changes) {
    // The swatches are a radio group with a roving tabindex: Tab reaches the
    // checked one and the arrow keys the rest.
    AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
    doc
      .querySelector(`.sval-nw-swatch[data-token="${changes.color ?? ""}"]`)
      .click();
    AccessibilityUtils.resetEnv();
  }
  const shown = doc.querySelector(".sval-nw-emoji-value");
  const showing = shown.hasAttribute("data-empty") ? "" : shown.textContent;
  if ("emoji" in changes && showing !== (changes.emoji ?? "")) {
    doc.querySelector(".sval-nw-emoji").click();
    const picker = await dialogDocument(".sval-emoji-choice");
    let choice = null;
    if (changes.emoji) {
      AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
      for (const tone of picker.querySelectorAll(".sval-emoji-tone")) {
        tone.click();
        choice = [...picker.querySelectorAll(".sval-emoji-choice")].find(
          button => button.textContent === changes.emoji
        );
        if (choice) {
          break;
        }
      }
      AccessibilityUtils.resetEnv();
    } else {
      choice = picker.querySelector(".sval-emoji-none");
    }
    Assert.ok(choice, `the picker offers ${changes.emoji || "no emoji"}`);
    choice.click();
    doc = await dialogDocument(".sval-nw-name");
  }
  return doc;
}

/**
 * Fills in the "New workspace" or "New group" dialog the panel has opened and
 * presses Create.
 *
 * @param {object} answer What `fillContainerDialog` takes.
 * @returns {Promise<void>}
 */
async function answerNewContainer(answer) {
  const doc = await fillContainerDialog(answer);
  doc.querySelector(".sval-nw-create").click();
}
