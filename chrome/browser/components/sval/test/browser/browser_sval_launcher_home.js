/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */
/* import-globals-from sval_launcher_home_helpers.js */

/**
 * The home page's field shows the address bar's rows and picks them as the
 * address bar does (launcher spec §3): the same rows for the same text, in
 * the same sections under the same headings, open tabs of every workspace,
 * pins, Favorites and commands among them; a command runs from it, and a
 * command that picks lists its choices in it; Shift+Enter opens a new tab.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_launcher_home_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);
const { switcherItems } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

/**
 * What `sval/launcher.ftl` says for `id`, so a row is matched by the message
 * it shows.
 *
 * @param {string} id
 * @param {object} [options] `fluentText`'s.
 * @returns {string}
 */
function launcherText(id, options) {
  return fluentText("sval/launcher.ftl", id, options);
}

/**
 * A section's heading as `homeList` lists it.
 *
 * @param {string} id The heading's l10n id.
 * @returns {string}
 */
function heading(id) {
  return `## ${launcherText(id, { attribute: "label" })}`;
}

add_setup(failOnConsoleErrors);
add_setup(pinsSetup);
add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/**
 * Selects the row of command `id` in the page's list with the arrow keys.
 *
 * @param {object} browser
 * @param {string} id
 */
async function arrowToCommand(browser, id) {
  await SpecialPowers.spawn(browser, [id], commandId =>
    ContentTaskUtils.waitForCondition(
      () =>
        !!content.document.querySelector(
          `.suggestions [data-command-id="${commandId}"]`
        ),
      "the command is listed"
    )
  );
  for (let left = 30; left; left--) {
    const on = await SpecialPowers.spawn(
      browser,
      [],
      () =>
        content.document.querySelector(".suggestions [aria-selected='true']")
          ?.dataset.commandId ?? null
    );
    if (on === id) {
      return;
    }
    await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
  }
  Assert.ok(false, "the arrow keys reach the command's row");
}

/**
 * The same text in the address bar and in the field lists the same rows in
 * the same order, under the same headings: the search as the row Enter
 * takes, then the open tabs it matches strongly, pins and Favorites with
 * their marks, the command, and history.
 */
