/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval's home page (`chrome/browser/components/sval/home/`): what about:home,
 * about:newtab and about:privatebrowsing show, where a new tab's focus goes,
 * and that a tab showing the page is a real tab in its workspace.
 */

const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);
const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);
const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs"
);
SearchTestUtils.init(this);
const { ContentSearch } = ChromeUtils.importESModule(
  "resource:///actors/ContentSearchParent.sys.mjs"
);

/**
 * Resolves on the first turn of the event loop at which `condition` holds,
 * checking once a turn, so a step that spans turns is caught between them.
 *
 * @param {Function} condition
 * @param {string} what
 */
async function onTheTurn(condition, what) {
  await within(
    (async () => {
      while (!condition()) {
        await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
      }
    })(),
    10_000,
    what
  );
}

/* import-globals-from ../../sval-panel.js */

const HOME_URL = "chrome://browser/content/sval/home/";

/**
 * A workspace of the task's own in the window's document, shown by the
 * window's own switch, so the window's own observer files the tabs a task
 * opens there.
 *
 * @returns {Promise<object>} `{ engine, workspace, observer }`.
 */
async function shownWorkspace() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const { engine } = SvalPanel;
  const workspace = await engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  expectWorkspaceTabs();
  Assert.ok(
    await within(
      SvalWindowWorkspace.of(window).switchTo(workspace),
      10_000,
      "the switch to the task's workspace"
    ),
    "the window shows the task's workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the observer filing the switch's tabs"
  );
  return { engine, workspace, observer: SvalPanel.observer };
}

/**
 * Runs `action`, and resolves with the tab it opened once that tab is
 * selected and showing the home page.
 *
 * @param {Function} action Opens a new tab.
 * @param {DOMWindow} [win] The window it opens in.
 * @returns {Promise<object>} the tab.
 */
async function newTabFrom(action, win = window) {
  const before = new Set(win.gBrowser.tabs);
  await action();
  await TestUtils.waitForCondition(
    () => win.gBrowser.tabs.some(tab => !before.has(tab)),
    "a tab opened"
  );
  const tab = win.gBrowser.tabs.find(t => !before.has(t));
  await TestUtils.waitForCondition(
    () =>
      win.gBrowser.selectedTab === tab &&
      tab.linkedBrowser.currentURI.spec === win.BROWSER_NEW_TAB_URL,
    "the new tab is selected and shows the new-tab page"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => !!content.document.querySelector(".search input"),
      "the page is up"
    )
  );
  return tab;
}

/**
 * Asserts that the page in `tab` holds the keyboard focus, in its search
 * field, and the address bar does not.
 *
 * @param {object} tab A tab showing the home page.
 * @param {DOMWindow} [win] Its window.
 */
async function assertFocusInSearchField(tab, win = window) {
  await TestUtils.waitForCondition(
    () => win.document.activeElement === tab.linkedBrowser,
    "the page's browser has the focus"
  );
  Assert.notEqual(
    win.document.activeElement,
    win.gURLBar.inputField,
    "and the address bar does not"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(
      () =>
        content.document.activeElement ===
        content.document.querySelector(".search input"),
      "the page's search field has the focus"
    )
  );
}

async function fieldValue(tab) {
  return SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.document.querySelector(".search input").value
  );
}

