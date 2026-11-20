/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Search keywords (spec §13 item 3): each engine Sval ships has a short `@`
 * keyword, so the keyword and a space in the Launcher put it in that
 * engine's search mode, Enter searches that engine, and an ordinary search
 * that starts with the same letters stays a search of the default engine.
 * The `@` list names each engine by its short keyword. Settings › Search
 * and Launcher lists each engine's keywords and sets one of the user's own,
 * with no `@`, which the Launcher follows. The site searches have no
 * suggestion address, so typing in their search mode asks no one anything
 * (spec §10.9).
 */

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);

/** Each engine's short keyword, by the engine's name. */
const KEYWORDS = {
  DuckDuckGo: "@ddg",
  Startpage: "@sp",
  "Brave Search": "@br",
  Kagi: "@kagi",
  Google: "@g",
  Bing: "@b",
  Ecosia: "@eco",
  Qwant: "@qw",
  Perplexity: "@pplx",
  "Wikipedia (en)": "@w",
  YouTube: "@yt",
  GitHub: "@gh",
  OpenStreetMap: "@maps",
};

/** The site searches Sval ships, by engine name, and each one's host. */
const SITES = {
  YouTube: "www.youtube.com",
  GitHub: "github.com",
  OpenStreetMap: "www.openstreetmap.org",
};

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
 * Records each request a site search makes until the task ends, and stops
 * it as it opens: the harness forbids reaching any host off this machine.
 *
 * @returns {string[]} the address of each request, in order.
 */
function siteRequests() {
  const seen = [];
  const hosts = new Set(Object.values(SITES));
  const observer = {
    observe(subject) {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (hosts.has(channel.URI.host)) {
        seen.push(channel.URI.spec);
        channel.cancel(Cr.NS_BINDING_ABORTED);
      }
    },
  };
  Services.obs.addObserver(observer, "http-on-opening-request");
  atTaskEnd(() =>
    Services.obs.removeObserver(observer, "http-on-opening-request")
  );
  return seen;
}

/** A page's tab in front, its content focused. */
async function pageTab() {
  await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a page's tab"
  );
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  gBrowser.selectedBrowser.focus();
}

/**
 * Floats the Launcher with its key and waits for its field's focus. The
 * list may stay closed: with nothing typed it lists only tabs used on this
 * device, and a task's tabs may have none.
 */
async function openLauncher() {
  const focused = BrowserTestUtils.waitForEvent(gURLBar.inputField, "focus");
  EventUtils.synthesizeKey("l", { accelKey: true });
  await within(focused, 10_000, "the Launcher's field");
}

/**
 * Types `text` into the Launcher a key at a time, as a person does, and
 * waits for the list to answer the last key.
 *
 * @param {string} text
 */
async function type(text) {
  for (const key of text) {
    const answered = UrlbarTestUtils.promiseSearchComplete(window);
    EventUtils.synthesizeKey(key === " " ? " " : key);
    await within(answered, 10_000, `the list answering "${key}"`);
  }
}

/**
 * The search mode chip, when it shows: the search button at the field's
 * start, with the engine's name (`SearchModeSwitcher`).
 *
 * @returns {Element|null} the chip's name.
 */
function chip() {
  const title = gURLBar.querySelector(".searchmode-switcher-title");
  return title?.checkVisibility() ? title : null;
}

/**
 * Asserts the Launcher is in `engineName`'s search mode, its chip naming
 * the engine and the field holding `query`.
 *
 * @param {string} engineName
 * @param {string} query
 */
async function assertSearchingWith(engineName, query) {
  await TestUtils.waitForCondition(
    () => gURLBar.searchMode?.engineName === engineName,
    `${engineName}'s search mode`
  );
  await TestUtils.waitForCondition(
    () => chip()?.textContent === engineName,
    "the chip shows the engine's name"
  );
  Assert.equal(gURLBar.value, query, "the field holds the query");
}

/**
 * Presses Enter and waits for the search's request.
 *
 * @param {string[]} seen {@link siteRequests}'s list.
 * @returns {Promise<URL>} the address searched.
 */
async function enterSearches(seen) {
  const before = seen.length;
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => seen.length > before,
    "the search's request"
  );
  return new URL(seen.at(-1));
}

