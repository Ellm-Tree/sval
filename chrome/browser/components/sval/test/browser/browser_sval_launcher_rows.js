/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * What the address bar's rows teach and how a screen reader hears them
 * (launcher spec §7, §8): an open tab of another workspace shows that
 * workspace as a chip and is named with it, an agent's tab with the agent's
 * workspace, the selected row says what Enter does, the line under the list
 * says what its modifiers do, and each section is a group named by its
 * heading.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/**
 * A served page titled `title`.
 *
 * @param {string} title
 * @returns {string}
 */
function titled(title) {
  return `${ROOT}sval_switcher_page.sjs?%3Ctitle%3E${percentEncoded(title)}%3C/title%3E`;
}

/**
 * Work and Home, this window on Work, Home green with 🏠, and a tab
 * "Calendar" in Home and "Cartography" in Work.
 *
 * @returns {Promise<object>}
 */
async function workAndHome() {
  const fixture = await withSwitcherTabs({ names: ["Work", "Home"] });
  const [work, home] = fixture.ids.workspaces;
  const now = Date.now();
  await fixture.engine.mutate({
    kind: "setAppearance",
    id: home,
    color: "green",
    emoji: "🏠",
  });
  const calendar = await fixture.engine.mutate({
    kind: "addTab",
    parent: home,
    name: "Calendar",
    url: titled("Calendar"),
    id: crypto.randomUUID(),
    now,
  });
  const cartography = await fixture.engine.mutate({
    kind: "addTab",
    parent: work,
    name: "Cartography",
    url: titled("Cartography"),
    id: crypto.randomUUID(),
    now,
  });
  await SvalPanel.refresh();
  return { ...fixture, work, home, calendar, cartography };
}

/**
 * Types `value` and answers the view's rows once the parts they show, and
 * the words of their names and headings, are in.
 *
 * @param {string} value
 * @param {Window} [win]
 * @returns {Promise<Element[]>} the `.urlbarView-row`s shown.
 */
async function shownRows(value, win = window) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, value }),
    10_000,
    "the address bar's results"
  );
  const rows = () =>
    [...win.gURLBar.querySelectorAll(".urlbarView-row")].filter(
      row => row.result && !row.hasAttribute("hidden")
    );
  await TestUtils.waitForCondition(
    () =>
      rows().every(
        row =>
          ![
            ...row.querySelectorAll(
              ".sval-launcher-hint-verb, .urlbarView-group-aria-label"
            ),
          ].some(
            el =>
              !(el.textContent || el.getAttribute("aria-label")) &&
              (el.hasAttribute("data-l10n-id") ||
                el.classList.contains("urlbarView-group-aria-label"))
          ) &&
          (!row._content.hasAttribute("data-l10n-id") ||
            row._content.hasAttribute("aria-label")) &&
          // A page's, a search's or a tree tab's row names its keys.
          (row.result.type === UrlbarUtils.RESULT_TYPE.DYNAMIC ||
            !row.hasAttribute("sval-kind") ||
            (row.getAttribute("sval-kind") === "tab" &&
              !row.result.payload.svalNodeId) ||
            row._content.hasAttribute("aria-description"))
      ),
    "the rows have their words"
  );
  return rows();
}

/**
 * The line under the list, as `keys l10n-id` items, or a note's l10n id,
 * once its words are in.
 *
 * @param {Window} [win]
 * @returns {Promise<string[]>}
 */
async function footItems(win = window) {
  const line = win.gURLBar.querySelector(".sval-launcher-foot");
  await TestUtils.waitForCondition(
    () =>
      line.children.length &&
      [...line.querySelectorAll("[data-l10n-id]")].every(el => el.textContent),
    "the line's words"
  );
  Assert.equal(line.getAttribute("aria-hidden"), "true", "rows say it");
  const word = el => el.getAttribute("data-l10n-id") ?? el.textContent;
  return [...line.children].map(item =>
    [...item.children].length
      ? [...item.children].map(word).join(" ")
      : word(item)
  );
}

/**
 * What `sval/launcher.ftl` says for `id`.
 *
 * @param {string} id
 * @param {object} [options] `fluentText`'s.
 * @returns {string}
 */
function launcherText(id, options) {
  return fluentText("sval/launcher.ftl", id, options);
}

/**
 * A row's description of its keys: the words of each, listed as
 * `SvalLauncherRows.accessOf` lists them.
 *
 * @param {...string} ids The words' l10n ids.
 * @returns {string}
 */