add_task(async function the_field_lists_the_address_bars_rows() {
  const { work } = pinsFixture;
  const monday = await treeTab(
    work,
    "Monday plan",
    "https://example.org/sval-monday"
  );
  const moonrise = await treeTab(
    work,
    "Moonrise notes",
    "https://example.org/sval-moonrise"
  );
  const pin = await pinFavorite(
    "https://example.com/sval-moon-pin",
    "Moon pin"
  );
  await untilPinShows(pin);
  await pinFavorite("https://example.com/sval-moon-star", "Moon star", {
    pin: false,
  });
  await PlacesTestUtils.addVisits([
    { uri: "https://example.net/sval-moth", title: "Moth page" },
  ]);
  atTaskEnd(() => PlacesUtils.history.clear());
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;

  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "mo" }),
    10_000,
    "the address bar's results"
  );
  const urlbar = await closeUrlbarWithItems();
  info(urlbar.join("\n"));
  Assert.ok(
    urlbar[0].startsWith("> | search | "),
    "the address bar's first row is the search, selected"
  );
  Assert.ok(
    urlbar[1] === heading("launcher-section-tabs") &&
      [monday, moonrise].includes(urlbar[2].split(" | ")[4]),
    "Open tabs follows it"
  );
  for (const id of [
    "launcher-section-tabs",
    "launcher-section-favorites",
    "launcher-section-commands",
    "launcher-section-history",
  ]) {
    Assert.ok(urlbar.includes(heading(id)), `the address bar shows ${id}`);
  }
  Assert.ok(
    urlbar.some(item => item.includes(" | move-tab | ")),
    "and Move this tab to…"
  );

  await typeInHomeField(browser, "mo");
  const home = await untilHomeLists(browser, urlbar);
  Assert.deepEqual(home.items, urlbar, "the field lists the same rows");

  const marks = await SpecialPowers.spawn(browser, [], () =>
    Object.fromEntries(
      [...content.document.querySelectorAll(".suggestions .result")]
        .filter(li => li.querySelector(".sval-mark"))
        .map(li => [
          li.querySelector(".title").textContent,
          li.querySelector(".sval-mark").dataset.mark,
        ])
    )
  );
  Assert.deepEqual(
    marks,
    { "Moon pin": "pin", "Moon star": "favorite" },
    "a pin wears its mark and a Favorite its star"
  );
  const page = await SpecialPowers.spawn(browser, [moonrise], id => {
    const doc = content.document;
    const row = doc.querySelector(`.suggestions [data-node-id="${id}"]`);
    const selected = doc.querySelector(
      ".suggestions .result[aria-selected='true']"
    );
    const foot = doc.querySelector(".suggestions-card .sval-launcher-foot");
    return {
      name: row.getAttribute("aria-label"),
      description: row.getAttribute("aria-description"),
      keyshortcuts: row.getAttribute("aria-keyshortcuts"),
      groups: [...doc.querySelectorAll(".suggestions > [role=group]")].map(
        group => [
          group.getAttribute("aria-label"),
          group.querySelectorAll("[role=option]").length,
        ]
      ),
      topRows: doc.querySelectorAll(".suggestions > [role=option]").length,
      hints: [...doc.querySelectorAll(".sval-launcher-hint")]
        .filter(hint => hint.checkVisibility())
        .map(hint => hint.closest(".result") === selected),
      // The hint's first child is its verb, before the key cap.
      hint: selected.querySelector(".sval-launcher-hint").firstElementChild
        .textContent,
      foot: [...foot.children].map(item => item.textContent),
      footHidden: foot.getAttribute("aria-hidden"),
    };
  });
  Assert.ok(
    page.name.includes("Moonrise notes") && page.name.includes("Work"),
    "an open tab's name says its workspace"
  );
  Assert.ok(
    page.description.includes("example.org/sval-moonrise") &&
      page.description.includes(launcherText("launcher-foot-split-with-tab")),
    "and its address and its key's meaning are its description"
  );
  Assert.ok(
    page.description.includes(launcherText("launcher-foot-new-window")),
    "and the new window's"
  );
  Assert.equal(
    page.keyshortcuts,
    "Shift+Enter Alt+Enter",
    "its keys, for a screen reader"
  );
  Assert.greater(page.topRows, 0, "the top area is in no group");
  const headings = urlbar
    .filter(item => item.startsWith("## "))
    .map(item => item.slice(3));
  Assert.deepEqual(
    page.groups.map(([name]) => name),
    headings,
    "each section is a group named by its heading"
  );
  Assert.ok(
    page.groups.every(([, rows]) => rows > 0),
    "holding its rows"
  );
  Assert.deepEqual(page.hints, [true], "only the selected row says Enter's");
  Assert.equal(
    page.hint,
    launcherText("launcher-hint-search"),
    "on the search, a search"
  );
  Assert.equal(page.footHidden, "true", "the rows say what the line says");
  Assert.ok(
    page.foot.at(-1).endsWith(launcherText("launcher-foot-close")),
    "the line ends with Escape's"
  );
});

/**
 * A click on the empty field lists the address bar's recent tabs, the same
 * tabs in the same order.
 */
add_task(async function an_empty_field_lists_the_same_recent_tabs() {
  const { work } = pinsFixture;
  await treeTab(work, "Monday plan", "https://example.org/sval-monday");
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;

  await within(
    UrlbarTestUtils.promisePopupOpen(window, () =>
      EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, {})
    ),
    10_000,
    "a click opens the address bar's view"
  );
  await UrlbarTestUtils.promiseSearchComplete(window);
  const urlbar = await closeUrlbarWithItems();
  Assert.equal(
    urlbar[0],
    heading("launcher-section-recent-tabs"),
    "the address bar lists them"
  );
  Assert.ok(
    urlbar.some(item => item.includes("Monday plan")),
    "with the other workspace's tab"
  );

  await BrowserTestUtils.synthesizeMouseAtCenter(".search input", {}, browser);
  const home = await untilHomeLists(browser, urlbar);
  Assert.deepEqual(home.items, urlbar, "the field lists the same tabs");
});