add_task(async function new_tab_from_the_panel_is_selected_and_takes_typing() {
  const { engine, workspace } = await shownWorkspace();

  const tab = await newTabFrom(() => SvalPanel.run("addTab", null));
  await assertFocusInSearchField(tab);

  EventUtils.sendString("sval home");
  await TestUtils.waitForCondition(
    async () => (await fieldValue(tab)) === "sval home",
    "typing went into the page's search field"
  );
  is(gURLBar.value, "", "and none of it reached the address bar");

  await TestUtils.waitForCondition(() => taggedId(tab), "the tab was filed");
  const node = (await engine.tree()).nodes[taggedId(tab)];
  is(node?.kind, "tab", "as a tab node");
  is(node.placement.parent, workspace, "in the workspace");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function new_tab_from_the_keyboard_focuses_the_search_field() {
  await shownWorkspace();

  const tab = await newTabFrom(() =>
    EventUtils.synthesizeKey("t", { accelKey: true })
  );
  await assertFocusInSearchField(tab);

  EventUtils.sendString("k");
  await TestUtils.waitForCondition(
    async () => (await fieldValue(tab)) === "k",
    "typing went into the page's search field"
  );
  is(gURLBar.value, "", "and not into the address bar");

  BrowserTestUtils.removeTab(tab);
});

/**
 * The page holds the brand lockup and one search field, nothing else: no
 * shortcuts, no settings, no links. The field says what the Launcher finds,
 * with the Launcher's key in a cap (launcher spec §8), and shows the default
 * engine's icon.
 */
add_task(async function the_home_page_holds_only_the_search_field() {
  const { keyOf, shortcutText } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
  );
  const key = shortcutText(keyOf(document.getElementById("focusURLBar")));
  for (const url of ["about:home", "about:newtab"]) {
    const tab = await openPage(url);
    const [message] = await document.l10n.formatMessages([
      { id: "launcher-placeholder" },
    ]);
    const placeholder = message.attributes.find(
      a => a.name == "placeholder"
    ).value;
    const page = await SpecialPowers.spawn(
      tab.linkedBrowser,
      [placeholder],
      async expected => {
        const doc = content.document;
        const input = doc.querySelector(".search input");
        const cap = doc.querySelector(".search .launcher-key");
        await ContentTaskUtils.waitForCondition(
          () => input.placeholder === expected && !cap.hidden,
          "the field says what it finds"
        );
        const capText = cap.textContent;
        return {
          capText,
          capShown: cap.checkVisibility(),
          inputs: doc.querySelectorAll("input").length,
          links: doc.querySelectorAll("a").length,
          // The Favorites row and its switch are the page's other part
          // (browser_sval_home_favorites.js).
          text: [...doc.body.children]
            .filter(el => !el.matches(".fav-switch"))
            .map(el =>
              [...el.querySelectorAll(":scope > :not(.favorites)")]
                .map(child => child.textContent)
                .join("")
            )
            .join("")
            .replace(capText, "")
            .trim(),
          topSites: !!doc.querySelector(".top-sites, [class*='topsite']"),
          icon: doc.querySelector(".search .engine").hidden === false,
          card: doc.querySelector(".suggestions").checkVisibility(),
        };
      }
    );
    is(page.capText, key, `${url}: the cap names the Launcher's key`);
    ok(page.capShown, `${url}: the cap shows while the field is empty`);
    is(page.inputs, 1, `${url}: one field`);
    is(page.links, 0, `${url}: no links`);
    is(page.text, "", `${url}: no text beyond the field and the Favorites`);
    ok(!page.topSites, `${url}: no shortcuts`);
    ok(page.icon, `${url}: the engine's icon shows`);
    ok(!page.card, `${url}: no results card before anything is typed`);

    BrowserTestUtils.removeTab(tab);
  }
});

/**
 * Search suggestions are on by default, from the engine the user chose
 * (decision 0098); private windows keep Firefox's default of off.
 */
add_task(
  async function suggestions_are_on_by_default_outside_private_windows() {
    const defaults = Services.prefs.getDefaultBranch("");
    ok(
      defaults.getBoolPref("browser.search.suggest.enabled"),
      "suggestions are on by default"
    );
    ok(
      !defaults.getBoolPref("browser.search.suggest.enabled.private"),
      "and off by default in private windows"
    );
  }
);

/**
 * The page's list as the user sees it: group labels as `## label`, then each
 * row's kind, title and address, the selected one marked `>`.
 *
 * @param {object} browser
 * @returns {Promise<object>} `{ hidden, items, value }`.
 */
function homeList(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const list = doc.querySelector(".suggestions");
    return {
      hidden: list.hidden,
      value: doc.querySelector(".search input").value,
      // A section's heading leads its group of rows.
      items: [...list.querySelectorAll(".group, .result")].map(li =>
        li.classList.contains("group")
          ? `## ${li.textContent}`
          : [
              li.getAttribute("aria-selected") == "true" ? ">" : " ",
              li.dataset.kind,
              li.querySelector(".title").textContent,
              li.querySelector(".url")?.textContent ?? "",
            ].join(" ")
      ),
    };
  });
}