function meaningsOf(...ids) {
  return new Intl.ListFormat(Services.locale.appLocalesAsBCP47, {
    type: "unit",
  }).format(ids.map(id => launcherText(id)));
}

/**
 * An open tab's row's name, as the l10n id and the title and Workspace it
 * is given.
 *
 * @param {Element} option The row's content, which carries its name.
 * @returns {{id: string, title: string, workspace: string}}
 */
function tabName(option) {
  const { id, args } = document.l10n.getAttributes(option);
  return { id, title: args?.title, workspace: args?.workspace };
}

/**
 * The keys a modifier of Enter shows, as the line spells them.
 *
 * @param {string} modifiers
 * @returns {string}
 */
function enterWith(modifiers) {
  const { ShortcutUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/ShortcutUtils.sys.mjs"
  );
  return (
    ShortcutUtils.getModifierString(modifiers) +
    (AppConstants.platform === "macosx"
      ? "↵"
      : ShortcutUtils.getKeyString("VK_RETURN"))
  );
}

/**
 * An open tab of another workspace shows that workspace as a chip in its
 * colour with its emoji, says it in its name and keeps its address as its
 * description; the selected row says what Enter does, and the line under
 * the list follows the selection.
 */
add_task(async function an_open_tab_names_its_workspace() {
  const { calendar } = await workAndHome();
  const rows = await shownRows("cal");
  const tab = rows.find(r => r.result.payload.svalNodeId === calendar);
  Assert.ok(tab, "Calendar is listed");
  const chip = tab.querySelector(".sval-chip");
  Assert.equal(
    chip?.querySelector(".sval-chip-name").textContent,
    "Home",
    "a chip names its workspace"
  );
  Assert.equal(
    chip.querySelector(".sval-chip-emoji")?.textContent,
    "🏠",
    "with its emoji"
  );
  Assert.equal(chip.dataset.color, "green", "in the workspace's colour");
  const option = tab._content;
  Assert.deepEqual(
    tabName(option),
    {
      id: "launcher-result-tab-name",
      title: "Calendar",
      workspace: "Home",
    },
    "its name says its workspace"
  );
  const address = tab.result.getDisplayableValueAndHighlights("url", {
    isURL: true,
  }).value;
  Assert.equal(
    option.getAttribute("aria-description"),
    new Intl.ListFormat(Services.locale.appLocalesAsBCP47, {
      type: "unit",
    }).format([
      address,
      launcherText("launcher-foot-new-window"),
      launcherText("launcher-foot-split-with-tab"),
    ]),
    "its address and its key's meaning are its description"
  );
  Assert.equal(
    option.getAttribute("aria-keyshortcuts"),
    "Shift+Enter Alt+Enter",
    "its keys a screen reader hears"
  );

  // The row Enter takes is the search for what was typed, selected.
  const close = "Esc launcher-foot-close";
  const search = rows.find(r => r.hasAttribute("selected"));
  Assert.equal(search, rows[0], "the first row is selected");
  Assert.equal(search.result.type, UrlbarUtils.RESULT_TYPE.SEARCH);
  await TestUtils.waitForCondition(
    () => search.querySelector(".sval-launcher-hint").textContent.length > 1,
    "the search's hint"
  );
  Assert.equal(
    document.l10n.getAttributes(
      search.querySelector(".sval-launcher-hint-verb")
    ).id,
    "launcher-hint-search",
    "Enter searches"
  );
  Assert.deepEqual(
    await footItems(),
    [
      `${enterWith("shift")} launcher-foot-new-tab`,
      `${enterWith("accel,shift")} launcher-foot-new-window`,
      `${enterWith("alt")} launcher-foot-split`,
      close,
    ],
    "the line offers the search's places"
  );

  // The tab follows it, and once selected says what Enter does there.
  Assert.equal(rows[1], tab, "Calendar is the next row");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.ok(tab.hasAttribute("selected"), "Calendar is selected");
  const hint = tab.querySelector(".sval-launcher-hint");
  Assert.ok(hint.checkVisibility(), "the selected row shows its hint");
  Assert.deepEqual(
    document.l10n.getAttributes(hint.querySelector(".sval-launcher-hint-verb")),
    { id: "launcher-hint-switch-to", args: { workspace: "Home" } },
    "Enter switches to Home"
  );
  Assert.equal(
    hint.querySelector(".sval-keycap").textContent,
    enterWith(""),
    "on Enter"
  );
  for (const other of rows.filter(r => r !== tab)) {
    Assert.ok(
      !other.querySelector(".sval-launcher-hint")?.checkVisibility(),
      "no other row shows one"
    );
  }
  Assert.deepEqual(
    await footItems(),
    [
      `${enterWith("shift")} launcher-foot-new-window`,
      `${enterWith("alt")} launcher-foot-split-with-tab`,
      close,
    ],
    "the line follows the selected row: Home's window and a split with the tab"
  );
});