/** A command picked in the field runs, as it runs from the address bar. */
add_task(async function a_command_picked_in_the_field_runs() {
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;
  await typeInHomeField(browser, "mute");
  await arrowToCommand(browser, "mute");
  const key = await SpecialPowers.spawn(browser, [], () => {
    const row = content.document.querySelector(
      ".suggestions [data-command-id='mute']"
    );
    return {
      shown: row.querySelector(".key")?.textContent ?? null,
      aria: row.getAttribute("aria-keyshortcuts"),
    };
  });
  Assert.ok(key.shown, "the row shows the command's key");
  Assert.ok(key.aria, "and names it to a screen reader");
  atTaskEnd(() => {
    if (tab.muted) {
      tab.toggleMuteAudio();
    }
  });
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  await TestUtils.waitForCondition(() => tab.muted, "the tab is muted");
  Assert.ok((await homeList(browser)).hidden, "the list closed");
});

/**
 * A pick the page makes without the user, as a script of the page would,
 * runs nothing: the field acts only on a key or click the user just made.
 */
add_task(async function a_pick_without_the_user_runs_nothing() {
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;
  await typeInHomeField(browser, "mute");
  await arrowToCommand(browser, "mute");
  await SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    doc.clearUserGestureActivation();
    doc.querySelector(".search").requestSubmit();
    // The actor answers the page's requests in the order it makes them, so
    // once a later one is answered, the pick has been taken or dropped.
    const answered = ContentTaskUtils.waitForEvent(
      content,
      "SvalHomeSearchService",
      false,
      event => event.detail.type === "Placeholder"
    );
    content.dispatchEvent(
      new content.CustomEvent("SvalHomeSearch", {
        detail: Cu.cloneInto({ type: "Placeholder", data: null }, content),
      })
    );
    await answered;
  });
  Assert.ok(!tab.muted, "the command did not run");
});

/**
 * Move this tab to… lists the workspaces in the field: Enter keeps the list
 * open, the command shows as a chip and the field asks for a workspace;
 * Backspace in the empty field and Escape go back to the first list with
 * the command's row selected; Escape there closes the list; typing filters
 * and Enter moves the tab.
 */