add_task(async function every_engine_has_its_short_keyword() {
  const engines = await SearchService.getAppProvidedEngines();
  Assert.deepEqual(
    engines.map(engine => engine.name).sort(),
    Object.keys(KEYWORDS).sort(),
    "Sval ships these engines"
  );
  for (const engine of engines) {
    Assert.ok(
      engine.aliases.includes(KEYWORDS[engine.name]),
      `${engine.name} answers to ${KEYWORDS[engine.name]}`
    );
  }
  Assert.ok(
    SearchService.getEngineByName("Google").aliases.includes("@google"),
    "the long aliases stay"
  );
  for (const name of Object.keys(SITES)) {
    Assert.ok(
      !SearchService.getEngineByName(name).supportsResponseType(
        "application/x-suggestions+json"
      ),
      `${name} has no suggestion address`
    );
  }
});

add_task(async function at_yt_and_a_space_search_youtube() {
  await SpecialPowers.pushPrefEnv({
    // Sval's default, which the manifest turns off for every other file.
    set: [["browser.search.suggest.enabled", true]],
  });
  const seen = siteRequests();
  await pageTab();
  await openLauncher();

  await type("@yt ");
  await assertSearchingWith("YouTube", "");
  await type("cats");
  await assertSearchingWith("YouTube", "cats");
  Assert.deepEqual(seen, [], "typing asks YouTube nothing");

  const searched = await enterSearches(seen);
  Assert.equal(searched.host, "www.youtube.com", "Enter searches YouTube");
  Assert.equal(searched.pathname, "/results", "YouTube's results page");
  Assert.equal(searched.searchParams.get("search_query"), "cats");
  Assert.equal(seen.length, 1, "one request, the search");
});

add_task(async function a_keyword_typed_with_its_query_searches_too() {
  const seen = siteRequests();
  await pageTab();
  await openLauncher();
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "@gh sval",
    }),
    10_000,
    "the list for a pasted search"
  );
  await assertSearchingWith("GitHub", "sval");
  const searched = await enterSearches(seen);
  Assert.equal(searched.host, "github.com");
  Assert.equal(searched.searchParams.get("q"), "sval");
});

/**
 * What an `@` word picks, Space and Tab alike: an engine's whole keyword
 * picks that engine, and a part of one picks the first engine with a
 * keyword it begins.
 */
const AT_WORDS = [
  ["@k", "Kagi"],
  ["@b", "Bing"],
  ["@br", "Brave Search"],
  ["@yt", "YouTube"],
];

add_task(async function space_after_an_at_word_picks_what_tab_picks() {
  for (const [word, engineName] of AT_WORDS) {
    for (const key of ["Space", "Tab"]) {
      info(`${word} then ${key}`);
      await pageTab();
      await openLauncher();
      await type(word);
      EventUtils.synthesizeKey(key === "Space" ? " " : "KEY_Tab");
      await assertSearchingWith(engineName, "");
      gURLBar.searchMode = null;
      await UrlbarTestUtils.promisePopupClose(window);
      gURLBar.handleRevert();
    }
  }
});

add_task(async function the_home_fields_space_picks_the_same_engine() {
  const tab = await openPage("about:home");
  for (const [word, engineName] of AT_WORDS) {
    await SpecialPowers.spawn(tab.linkedBrowser, [word], value => {
      const input = content.document.querySelector(".search input");
      input.focus();
      input.setUserInput(`${value} `);
    });
    await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(tab.linkedBrowser, [], () => {
          const doc = content.document;
          return [
            doc.querySelector(".search.in-mode .engine-title")?.textContent,
            doc.querySelector(".search input").value,
          ];
        }).then(([chipName, value]) => chipName === engineName && value === ""),
      `the home field's engine button names ${engineName} after "${word} "`
    );
    Assert.equal(
      await SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () =>
          content.document.querySelector(".search.in-mode .engine-title")
            ?.textContent
      ),
      engineName,
      `"${word} " in the home field picks ${engineName}`
    );
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      const input = content.document.querySelector(".search input");
      input.focus();
      input.setUserInput("");
    });
    await BrowserTestUtils.synthesizeKey(
      "KEY_Backspace",
      {},
      tab.linkedBrowser
    );
    await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(
          tab.linkedBrowser,
          [],
          () => !content.document.querySelector(".search.in-mode")
        ),
      "Backspace leaves the mode"
    );
  }
});

add_task(async function space_after_an_at_word_no_engine_has_stays_a_space() {
  await pageTab();
  await openLauncher();
  await type("@zz ");
  Assert.equal(gURLBar.searchMode, null, "no engine's search mode");
  Assert.ok(!chip(), "no chip");
  Assert.equal(gURLBar.value, "@zz ", "the space stays in the field");
});