async function typeInHomeField(browser, text) {
  await SpecialPowers.spawn(browser, [text], async value => {
    const input = content.document.querySelector(".search input");
    await ContentTaskUtils.waitForCondition(
      () => !!input.placeholder,
      "the page is answered"
    );
    input.focus();
    input.setUserInput(value);
  });
}

/**
 * The address bar's rows, drawn the same way, for the same text.
 *
 * @param {string} text
 * @returns {Promise<string[]>}
 */
async function urlbarItems(text) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: text }),
    10_000,
    "the address bar's results"
  );
  return closeUrlbarWithItems();
}

/**
 * The open address bar view's rows, as {@link homeList} lists the page's;
 * then closes the view.
 *
 * @returns {Promise<string[]>}
 */
async function closeUrlbarWithItems() {
  const items = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { element, result } = await UrlbarTestUtils.getDetailsOfResultAt(
      window,
      i
    );
    const row = element.row;
    const label = row.getAttribute("label");
    if (label) {
      items.push(`## ${label}`);
    }
    const kinds = {
      [UrlbarUtils.RESULT_TYPE.SEARCH]: "search",
      [UrlbarUtils.RESULT_TYPE.TAB_SWITCH]: "tab",
    };
    const kind = kinds[result.type] ?? "url";
    items.push(
      [
        row.hasAttribute("selected") ? ">" : " ",
        kind,
        row.querySelector(".urlbarView-title").textContent,
        result.heuristic
          ? ""
          : (row.querySelector(".urlbarView-url")?.textContent ?? ""),
      ].join(" ")
    );
  }
  await within(
    UrlbarTestUtils.promisePopupClose(window),
    10_000,
    "the address bar's results closing"
  );
  gURLBar.handleRevert();
  return items;
}

/**
 * The field lists what the address bar lists for the same text, in the same
 * groups under the same labels, with the heuristic selected.
 */
add_task(async function the_field_lists_what_the_address_bar_lists() {
  await PlacesUtils.history.clear();
  await PlacesTestUtils.addVisits([
    { uri: "https://example.com/sval-weather", title: "Weather page" },
    { uri: "https://example.org/sval-weathervane", title: "A weathervane" },
  ]);
  registerCleanupFunction(() => PlacesUtils.history.clear());

  const tab = await openPage("about:home");
  // The address bar is asked first: it takes the focus, and the field closes
  // its list when it loses it. The page draws each chunk of results as the
  // providers send it, so its list is waited for until it is whole.
  const urlbar = await urlbarItems("weath");
  await typeInHomeField(tab.linkedBrowser, "weath");
  let home;
  await TestUtils.waitForCondition(async () => {
    home = await homeList(tab.linkedBrowser);
    return JSON.stringify(home.items) === JSON.stringify(urlbar);
  }, "the field lists every row the address bar does");
  Assert.deepEqual(home.items, urlbar, "the same rows as the address bar");
  ok(
    home.items.includes(
      `## ${fluentText("sval/launcher.ftl", "launcher-section-history", {
        attribute: "label",
      })}`
    ),
    "history sits under its own label"
  );
  ok(home.items[0].startsWith("> search weath"), "the heuristic is selected");

  BrowserTestUtils.removeTab(tab);
});

/**
 * A click on the empty field lists what a click on the empty address bar
 * lists: the recent tabs (launcher spec §5).
 */
add_task(async function a_click_lists_what_a_click_on_the_address_bar_lists() {
  const tab = await openPage("about:home");
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
    `## ${fluentText("sval/launcher.ftl", "launcher-section-recent-tabs", {
      attribute: "label",
    })}`,
    "the address bar lists recent tabs"
  );

  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => !!content.document.querySelector(".search input").placeholder,
      "the page is answered"
    )
  );
  ok((await homeList(browser)).hidden, "no list before the click");
  await BrowserTestUtils.synthesizeMouseAtCenter(".search input", {}, browser);
  let home;
  await TestUtils.waitForCondition(async () => {
    home = await homeList(browser);
    return JSON.stringify(home.items) === JSON.stringify(urlbar);
  }, "the field lists every row the address bar does");
  Assert.deepEqual(home.items, urlbar, "the same rows as the address bar");

  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
  ok((await homeList(browser)).hidden, "Escape closes the list");
  await BrowserTestUtils.synthesizeMouseAtCenter(".search input", {}, browser);
  await TestUtils.waitForCondition(
    async () => !(await homeList(browser)).hidden,
    "a click on the focused field opens it again"
  );

  BrowserTestUtils.removeTab(tab);
});

