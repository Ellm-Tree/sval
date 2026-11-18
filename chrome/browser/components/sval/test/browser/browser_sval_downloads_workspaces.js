/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Downloads belong to the workspace whose tab started them: the panel lists
 * the window's workspace's by default and every workspace's, labelled, on
 * request; a download opens the panel, or draws attention, only in a window
 * showing its workspace; and an agent's download does neither in a user's
 * window. Every download here is a page's, started from a tab of the window
 * whose workspace it is meant to be.
 */

const SvalDownloadWorkspaces = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDownloadWorkspaces.sys.mjs"
);

const DOWNLOAD_URL = ROOT + "sval_agent_download.sjs";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/**
 * Saves the task's downloads in a folder of its own, and takes every
 * download the task made off the list when it ends.
 */
async function downloadsGoToATempFolder() {
  const dir = await makeTempDir("sval-downloads");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", dir],
      ["browser.download.folderList", 2],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  atTaskEnd(async () => {
    for (const download of await list.getAll()) {
      await download.finalize(true).catch(() => {});
      await list.remove(download);
    }
    // The folder stays for scripts/test.sh to remove with the run's
    // temporary directory: on Windows another process, such as a virus
    // scanner, can still hold a file just downloaded, and the folder then
    // cannot be removed.
    await SpecialPowers.popPrefEnv();
  });
}

/**
 * A second window, which opens on a workspace of its own, as a user's does;
 * the workspace is named `name` and deleted when the task ends.
 *
 * @param {string} name
 * @returns {Promise<{win: Window, workspace: string}>}
 */
async function secondWindow(name) {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  await within(win.SvalPanel.started, 20_000, "its panel starting");
  const workspace = SvalWindowWorkspace.of(win).id;
  Assert.notEqual(workspace, SvalWindowWorkspace.of(window).id);
  await SvalPanel.engine.mutate({
    kind: "rename",
    id: workspace,
    name,
    now: Date.now(),
  });
  atTaskEnd(async () => {
    if (SvalPanel.nodes[workspace]) {
      await removeWorkspace(workspace);
    }
  });
  await SvalPanel.refresh();
  await win.SvalPanel.refresh();
  return { win, workspace };
}

/**
 * A page in a new tab of `win` downloads `name`, and the download finishes.
 *
 * @param {Window} win
 * @param {string} name
 * @returns {Promise<object>} The download.
 */
async function pageDownloads(win, name) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE),
    10_000,
    "the page loading"
  );
  const list = await Downloads.getList(Downloads.ALL);
  const found = () =>
    list
      .getAll()
      .then(all =>
        all.find(d => PathUtils.filename(d.target.path ?? "") === name)
      );
  await SpecialPowers.spawn(
    tab.linkedBrowser,
    [`${DOWNLOAD_URL}?name=${name}`],
    url => {
      content.eval(`location.href = ${JSON.stringify(url)};`);
    }
  );
  let download;
  await TestUtils.waitForCondition(
    async () => (download = await found())?.succeeded,
    `${name} is downloaded`
  );
  return download;
}

/**
 * Opens `win`'s Downloads panel if it is not open already, and closes it
 * when the task ends.
 *
 * @param {Window} [win]
 */
async function openDownloads(win = window) {
  const panel = win.document.getElementById("downloadsPanel");
  atTaskEnd(async () => {
    if (!win.closed) {
      // A window keeps its view while it shows the same workspace.
      win.document
        .querySelector('#sval-downloads-views [data-all="false"]')
        ?.click();
    }
    if (!win.closed && panel.state !== "closed") {
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      win.DownloadsPanel.hidePanel();
      await within(hidden, 10_000, "the downloads panel closing");
    }
  });
  if (panel.state === "open") {
    return;
  }
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  win.DownloadsPanel.showPanel();
  await within(shown, 10_000, "the downloads panel opening");
}

/**
 * @param {Window} [win]
 * @returns {string[]} The file names `win`'s panel lists, top first.
 */
const listedNames = (win = window) =>
  [...win.DownloadsView.richListBox.itemChildren].map(row =>
    row.querySelector(".downloadTarget").getAttribute("value")
  );

/**
 * @param {string} name
 * @returns {Element} The row listing the file `name`.
 */
const rowOf = name =>
  [...DownloadsView.richListBox.itemChildren].find(
    row => row.querySelector(".downloadTarget").getAttribute("value") === name
  );