add_task(async function move_this_tab_lists_its_choices_in_the_field() {
  const { home, work } = pinsFixture;
  const { tab, id } = await homeTab();
  const browser = tab.linkedBrowser;
  const placeholder = (await homeList(browser)).placeholder;

  const fresh = launcherText("launcher-choice-new-workspace");
  // The profile's own workspaces come before the two the setup added, and
  // the first that can be chosen is selected.
  const theirs = switcherItems(SvalPanel.nodes, home)
    .filter(item => !item.agent && ![home, work].includes(item.id))
    .map(item => SvalPanel.workspaceName(item));
  const choice = (name, selected) =>
    `${selected ? ">" : " "} | command | ${name} |  | move-tab | `;
  const choices = [
    heading("launcher-section-workspaces"),
    ...theirs.map((name, i) => choice(name, i === 0)),
    choice("Home", false),
    choice("Work", !theirs.length),
    `  | command | ${fresh} |  | move-tab | `,
  ];
  const moveTab = launcherText("launcher-command-move-tab");
  async function enterTheChoices() {
    await typeInHomeField(browser, "");
    await typeInHomeField(browser, "move");
    await arrowToCommand(browser, "move-tab");
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    const shown = await untilHomeLists(browser, choices);
    Assert.equal(shown.chip, moveTab, "the command is a chip");
    Assert.equal(shown.value, "", "the field is empty");
    Assert.equal(
      shown.placeholder,
      launcherText("launcher-choose-workspace", { attribute: "placeholder" }),
      "the field asks for a workspace"
    );
    const current = await SpecialPowers.spawn(browser, [], () => {
      const row = [
        ...content.document.querySelectorAll(".suggestions .result"),
      ].find(li => li.querySelector(".title").textContent === "Home");
      return {
        disabled: row.getAttribute("aria-disabled"),
        tag: row.querySelector(".tag")?.textContent,
      };
    });
    Assert.deepEqual(
      current,
      { disabled: "true", tag: launcherText("launcher-choice-current") },
      "this workspace is listed, not for choosing"
    );
  }
  async function untilBack(why) {
    await TestUtils.waitForCondition(async () => {
      const state = await homeList(browser);
      return (
        state.chip === null &&
        state.value === "move" &&
        state.items.some(item => item.startsWith(`> | command | ${moveTab} |`))
      );
    }, why);
    Assert.equal((await homeList(browser)).placeholder, placeholder);
  }

  await enterTheChoices();
  await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);
  await untilBack("Backspace in the empty field goes back");

  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  await untilHomeLists(browser, choices);
  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
  await untilBack("Escape goes back");
  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
  Assert.ok((await homeList(browser)).hidden, "Escape there closes the list");

  await enterTheChoices();
  await SpecialPowers.spawn(browser, [], () =>
    content.document.querySelector(".search input").setUserInput("wo")
  );
  const named = launcherText("launcher-choice-new-workspace-named", {
    args: { name: "wo" },
  });
  const titles = items =>
    items
      .filter(item => !item.startsWith("##"))
      .map(item => item.split(" | ")[2]);
  await TestUtils.waitForCondition(async () => {
    const shown = titles((await homeList(browser)).items);
    return (
      shown.at(-1) === named &&
      shown.includes("Work") &&
      !shown.includes("Home")
    );
  }, "typing filters the workspaces, and names the new one");
  for (let left = 10; left; left--) {
    const selected = (await homeList(browser)).items.find(item =>
      item.startsWith(">")
    );
    if (selected?.split(" | ")[2] === "Work") {
      break;
    }
    await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
  }
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  await TestUtils.waitForCondition(async () => {
    const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
    return nodes[id]?.placement.parent === work;
  }, "the tab moved to Work");
  // The move lets the tab go after the tree has it in Work, past a flush of
  // its page, and the task's end closes a tab still in the window.
  await TestUtils.waitForCondition(
    () => !gBrowser.visibleTabs.includes(tab),
    "the moved tab leaves what the window shows"
  );
  Assert.equal(SvalPanel.workspaceId, home, "the window stayed");
});

/**
 * Makes a request of the page's actor as a script of the page could, with or
 * without the user's activation, then waits until the actor has answered a
 * later request, so the first has been taken or dropped by then. A request
 * that takes the page away waits for nothing in it: the page and its actors
 * go with the load, and an answer sent to it may never come.
 *
 * @param {object} browser
 * @param {object} request `{ type, data }`.
 * @param {object} [options]
 * @param {boolean} [options.activated] Whether the user just used the page.
 * @param {boolean} [options.typeAsObject] Whether `type` is an object whose
 *   string is the name.
 * @param {boolean} [options.leaves] Whether the request loads another page
 *   in the tab.
 */
async function requestFromPage(
  browser,
  request,
  { activated = true, typeAsObject = false, leaves = false } = {}
) {
  await SpecialPowers.spawn(
    browser,
    [request, activated, typeAsObject, leaves],
    async ({ type, data }, userActivated, asObject, leaving) => {
      const doc = content.document;
      if (userActivated) {
        doc.notifyUserGestureActivation();
      } else {
        doc.clearUserGestureActivation();
      }
      const detail = Cu.cloneInto({ type, data }, content);
      if (asObject) {
        const named = Cu.createObjectIn(content);
        Cu.exportFunction(() => type, named, { defineAs: "toString" });
        Cu.waiveXrays(detail).type = named;
      }
      content.dispatchEvent(
        new content.CustomEvent("SvalHomeSearch", { detail })
      );
      if (leaving) {
        return;
      }
      const answered = ContentTaskUtils.waitForEvent(
        content,
        "SvalHomeSearchService",
        false,
        event => event.detail.type === "Placeholder"
      );
      content.dispatchEvent(
        new content.CustomEvent("SvalHomeSearch", {
          detail: Cu.cloneInto({ type: "Placeholder", data: null }, content),
        })
      );
      await answered;
    }
  );
}