/** A tab of the window's own workspace shows no chip and switches to it. */
add_task(async function a_tab_here_has_no_chip() {
  const { cartography } = await workAndHome();
  const rows = await shownRows("cart");
  const tab = rows.find(r => r.result.payload.svalNodeId === cartography);
  Assert.ok(tab, "Cartography is listed");
  Assert.ok(!tab.querySelector(".sval-chip"), "no chip");
  Assert.deepEqual(
    tabName(tab._content),
    {
      id: "launcher-result-tab-name",
      title: "Cartography",
      workspace: "Work",
    },
    "its name still says its workspace"
  );
  UrlbarTestUtils.setSelectedRowIndex(window, rows.indexOf(tab));
  await TestUtils.waitForCondition(
    () =>
      document.l10n.getAttributes(tab.querySelector(".sval-launcher-hint-verb"))
        .id === "launcher-hint-switch-tab",
    "Enter switches to the tab"
  );
});

/** An agent's tab is named with the agent's workspace, its chip the agent's. */
add_task(async function an_agents_tab_names_the_agent() {
  const { engine } = await workAndHome();
  const now = Date.now();
  const agentWs = await engine.mutate({
    kind: "addAgentWorkspace",
    name: "Test Agent",
    agentLabel: "Test Agent",
    id: crypto.randomUUID(),
    now,
  });
  leftWhenTheTaskEnds([agentWs]);
  const atlas = await engine.mutate({
    kind: "addTab",
    parent: agentWs,
    name: "Atlas",
    url: titled("Atlas"),
    id: crypto.randomUUID(),
    now,
  });
  await SvalPanel.refresh();
  try {
    const rows = await shownRows("atl");
    const tab = rows.find(r => r.result.payload.svalNodeId === atlas);
    const name = tab._content.getAttribute("aria-label");
    Assert.ok(
      name.includes("Atlas") && name.includes("Test Agent"),
      "its name says the agent's workspace"
    );
    const chip = tab.querySelector(".sval-chip");
    Assert.ok(chip.hasAttribute("data-agent"), "the agent's chip");
    Assert.equal(chip.textContent, "Test Agent");
  } finally {
    await engine.mutate({ kind: "remove", id: agentWs, now: Date.now() });
    await SvalPanel.refresh();
  }
});

/**
 * Each section is a group a screen reader enters by its heading: the first
 * row of a section is the group, named by the heading, and owns the other
 * rows of the section. Rows above the first heading are in no group.
 */
add_task(async function sections_are_groups_named_by_their_headings() {
  await workAndHome();
  const rows = await shownRows("ca");
  const headed = rows.filter(r => r.hasAttribute("label"));
  Assert.ok(headed.length, "a section shows");
  for (const row of headed) {
    Assert.equal(row.getAttribute("role"), "group", "a group");
    Assert.equal(
      row.getAttribute("aria-label"),
      row.getAttribute("label"),
      "named by its heading"
    );
    Assert.equal(
      row
        .querySelector(".urlbarView-group-aria-label")
        .getAttribute("aria-hidden"),
      "true",
      "said once"
    );
    const at = rows.indexOf(row);
    const next = rows.findIndex((r, i) => i > at && r.hasAttribute("label"));
    const inSection = rows.slice(at + 1, next < 0 ? undefined : next);
    Assert.deepEqual(
      row.getAttribute("aria-owns").split(" ").filter(Boolean),
      inSection.map(r => r._content.id),
      "it holds the section's other rows"
    );
  }
  // As the accessibility tree has it.
  const group = await accessibleOf(headed[0]);
  await TestUtils.waitForCondition(
    () => group.name === headed[0].getAttribute("label"),
    "the section's group, named"
  );
  Assert.equal(group.role, Ci.nsIAccessibleRole.ROLE_GROUPING, "a grouping");
  const first = rows.indexOf(headed[0]);
  for (const row of rows.slice(0, first)) {
    Assert.notEqual(row.getAttribute("role"), "group", "the top area");
  }
});

/**
 * A command's row: the line under the list says its key runs it from
 * anywhere, or that it has none; a command that picks says it opens a list.
 */