const segment = (all, win = window) =>
  win.document.querySelector(`#sval-downloads-views [data-all="${all}"]`);

const empty = () => document.getElementById("sval-downloads-empty");

add_task(async function a_download_is_listed_in_its_own_workspace() {
  await downloadsGoToATempFolder();
  await pageDownloads(window, "here.txt");
  const { win } = await secondWindow("Research");
  await pageDownloads(win, "there.txt");

  await openDownloads();
  Assert.equal(segment(false).getAttribute("aria-checked"), "true");
  await TestUtils.waitForCondition(
    () => listedNames().length === 1,
    "the panel lists this workspace's download"
  );
  Assert.deepEqual(listedNames(), ["here.txt"]);
  Assert.ok(
    !rowOf("here.txt").querySelector(".sval-downloads-from"),
    "a row says nothing of its workspace in its own workspace's view"
  );

  segment(true).click();
  await TestUtils.waitForCondition(
    () => listedNames().length === 2,
    "All Workspaces lists both"
  );
  Assert.deepEqual(listedNames(), ["there.txt", "here.txt"], "newest first");
  Assert.equal(segment(true).getAttribute("aria-checked"), "true");
  const there = rowOf("there.txt");
  Assert.equal(
    there.querySelector(".sval-downloads-from-name").textContent,
    "Research"
  );
  Assert.ok(
    there.getAttribute("aria-description").includes("Research"),
    "its description names the workspace"
  );

  segment(false).click();
  await TestUtils.waitForCondition(
    () => listedNames().length === 1,
    "This Workspace lists its own again"
  );
  Assert.deepEqual(listedNames(), ["here.txt"]);

  await openDownloads(win);
  await TestUtils.waitForCondition(
    () => listedNames(win).length === 1,
    "the other window lists its own workspace's"
  );
  Assert.deepEqual(listedNames(win), ["there.txt"]);
});

add_task(async function the_empty_state_points_to_the_other_workspaces() {
  await downloadsGoToATempFolder();
  const { win } = await secondWindow("Research");
  await pageDownloads(win, "elsewhere.txt");
  await openDownloads();
  await TestUtils.waitForCondition(
    () => !empty().hidden,
    "the empty state shows"
  );
  Assert.deepEqual(listedNames(), []);
  Assert.ok(
    empty().hasAttribute("elsewhere"),
    "the empty state is the one for downloads in other workspaces"
  );
  const show = empty().querySelector(".sval-downloads-empty-show");
  Assert.ok(!show.hidden, "with a way to list them");
  show.click();
  await TestUtils.waitForCondition(
    () => listedNames().length === 1,
    "Show all Workspaces lists them"
  );
  Assert.deepEqual(listedNames(), ["elsewhere.txt"]);
  Assert.equal(segment(true).getAttribute("aria-checked"), "true");
  Assert.ok(empty().hidden);
});

add_task(async function with_no_downloads_anywhere_the_panel_says_so() {
  await downloadsGoToATempFolder();
  const list = await Downloads.getList(Downloads.ALL);
  Assert.deepEqual(await list.getAll(), [], "the session has no downloads");
  await openDownloads();
  await TestUtils.waitForCondition(() => !empty().hidden, "the empty state");
  Assert.ok(
    !empty().hasAttribute("elsewhere"),
    "the empty state is the one for no downloads anywhere"
  );
  Assert.ok(empty().querySelector(".sval-downloads-empty-show").hidden);
});

add_task(async function a_deleted_workspaces_download_says_so() {
  await downloadsGoToATempFolder();
  const { win, workspace } = await secondWindow("Research");
  await pageDownloads(win, "orphan.txt");
  await removeWorkspace(workspace);
  await SvalPanel.refresh();
  await openDownloads();
  segment(true).click();
  await TestUtils.waitForCondition(() => rowOf("orphan.txt"), "it is listed");
  const label = rowOf("orphan.txt").querySelector(".sval-downloads-from");
  Assert.equal(label.dataset.kind, "deleted");
  Assert.ok(
    label.querySelector(".sval-downloads-from-name").textContent,
    "the label names where it came from"
  );
  Assert.ok(
    rowOf("orphan.txt").getAttribute("aria-description"),
    "and the row describes it"
  );
});