/**
 * Only a pick the user makes, of a row of the latest query, on the tab the
 * window shows, opens anything, and it opens the text the field asked for:
 * a request named by an object, a pick of another query and a pick on a tab
 * in the background open nothing, and Enter with no row opens the latest
 * query's text whatever the pick says the field holds.
 */
add_task(async function only_the_users_pick_of_the_latest_rows_opens() {
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;
  await typeInHomeField(browser, PAGE);
  await TestUtils.waitForCondition(
    async () => !(await homeList(browser)).hidden,
    "the list shows"
  );
  const enter = id => ({
    type: "Pick",
    data: {
      id,
      list: 0,
      index: 0,
      searchString: "https://example.org/sval-not-this",
      modifiers: {},
    },
  });
  const stays = why => Assert.equal(browser.currentURI.spec, "about:home", why);

  await requestFromPage(browser, enter(-1), { typeAsObject: true });
  stays("a request named by an object opens nothing");
  await requestFromPage(browser, enter(999_999));
  stays("a pick of another query opens nothing");

  const other = gBrowser.tabs.find(t => t !== tab);
  await selectTab(other);
  await requestFromPage(browser, enter(-1));
  stays("a pick on a tab in the background opens nothing");

  await selectTab(tab);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, PAGE);
  await requestFromPage(browser, enter(-1), { leaves: true });
  await within(loaded, 10_000, "Enter with no row opens the field's text");
  Assert.equal(browser.currentURI.spec, PAGE, "the text the field asked for");
  Assert.equal(
    browser.browsingContext.sessionHistory.count,
    2,
    "and nothing else ever loaded in the tab"
  );
});

/**
 * Types `url` where the user would, on the home tab `browser` shows, and
 * presses Enter with `keys`.
 *
 * @param {string} where "home page field" or "address bar".
 * @param {object} browser
 * @param {string} url
 * @param {object} keys
 */
async function enterIn(where, browser, url, keys) {
  if (where === "address bar") {
    await within(
      UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: url }),
      10_000,
      "the address bar's results"
    );
    EventUtils.synthesizeKey("KEY_Enter", keys);
    return;
  }
  await typeInHomeField(browser, url);
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.querySelector(".suggestions [aria-selected=true]"),
      "the row Enter takes is listed"
    ).then(() => undefined)
  );
  await BrowserTestUtils.synthesizeKey("KEY_Enter", keys, browser);
}

/**
 * On a home tab, Shift+Enter opens the page in a new tab and the home tab
 * stays on Home, in the home page's field and in the address bar alike
 * (launcher spec §3); Enter alone loads the page in the home tab.
 */
add_task(async function shift_enter_on_home_opens_a_new_tab() {
  for (const where of ["home page field", "address bar"]) {
    const { tab } = await homeTab();
    const browser = tab.linkedBrowser;

    const opened = BrowserTestUtils.waitForNewTab(gBrowser, PAGE, true);
    await enterIn(where, browser, PAGE, { shiftKey: true });
    const newTab = await within(opened, 10_000, `${where}: a new tab`);
    Assert.notEqual(newTab, tab, `${where}: the page is in a new tab`);
    Assert.equal(
      browser.currentURI.spec,
      "about:home",
      `${where}: the home tab stays on Home`
    );
    BrowserTestUtils.removeTab(newTab);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );

    await selectTab(tab);
    const loaded = BrowserTestUtils.browserLoaded(browser, false, PAGE2);
    await enterIn(where, browser, PAGE2, {});
    await within(loaded, 10_000, `${where}: the home tab loads the page`);
    Assert.ok(gBrowser.tabs.includes(tab), `${where}: in the home tab`);
  }
});