/**
 * The home page's sky has a glow round the mark and seven coloured stars,
 * and no horizon: a Workspace's colour washes over the sky, never into it
 * (`browser_sval_home_workspace.js`).
 */
add_task(async function the_sky_has_its_glow_and_stars() {
  const tab = await openPage("about:home");
  const seen = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    const glow = () =>
      content.getComputedStyle(doc.querySelector(".mark > .moon-glow"))
        .backgroundImage;
    await ContentTaskUtils.waitForCondition(
      () => glow() !== "none",
      "the glow is painted"
    );
    return {
      stars: doc.querySelectorAll(".sky-star").length,
      star: content.getComputedStyle(doc.querySelector(".sky-star")).boxShadow,
    };
  });
  Assert.equal(seen.stars, 7, "seven coloured stars are on the field");
  Assert.notEqual(seen.star, "none", "each with its halo");
  BrowserTestUtils.removeTab(tab);
});

/**
 * Enter opens what the address bar would, in the home page's own tab: an
 * address is visited and words are searched for. Arrows walk the rows into
 * the field, and Escape puts back what was typed. Each load takes the page
 * away, so each step opens a home page of its own.
 */
add_task(async function the_field_opens_what_the_address_bar_would() {
  await PlacesUtils.history.clear();
  await PlacesTestUtils.addVisits([
    { uri: "https://example.com/sval-weather", title: "Weather page" },
  ]);
  registerCleanupFunction(() => PlacesUtils.history.clear());
  // A default engine on the test server, so a search loads a page.
  await SearchTestUtils.installSearchExtension(
    {
      name: "Sval Home",
      search_url: "https://example.com/",
      search_url_get_params: "q={searchTerms}",
    },
    { setAsDefault: true }
  );
  const engine = await SearchService.getDefault();

  /**
   * Opens a home page, runs `act` in it, and resolves with the address the
   * tab loads, once it is loaded in that tab.
   *
   * @param {Function} act Called with the page's browser.
   * @returns {Promise<string>}
   */
  const loadsFrom = async act => {
    const tab = await openPage("about:home");
    const browser = tab.linkedBrowser;
    const count = gBrowser.tabs.length;
    const loaded = BrowserTestUtils.browserLoaded(
      browser,
      false,
      url => !url.startsWith("about:")
    );
    await act(browser);
    await within(loaded, 10_000, "the home page's tab loading");
    is(gBrowser.tabs.length, count, "in this tab");
    const url = browser.currentURI.spec;
    BrowserTestUtils.removeTab(tab);
    return url;
  };

  const visited = await loadsFrom(async browser => {
    await typeInHomeField(browser, "example.org");
    await TestUtils.waitForCondition(
      async () => !(await homeList(browser)).hidden,
      "the list shows"
    );
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  });
  is(Services.io.newURI(visited).host, "example.org", "an address is visited");

  const walked = await openPage("about:home");
  await typeInHomeField(walked.linkedBrowser, "weather page");
  await TestUtils.waitForCondition(
    async () => (await homeList(walked.linkedBrowser)).items.length > 1,
    "the history row shows"
  );
  await BrowserTestUtils.synthesizeKey(
    "KEY_ArrowDown",
    {},
    walked.linkedBrowser
  );
  let state = await homeList(walked.linkedBrowser);
  is(state.value, "https://example.com/sval-weather", "the row's address");
  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, walked.linkedBrowser);
  state = await homeList(walked.linkedBrowser);
  ok(state.hidden, "Escape closes the list");
  is(state.value, "weather page", "and puts back what was typed");
  BrowserTestUtils.removeTab(walked);

  const searched = await loadsFrom(async browser => {
    await typeInHomeField(browser, "sval weather words");
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  });
  is(
    searched,
    engine.getSubmission("sval weather words").uri.spec,
    "words are searched for with the default engine"
  );

  const clicked = await loadsFrom(async browser => {
    await typeInHomeField(browser, "weather page");
    await TestUtils.waitForCondition(
      async () => (await homeList(browser)).items.length > 1,
      "the history row shows"
    );
    await BrowserTestUtils.synthesizeMouseAtCenter(
      ".suggestions .result[data-kind=url]",
      {},
      browser
    );
  });
  is(clicked, "https://example.com/sval-weather", "a click opens the row");
});