/**
 * A download starting in a workspace a window shows opens that window's
 * panel; one starting in another window's workspace leaves this window's
 * panel and button alone.
 */
add_task(async function a_download_is_announced_only_where_its_workspace_is() {
  await downloadsGoToATempFolder();
  const panel = document.getElementById("downloadsPanel");
  const button = document.getElementById("downloads-button");
  const { win } = await secondWindow("Research");
  // This window is the one in front, which Firefox alone would tell.
  await within(SimpleTest.promiseFocus(window), 10_000, "this window's focus");
  // What the button shows is told by its attributes; a download of another
  // workspace sets none of them. An earlier download's announcement in this
  // window can still be ending, and clearing them.
  const changed = [];
  const watch = new MutationObserver(records =>
    changed.push(
      ...records
        .filter(r => button.hasAttribute(r.attributeName))
        .map(r => r.attributeName)
    )
  );
  watch.observe(button, { attributeFilter: ["attention", "notification"] });
  await pageDownloads(win, "elsewhere.txt");
  watch.disconnect();
  Assert.equal(panel.state, "closed", "this window's panel stays closed");
  Assert.deepEqual(changed, [], "and nothing is announced on its button");

  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  await pageDownloads(window, "here.txt");
  await within(shown, 10_000, "this workspace's download opening the panel");
  await openDownloads();
  Assert.deepEqual(listedNames(), ["here.txt"]);
});

/**
 * An agent's download, started in its own window behind the user's, is
 * listed under All Workspaces with the agent's name, and never opens the
 * panel or draws attention in the user's window.
 */
add_task(async function an_agents_download_stays_out_of_the_users_window() {
  await downloadsGoToATempFolder();
  const panel = document.getElementById("downloadsPanel");
  const button = document.getElementById("downloads-button");
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  await setup.store.setFilePermission(
    setup.agent.agentId,
    "downloads",
    "example.com",
    "allow"
  );
  const { tab } = await setup.call("open_tab", { url: PAGE });
  const { browser } = await setup.tabs.tabIn(setup.agent, tab);
  const list = await Downloads.getList(Downloads.ALL);
  await SpecialPowers.spawn(
    browser,
    [`${DOWNLOAD_URL}?name=agent.txt`],
    url => {
      content.eval(`location.href = ${JSON.stringify(url)};`);
    }
  );
  await TestUtils.waitForCondition(
    async () =>
      (await list.getAll()).some(
        d =>
          PathUtils.filename(d.target.path ?? "") === "agent.txt" && d.succeeded
      ),
    "the agent's download finishes"
  );
  Assert.equal(panel.state, "closed", "the user's panel stays closed");
  Assert.ok(!button.hasAttribute("attention"), "and the button is quiet");

  await SvalPanel.refresh();
  await openDownloads();
  Assert.ok(!rowOf("agent.txt"), "not this workspace's");
  segment(true).click();
  await TestUtils.waitForCondition(() => rowOf("agent.txt"), "it is listed");
  const label = rowOf("agent.txt").querySelector(".sval-downloads-from");
  Assert.equal(label.dataset.kind, "agent");
  Assert.equal(
    label.querySelector(".sval-downloads-from-name").textContent,
    "Test Agent"
  );
  Assert.ok(
    rowOf("agent.txt").getAttribute("aria-description").includes("Test Agent"),
    "the row's description names the agent"
  );
});

/** A paused download comes back from a restart to its workspace. */
add_task(async function a_download_keeps_its_workspace_through_a_restart() {
  await downloadsGoToATempFolder();
  const { win, workspace } = await secondWindow("Research");
  const download = await pageDownloads(win, "kept.txt");
  const restored = await Downloads.createDownload(
    JSON.parse(JSON.stringify(download.toSerializable()))
  );
  Assert.equal(SvalDownloadWorkspaces.workspaceOfDownload(restored), workspace);
});

/**
 * A download whose tab is gone by the time it joins the list is of no
 * workspace: listed only under All Workspaces, and announced nowhere, never
 * taken for the focused window's.
 */