add_task(async function a_commands_line_teaches_its_key() {
  const { keyOf, shortcutText } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs"
  );
  await workAndHome();
  const close = "Esc launcher-foot-close";
  const select = async (value, commandId) => {
    const rows = await shownRows(value);
    const at = rows.findIndex(r => r.result.payload.commandId === commandId);
    Assert.greaterOrEqual(at, 0, `${commandId} is listed`);
    UrlbarTestUtils.setSelectedRowIndex(window, at);
    return rows[at];
  };

  const history = await select("history", "history");
  const key = shortcutText(keyOf(document.getElementById("key_gotoHistory")));
  Assert.equal(
    history.querySelector(".urlbarView-dynamic-svalCommand-shortcut")
      .textContent,
    key,
    "the row shows its key"
  );
  Assert.deepEqual(await footItems(), [
    `${key} launcher-foot-runs-anywhere`,
    close,
  ]);

  await select("copy markdown", "copy-markdown-link");
  Assert.deepEqual(await footItems(), ["launcher-foot-no-shortcut", close]);

  await select("move this tab", "move-tab");
  Assert.deepEqual(await footItems(), ["launcher-foot-opens-list", close]);
});

/**
 * The line under the list is hidden from a screen reader, so each row names
 * the keys it shows there: a page's, a history page's and a search's
 * modifiers in `aria-keyshortcuts`, and what each does in its description,
 * in the same order.
 */
add_task(async function each_row_names_its_keys() {
  const { ariaShortcut } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs"
  );
  await workAndHome();
  // A page in this tab, so Alt+Enter splits beside it.
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, titled("Here")),
    10_000,
    "a page's tab"
  );
  await PlacesTestUtils.addVisits([
    { uri: "https://example.net/sval-mosaic", title: "Mosaic page" },
  ]);
  const enter = modifiers => ariaShortcut({ keycode: "VK_RETURN", modifiers });
  const opens = [enter("shift"), enter("accel,shift"), enter("alt")];
  const remove = ariaShortcut({
    keycode: AppConstants.platform === "macosx" ? "VK_BACK" : "VK_DELETE",
    modifiers: "shift",
  });
  try {
    const rows = await shownRows("mosaic");
    const option = row => row._content;
    const search = rows.find(
      r => r.result.type === UrlbarUtils.RESULT_TYPE.SEARCH
    );
    Assert.equal(
      option(search).getAttribute("aria-keyshortcuts"),
      opens.join(" ")
    );
    const opening = [
      "launcher-foot-new-tab",
      "launcher-foot-new-window",
      "launcher-foot-split",
    ];
    Assert.equal(
      option(search).getAttribute("aria-description"),
      meaningsOf(...opening),
      "a search's keys"
    );
    const history = rows.find(
      r => r.result.payload.url === "https://example.net/sval-mosaic"
    );
    Assert.equal(
      option(history).getAttribute("aria-keyshortcuts"),
      [...opens, remove].join(" ")
    );
    Assert.equal(
      option(history).getAttribute("aria-description"),
      meaningsOf(...opening, "launcher-foot-remove"),
      "a history page's keys"
    );

    const page = (await shownRows("example.org/sval-typed"))[0];
    Assert.equal(page.result.type, UrlbarUtils.RESULT_TYPE.URL, "a page");
    Assert.equal(
      option(page).getAttribute("aria-keyshortcuts"),
      opens.join(" ")
    );
    Assert.equal(
      option(page).getAttribute("aria-description"),
      meaningsOf(...opening),
      "a page's keys"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    await PlacesUtils.history.clear();
  }
});

/**
 * Among a command's choices Backspace and Escape both step back, so the line
 * says so, and Escape's Close shows only at the first list.
 */
add_task(async function a_choice_list_says_escape_steps_back() {
  await workAndHome();
  const rows = await shownRows("move this tab");
  const at = rows.findIndex(r => r.result.payload.commandId === "move-tab");
  UrlbarTestUtils.setSelectedRowIndex(window, at);
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-launcher-chip"),
    "the choices show"
  );
  await UrlbarTestUtils.promiseSearchComplete(window);
  const back = AppConstants.platform === "macosx" ? "⌫" : "Backspace";
  Assert.deepEqual(
    await footItems(),
    [`${back} Esc launcher-foot-back`],
    "Back, no Close"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !document.getElementById("sval-launcher-chip"),
    "Escape steps back"
  );
  await UrlbarTestUtils.promiseSearchComplete(window);
  Assert.equal(
    (await footItems()).at(-1),
    "Esc launcher-foot-close",
    "Close again"
  );
});