/**
 * Pasted text is cleaned as the address bar cleans it: `javascript:` is
 * stripped, so a pasted script lands as words, not as an address.
 */
add_task(async function a_pasted_script_is_stripped() {
  const tab = await openPage("about:home");
  const browser = tab.linkedBrowser;
  await typeInHomeField(browser, "");
  SpecialPowers.clipboardCopyString("javascript:document.title='sval-ran'");
  await SpecialPowers.spawn(browser, [], () =>
    content.document.querySelector(".search input").focus()
  );
  EventUtils.synthesizeKey("v", { accelKey: true });
  await TestUtils.waitForCondition(
    async () => (await homeList(browser)).value === "document.title='sval-ran'",
    "the paste lands"
  );
  is(
    (await homeList(browser)).value,
    "document.title='sval-ran'",
    "without its javascript: scheme"
  );
  BrowserTestUtils.removeTab(tab);
});

/**
 * An answer to a query the field has moved past is dropped.
 */
add_task(async function a_late_answer_is_dropped() {
  const tab = await openPage("about:home");
  await typeInHomeField(tab.linkedBrowser, "late");
  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, tab.linkedBrowser);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.dispatchEvent(
      new content.CustomEvent("SvalHomeSearchService", {
        detail: Cu.cloneInto(
          {
            type: "Results",
            data: {
              id: 1,
              searchString: "late",
              rows: [
                {
                  index: 0,
                  kind: "search",
                  heuristic: true,
                  fill: "late",
                  title: "late",
                  titleHighlights: [],
                  url: "",
                  urlHighlights: [],
                  icon: null,
                  action: null,
                  label: null,
                },
              ],
            },
          },
          content
        ),
      })
    );
  });
  ok((await homeList(tab.linkedBrowser)).hidden, "the list stays closed");
  BrowserTestUtils.removeTab(tab);
});

/**
 * The window's startup tab showing the home page, in a workspace with nothing
 * to restore, is the workspace's tab. A bare `about:blank` is still not.
 * Each is a new window's first tab, there before the window's observer
 * attaches, opened on the page the window was asked for.
 */