add_task(async function a_download_from_a_closed_tab_is_of_no_workspace() {
  await downloadsGoToATempFolder();
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
    10_000,
    "a tab opening"
  );
  const contextId = tab.linkedBrowser.browsingContext.id;
  BrowserTestUtils.removeTab(tab);
  const list = await Downloads.getList(Downloads.PUBLIC);
  const download = await Downloads.createDownload({
    source: {
      url: `${DOWNLOAD_URL}?name=gone.txt`,
      browsingContextId: contextId,
    },
    target: PathUtils.join(await makeTempDir("sval-downloads"), "gone.txt"),
    succeeded: true,
  });
  await list.add(download);
  Assert.equal(
    SvalDownloadWorkspaces.workspaceOfDownload(download),
    SvalDownloadWorkspaces.UNKNOWN_WORKSPACE
  );
  Assert.equal(SvalDownloadWorkspaces.windowToTell(download, false), null);
  await openDownloads();
  await TestUtils.waitForCondition(() => !empty().hidden, "not listed here");
  segment(true).click();
  await TestUtils.waitForCondition(() => rowOf("gone.txt"), "listed under All");
  Assert.equal(
    rowOf("gone.txt").querySelector(".sval-downloads-from").dataset.kind,
    "unknown"
  );
});

/** Switching the window to another workspace goes back to This Workspace. */
add_task(async function a_switch_lists_the_new_workspaces_downloads() {
  await downloadsGoToATempFolder();
  const here = SvalWindowWorkspace.of(window).id;
  const { win, workspace } = await secondWindow("Research");
  await pageDownloads(win, "there.txt");
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the other window closing"
  );
  await openDownloads();
  segment(true).click();
  await TestUtils.waitForCondition(() => listedNames().length === 1);
  // A workspace with no window is shown with a new tab, on the way there and
  // back.
  const opened = event => expectOpened(event.target);
  gBrowser.tabContainer.addEventListener("TabOpen", opened);
  atTaskEnd(async () => {
    await SvalPanel.switchTo(here);
    gBrowser.tabContainer.removeEventListener("TabOpen", opened);
  });
  await SvalPanel.switchTo(workspace);
  await TestUtils.waitForCondition(
    () => segment(false).getAttribute("aria-checked") === "true",
    "the switch goes back to This Workspace"
  );
  Assert.deepEqual(listedNames(), ["there.txt"], "of the workspace now shown");
});

const clearButton = (win = window) =>
  win.document.getElementById("sval-downloads-clear");

add_task(async function a_rows_remove_button_takes_it_off_the_list() {
  await downloadsGoToATempFolder();
  await pageDownloads(window, "first.txt");
  await pageDownloads(window, "second.txt");
  await openDownloads();
  await TestUtils.waitForCondition(
    () => listedNames().length === 2,
    "the panel lists both"
  );
  const remove = rowOf("first.txt").querySelector(".sval-downloads-remove");
  Assert.ok(BrowserTestUtils.isVisible(remove), "a finished row has one");
  Assert.ok(remove.getAttribute("aria-label"), "it is named for a reader");
  remove.click();
  await TestUtils.waitForCondition(
    () => listedNames().length === 1,
    "the row leaves the list"
  );
  Assert.deepEqual(listedNames(), ["second.txt"]);
  const list = await Downloads.getList(Downloads.ALL);
  Assert.ok(
    !(await list.getAll()).some(
      d => PathUtils.filename(d.target.path ?? "") === "first.txt"
    ),
    "and the session's list"
  );
});

add_task(async function clear_list_clears_only_the_listed_downloads() {
  await downloadsGoToATempFolder();
  await pageDownloads(window, "here.txt");
  const { win } = await secondWindow("Research");
  await pageDownloads(win, "there.txt");
  await openDownloads();
  await TestUtils.waitForCondition(
    () => listedNames().length === 1,
    "the panel lists this workspace's download"
  );
  Assert.ok(BrowserTestUtils.isVisible(clearButton()), "Clear list shows");

  clearButton().doCommand();
  await TestUtils.waitForCondition(
    () => !empty().hidden,
    "this workspace's list is empty"
  );
  Assert.ok(BrowserTestUtils.isHidden(clearButton()), "Clear list hides");
  Assert.ok(empty().hasAttribute("elsewhere"), "the other's is kept");

  segment(true).click();
  await TestUtils.waitForCondition(
    () => listedNames().length === 1,
    "All Workspaces lists the other workspace's"
  );
  Assert.deepEqual(listedNames(), ["there.txt"]);
  clearButton().doCommand();
  await TestUtils.waitForCondition(
    () => listedNames().length === 0,
    "All Workspaces clears every workspace's"
  );
});