add_task(async function a_search_starting_with_a_keywords_letters_stays() {
  await pageTab();
  await openLauncher();
  await type("b vitamins");
  Assert.equal(gURLBar.searchMode, null, "no engine's search mode");
  Assert.ok(!chip(), "no chip");
  Assert.equal(gURLBar.value, "b vitamins", "the field holds the search");
});

add_task(async function an_at_sign_lists_each_engine_by_its_short_keyword() {
  await pageTab();
  await openLauncher();
  await type("@");
  const rows = new Map();
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const details = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    if (details.searchParams?.engine) {
      rows.set(details.searchParams.engine, details);
    }
  }
  for (const [name, keyword] of Object.entries(KEYWORDS)) {
    const row = rows.get(name);
    Assert.ok(row?.element.row.checkVisibility(), `${name} has a row`);
    Assert.equal(
      row?.result.payload.keyword,
      keyword,
      `${name}'s row names it by ${keyword}`
    );
    Assert.equal(
      row?.displayed.title.split(" ")[0].replace(",", ""),
      keyword,
      `${name}'s row shows ${keyword} first`
    );
  }
});

add_task(async function backspace_and_escape_leave_search_mode() {
  await pageTab();
  await openLauncher();
  await type("@maps ");
  await assertSearchingWith("OpenStreetMap", "");

  const left = UrlbarTestUtils.promiseSearchComplete(window);
  EventUtils.synthesizeKey("KEY_Backspace");
  await within(left, 10_000, "the list after Backspace");
  Assert.equal(gURLBar.searchMode, null, "Backspace leaves search mode");
  await TestUtils.waitForCondition(() => !chip(), "the chip goes");

  await type("@maps ");
  await assertSearchingWith("OpenStreetMap", "");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !gURLBar.searchMode,
    "Escape leaves search mode"
  );
  await TestUtils.waitForCondition(() => !chip(), "the chip goes");
});

add_task(async function a_keyword_set_in_settings_works_without_an_at() {
  const youtube = SearchService.getEngineByName("YouTube");
  atTaskEnd(() => {
    youtube.alias = "";
  });

  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#search"),
    15_000,
    "Settings › Search and Launcher"
  );
  const doc = tab.linkedBrowser.contentDocument;
  const row = await TestUtils.waitForCondition(
    () =>
      [...doc.querySelectorAll("#engineList moz-box-item")].find(
        item => item.label === "YouTube"
      ),
    "YouTube's row in the engine list"
  );
  Assert.ok(row.checkVisibility(), "the engine list shows");
  Assert.equal(
    row.description.split(", ")[0],
    "@yt",
    "the row shows YouTube's short keyword"
  );

  const settingsWin = tab.linkedBrowser.contentWindow;
  const opened = BrowserTestUtils.waitForEvent(
    settingsWin.gSubDialog._dialogStack,
    "dialogopen",
    false,
    event =>
      event.detail.dialog._frame.contentWindow.location.href ===
      "chrome://browser/content/search/addEngine.xhtml"
  );
  const edit = row.querySelector("moz-button");
  edit.scrollIntoView();
  EventUtils.synthesizeMouseAtCenter(edit, {}, settingsWin);
  const { detail } = await within(opened, 10_000, "the edit dialog");
  const dialogDoc = detail.dialog._frame.contentDocument;
  const field = dialogDoc.getElementById("engineAlias");
  Assert.equal(field.value, "", "no keyword of the user's yet");
  field.value = "tube";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  const accept = dialogDoc.getElementById("add-engine-dialog")._buttons.accept;
  await TestUtils.waitForCondition(
    () => !accept.disabled,
    "the keyword is accepted"
  );
  EventUtils.synthesizeMouseAtCenter(accept, {}, dialogDoc.defaultView);
  await TestUtils.waitForCondition(
    () => row.description.split(", ")[0] === "tube",
    "the row shows the new keyword"
  );
  BrowserTestUtils.removeTab(tab);

  const seen = siteRequests();
  await pageTab();
  await openLauncher();
  await type("tube ");
  await assertSearchingWith("YouTube", "");
  await type("cats");
  const searched = await enterSearches(seen);
  Assert.equal(searched.host, "www.youtube.com");
  Assert.equal(searched.searchParams.get("search_query"), "cats");
});