add_task(async function a_home_tab_open_before_attach_is_filed() {
  const { handWorkspaceTo } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
  /**
   * A new window opened on `url` and handed an empty workspace, as the
   * switcher hands one (`handWorkspaceTo`), once its panel has started.
   *
   * @param {string} url
   * @returns {Promise<Window>}
   */
  const windowOn = async url => {
    await within(SvalPanel.started, 40_000, "the panel's startup");
    const workspace = await SvalPanel.engine.mutate({
      kind: "addWorkspace",
      name: "",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    const args = Cc["@mozilla.org/supports-string;1"].createInstance(
      Ci.nsISupportsString
    );
    args.data = url;
    const opening = BrowserTestUtils.waitForNewWindow();
    handWorkspaceTo(OpenBrowserWindow({ args }), workspace);
    const win = await within(opening, 15_000, "a window opening on a page");
    await within(win.SvalPanel.started, 20_000, "the window's startup");
    await within(
      win.SvalPanel.observer.settled(),
      10_000,
      "the window's observer settling"
    );
    return win;
  };

  const homeWin = await windowOn("about:home");
  const home = homeWin.gBrowser.tabs.find(
    tab => tab.linkedBrowser.currentURI.spec === "about:home"
  );
  ok(home, "the window opened on the home page");
  await TestUtils.waitForCondition(() => taggedId(home), "the tab was filed");
  const node = (await homeWin.SvalPanel.engine.tree()).nodes[taggedId(home)];
  is(node?.kind, "tab", "the home tab is a tab node");
  is(
    node.placement.parent,
    SvalWindowWorkspace.of(homeWin).id,
    "in the window's workspace"
  );
  is(node.content.url, "about:home", "for the home page");

  const blankWin = await windowOn("about:blank");
  const blank = blankWin.gBrowser.tabs.find(
    tab => tab.linkedBrowser.currentURI.spec === "about:blank"
  );
  ok(blank, "the second window opened on about:blank");
  is(taggedId(blank), null, "a bare about:blank is not filed");
});

/**
 * Every warning or error the console receives about the home page, its
 * search actor or the activity stream while `load` runs: script errors, and
 * the `console` calls of the page and of the actors that answer it. `load`
 * ends with a round trip to the page's process, which delivers the messages
 * the page logged before it.
 *
 * @param {Function} load Loads a page and waits on it.
 * @returns {Promise<string[]>} the messages.
 */
async function consoleWhile(load) {
  const seen = [];
  const about = where =>
    /about:(home|newtab|privatebrowsing)|sval\/home\/|ContentSearch|AboutNewTab|activity-stream|newtab/i.test(
      where
    );
  const listener = {
    observe(message) {
      if (!(message instanceof Ci.nsIScriptError)) {
        return;
      }
      if (message.flags & Ci.nsIScriptError.infoFlag) {
        return;
      }
      const where = `${message.sourceName} ${message.errorMessage}`;
      if (about(where)) {
        seen.push(where);
      }
    },
  };
  const consoleCall = message => {
    if (message.level !== "error" && message.level !== "warn") {
      return;
    }
    const where = `${message.filename} ${Array.from(
      message.arguments ?? [],
      String
    ).join(" ")}`;
    if (about(where)) {
      seen.push(where);
    }
  };
  const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
    Ci.nsIConsoleAPIStorage
  );
  Services.console.registerListener(listener);
  storage.addLogEventListener(
    consoleCall,
    Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
  );
  try {
    await load();
  } finally {
    Services.console.unregisterListener(listener);
    storage.removeLogEventListener(consoleCall);
  }
  return seen;
}

add_task(async function the_pages_log_nothing() {
  for (const url of ["about:home", "about:newtab"]) {
    const seen = await consoleWhile(async () => {
      const tab = await openPage(url);
      await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
        ContentTaskUtils.waitForCondition(
          () => !!content.document.querySelector(".search input")?.placeholder,
          "the page knows its engine"
        )
      );
      BrowserTestUtils.removeTab(tab);
    });
    Assert.deepEqual(seen, [], `${url} logged no warning or error`);
  }
});

/**
 * A home page closed while the browser is still answering it, as Sval closes
 * the startup tab's page once a restored workspace has tabs of its own, logs
 * nothing: the answer goes to a page that is gone, and is dropped.
 *
 * `ContentSearch` answers one question at a time (`_currentEventPromise`),
 * reading the engine's state over turns of its own, and no other page asks
 * it anything here: the new tab page is not preloaded. So the page is closed
 * on the turn its question is being answered. The page has loaded first, and
 * asks again as its script does on starting: closing a page still loading
 * has Gecko lay it out before its sheets arrive, which it logs.
 */
add_task(async function a_home_page_closed_while_answered_logs_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.newtab.preload", false]] });
  const idle = () =>
    !ContentSearch._currentEventPromise && !ContentSearch._eventQueue.length;
  const tab = await openPage("about:home");
  await TestUtils.waitForCondition(idle, "the browser answers nothing");
  const seen = await consoleWhile(async () => {
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.dispatchEvent(
        new content.CustomEvent("ContentSearchClient", {
          detail: Cu.cloneInto({ type: "GetEngine", data: null }, content),
        })
      );
    });
    await explained(
      onTheTurn(
        () => !!ContentSearch._currentEventPromise,
        "the page's question"
      ),
      () => loadState(tab.linkedBrowser)
    );
    BrowserTestUtils.removeTab(tab);
    await TestUtils.waitForCondition(idle, "the browser has answered");
  });
  Assert.deepEqual(seen, [], "nothing is logged");
});

/**
 * A home page left for another page while the browser answers it logs
 * nothing. The page's process tears it down after the answer is sent, so an
 * answer can reach the page's actor once its window is no longer the one
 * shown (`JSWindowActorChild.contentWindow` is null), and is dropped.
 *
 * The page is sent elsewhere on the turn its question is being answered, as
 * the task above closes it. Where the answer lands, before the page goes, in
 * that gap or after the actor, is the processes' to decide.
 */
add_task(async function a_home_page_left_while_answered_logs_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.newtab.preload", false]] });
  const url = "data:text/html,%3Ctitle%3ELeft%3C/title%3E";
  const idle = () =>
    !ContentSearch._currentEventPromise && !ContentSearch._eventQueue.length;
  await TestUtils.waitForCondition(idle, "the browser answers nothing");
  const seen = await consoleWhile(async () => {
    const tab = BrowserTestUtils.addTab(gBrowser, "about:home");
    await explained(
      onTheTurn(
        () => !!ContentSearch._currentEventPromise,
        "the page's question"
      ),
      () => loadState(tab.linkedBrowser)
    );
    const loaded = within(
      BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url),
      10_000,
      "the next page loading"
    );
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
    await loaded;
    await TestUtils.waitForCondition(idle, "the browser has answered");
    // The page's old process has one channel to the browser, so a round trip
    // through another home page there delivers what it logged first.
    const other = await openPage("about:home");
    Assert.equal(
      other.linkedBrowser.remoteType,
      "privilegedabout",
      "the other home page shares the old page's process"
    );
    await SpecialPowers.spawn(other.linkedBrowser, [], () => {});
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  });
  Assert.deepEqual(seen, [], "nothing is logged");
});

/**
 * The private page:the private palette, the field searching privately, and
 * nothing that links anywhere. Its window files it like any home tab.
 */
add_task(async function the_private_page_is_svals_and_links_nowhere() {
  let win;
  const seen = await consoleWhile(async () => {
    win = await within(
      BrowserTestUtils.openNewBrowserWindow({ private: true }),
      20_000,
      "the private window's opening"
    );
    await within(
      win.SvalPanel.started,
      10_000,
      "the private window's panel startup"
    );
    const browser = win.gBrowser.selectedBrowser;
    await pageReady(browser, "about:privatebrowsing");
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(
        () => !!content.document.querySelector(".search input")?.placeholder,
        "the field is answered"
      )
    );
  });
  Assert.deepEqual(seen, [], "the private page logged no warning or error");

  const browser = win.gBrowser.selectedBrowser;
  const page = await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    return {
      private: doc.documentElement.classList.contains("private"),
      links: doc.querySelectorAll("a").length,
      mozilla: /mozilla|firefox/i.test(doc.documentElement.outerHTML),
      note: doc.querySelector(".private-note")?.checkVisibility()
        ? doc.querySelector(".private-note").textContent.replace(/\s+/g, " ")
        : null,
      // The field's key cap, which the field holds.
      text: [...doc.body.querySelectorAll("main > :not(.private-note)")]
        .map(el => el.textContent)
        .join("")
        .replace(doc.querySelector(".launcher-key").textContent, "")
        .trim(),
      script: [...doc.scripts].map(s => s.src),
      glow: doc.querySelectorAll(".moon-glow, .sky-star").length,
      wordmark: doc.querySelectorAll(".brand img").length,
    };
  });
  ok(page.private, "in the private palette");
  is(page.glow, 0, "under a starfield with no glow or coloured stars");
  is(page.wordmark, 1, "and its mark stands alone, with no wordmark");
  is(page.links, 0, "with no links, so none to Mozilla's support site");
  ok(!page.mozilla, "and nothing naming Mozilla or Firefox");
  ok(page.note?.trim(), "and its note says the window is private");
  is(page.text, "", "and no text beyond the field and that line");
  Assert.deepEqual(page.script, [HOME_URL + "home.js"], "sval's page script");

  await TestUtils.waitForCondition(async () => {
    const nodes = (await win.SvalPanel.engine.tree()).nodes;
    return Object.values(nodes).some(
      n => n.kind === "tab" && n.content?.url === "about:privatebrowsing"
    );
  }, "the private page is a tab in the private workspace");

  const newTab = await newTabFrom(() => win.SvalPanel.run("addTab", null), win);
  await assertFocusInSearchField(newTab, win);

  await within(
    BrowserTestUtils.closeWindow(win),
    20_000,
    "the private window's closing"
  );
});
