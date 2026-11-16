/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Favorites in the address bar (favorites-native spec §5.2, §12): typing
 * finds a favorite by its name and by its address, with the star; `*` and
 * the Favorites search mode list only favorites; a favorite's origin fills
 * in though it was never visited; a visited favorite shows once; one found
 * through its history wears the star too; an open
 * one offers its tab; the Favorites setting hides them; and the home page's
 * field lists them as the address bar does.
 */

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

const MAIL = "https://example.com/sval-mailbox/inbox";
const NEVER = "https://sval-never.example.net/";
const DEEP = "https://sval-deep.example.net/reports/weekly";
const NEWS = "https://example.org/sval-paper";

let store;

add_setup(async function () {
  await PlacesUtils.history.clear();
  ({ store } = await favoritesFixture());
  await store.insertTree([
    { title: "Quokka Mail", url: MAIL },
    { title: "Never Seen", url: NEVER },
    { title: "Weekly Reports", url: DEEP },
    { title: "Morning Paper", url: NEWS },
    { title: "Bookmarklet", url: "javascript:void(0)" },
  ]);
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/**
 * Types `value` into the address bar and answers its rows.
 *
 * @param {string} value
 * @returns {Promise<object[]>} `{ url, source, type, providerName, title,
 *   heuristic, starred, element }` per row.
 */
async function rowsFor(value) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value }),
    10_000,
    "the address bar's results"
  );
  const rows = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { result, element } = await UrlbarTestUtils.getDetailsOfResultAt(
      window,
      i
    );
    rows.push({
      url: result.payload.url,
      source: result.source,
      type: result.type,
      providerName: result.providerName,
      title: result.payload.title,
      heuristic: result.heuristic,
      autofill: result.autofill,
      starred: element.row.getAttribute("type") === "bookmark",
    });
  }
  return rows;
}

async function close() {
  await within(
    UrlbarTestUtils.promisePopupClose(window),
    10_000,
    "the address bar's results closing"
  );
  gURLBar.handleRevert();
}

const favoriteRows = rows =>
  rows.filter(r => r.source === UrlbarUtils.RESULT_SOURCE.BOOKMARKS);

add_task(async function a_favorite_is_found_by_name_and_by_address() {
  for (const typed of ["quokka", "mail", "sval-mailbox"]) {
    const rows = await rowsFor(typed);
    const found = favoriteRows(rows).filter(r => r.url === MAIL);
    Assert.equal(found.length, 1, `"${typed}" offers the favorite once`);
    Assert.ok(found[0].starred, `"${typed}": its row wears the star`);
    await close();
  }
  // Within a word is not a match, as the address bar matches bookmarks.
  const rows = await rowsFor("uokka");
  Assert.ok(
    !favoriteRows(rows).some(r => r.url === MAIL),
    "a word's middle finds nothing"
  );
  await close();
});

add_task(async function every_word_has_to_match() {
  let rows = await rowsFor("quokka inbox");
  Assert.ok(
    favoriteRows(rows).some(r => r.url === MAIL),
    "one word in the name and one in the address"
  );
  await close();
  rows = await rowsFor("quokka paper");
  Assert.equal(favoriteRows(rows).length, 0, "no favorite has both");
  await close();
});

add_task(async function a_bookmarklet_is_not_offered() {
  const rows = await rowsFor("bookmarklet");
  Assert.ok(
    !rows.some(r => r.url?.startsWith("javascript:")),
    "the bookmarklet is left out"
  );
  await close();
});

add_task(async function the_star_restricts_to_favorites() {
  await PlacesTestUtils.addVisits([
    { uri: "https://example.com/sval-morning-history", title: "Morning walk" },
  ]);
  const rows = await rowsFor("* morning");
  Assert.deepEqual(
    rows.filter(r => !r.heuristic).map(r => r.url),
    [NEWS],
    "only the favorite, not the page in history"
  );
  Assert.ok(rows.find(r => r.url === NEWS).starred, "with its star");
  await close();
  await PlacesUtils.history.clear();
});

add_task(async function the_favorites_search_mode_lists_them() {
  const results = async () => {
    const out = [];
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      out.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).result);
    }
    return out;
  };
  // `*` and a space enter the Favorites search mode, with nothing typed.
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "* " }),
    10_000,
    "the address bar opening"
  );
  await UrlbarTestUtils.assertSearchMode(window, {
    source: UrlbarUtils.RESULT_SOURCE.BOOKMARKS,
    entry: "typed",
    restrictType: "symbol",
  });
  const all = await results();
  Assert.deepEqual(
    all.map(r => r.payload.url).sort(),
    [DEEP, MAIL, NEVER, NEWS].sort(),
    "empty, it lists every favorite but the bookmarklet"
  );
  Assert.ok(
    all.every(r => r.source === UrlbarUtils.RESULT_SOURCE.BOOKMARKS),
    "all of them as favorites"
  );

  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "weekly" }),
    10_000,
    "the results for what was typed"
  );
  Assert.deepEqual(
    (await results()).filter(r => !r.heuristic).map(r => r.payload.url),
    [DEEP],
    "typed, it lists the favorites that match"
  );
  await UrlbarTestUtils.exitSearchMode(window);
  await close();
});

add_task(async function a_never_visited_favorite_fills_in() {
  let rows = await rowsFor("sval-nev");
  Assert.equal(rows[0].providerName, "SvalFavoritesAutofill", "it fills in");
  Assert.equal(rows[0].url, NEVER, "the favorite's origin");
  Assert.equal(gURLBar.value, "sval-never.example.net/", "in the field");
  Assert.equal(gURLBar.selectionStart, "sval-nev".length, "what was typed");
  Assert.equal(gURLBar.selectionEnd, gURLBar.value.length, "and the rest");
  await close();

  rows = await rowsFor("sval-deep.example.net/rep");
  Assert.equal(rows[0].providerName, "SvalFavoritesAutofill", "an address");
  Assert.equal(
    gURLBar.value,
    "sval-deep.example.net/reports/",
    "fills to its next slash"
  );
  await close();
});

add_task(async function the_most_visited_favorite_fills_in() {
  const quiet = "https://sval-rank-quiet.example.net/";
  const busy = "https://sval-rank-busy.example.net/";
  const guids = await store.insertTree([
    { title: "Quiet", url: quiet },
    { title: "Busy", url: busy },
    // Visited most, but not what is typed.
    { title: "Elsewhere", url: "https://sval-elsewhere.example.net/" },
  ]);
  await PlacesTestUtils.addVisits(
    [busy, busy, busy, "https://sval-elsewhere.example.net/"].map(uri => ({
      uri,
      transition: PlacesUtils.history.TRANSITIONS.LINK,
    }))
  );
  // With history in the results, Firefox fills a visited page itself.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.suggest.history", false]],
  });
  try {
    for (const [typed, filled] of [
      ["sval-rank-", "sval-rank-busy.example.net/"],
      ["sval-rank-quiet.example.net/", "sval-rank-quiet.example.net/"],
    ]) {
      const rows = await rowsFor(typed);
      Assert.equal(gURLBar.value, filled, `${typed} fills ${filled}`);
      Assert.equal(
        rows[0].providerName,
        "SvalFavoritesAutofill",
        "from the favorites"
      );
      await close();
    }
  } finally {
    await SpecialPowers.popPrefEnv();
    for (const guid of guids) {
      await store.delete(guid);
    }
    await PlacesUtils.history.clear();
  }
});

add_task(async function firefoxs_own_autofill_wins_every_time() {
  const site = "https://sval-both.example.net";
  const [guid] = await store.insertTree([
    { title: "Both", url: `${site}/sval-fav/page` },
  ]);
  await PlacesTestUtils.addVisits([
    {
      uri: `${site}/sval-firefox/`,
      transition: PlacesUtils.history.TRANSITIONS.TYPED,
    },
  ]);
  // Sval's fill reaches the group after Firefox's, which the group keeps.
  for (let i = 0; i < 5; i++) {
    const rows = await rowsFor("sval-both.example.net/sval-f");
    Assert.equal(rows[0].providerName, "UrlbarProviderAutofill", "Firefox's");
    Assert.equal(
      gURLBar.value,
      "sval-both.example.net/sval-firefox/",
      "fills from history"
    );
    await close();
  }
  await store.delete(guid);
  await PlacesUtils.history.clear();
});

add_task(async function a_visited_favorite_shows_once() {
  await PlacesTestUtils.addVisits([{ uri: NEWS, title: "Morning Paper" }]);
  const rows = await rowsFor("paper");
  const news = rows.filter(r => r.url === NEWS && !r.heuristic);
  Assert.equal(news.length, 1, "one row for the page");
  Assert.equal(news[0].source, UrlbarUtils.RESULT_SOURCE.BOOKMARKS, "starred");
  await close();
  await PlacesUtils.history.clear();
});

add_task(async function a_favorite_found_in_history_wears_the_star() {
  // The favorite's name and address hold neither "glim" nor "glimmer", so
  // only the page's history offers it: for "glim" the adaptive history too,
  // which remembers the page picked for it.
  const page = "https://sval-picked.example.net/inbox";
  const [guid] = await store.insertTree([{ title: "My Mail", url: page }]);
  await PlacesTestUtils.addVisits([{ uri: page, title: "Glimmer Inbox" }]);
  await UrlbarUtils.addToInputHistory(page, "glim");
  for (const typed of ["glim", "glimmer"]) {
    const rows = await rowsFor(typed);
    const found = rows.filter(r => r.url === page && !r.heuristic);
    Assert.equal(found.length, 1, `"${typed}" offers the page once`);
    Assert.ok(found[0].starred, `"${typed}": with the star`);
    Assert.equal(found[0].title, "My Mail", `"${typed}": by its name`);
    await close();
  }
  await store.delete(guid);
  await PlacesUtils.history.clear();
});

add_task(async function an_open_favorite_offers_its_tab() {
  const page = ROOT + "sval_agent_page.html";
  const [guid] = await store.insertTree([{ title: "Agent page", url: page }]);
  const background = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, page),
    10_000,
    "the favorite's page opening"
  );
  // The tree has the tab's title, so the address alone matches and the row
  // is not the one Enter takes (launcher spec §5).
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    const rows = await rowsFor("sval_agent_page");
    const forPage = rows.filter(r => r.url === page && !r.heuristic);
    Assert.equal(forPage.length, 1, "one row for the open favorite");
    Assert.equal(
      forPage[0].type,
      UrlbarUtils.RESULT_TYPE.TAB_SWITCH,
      "and it switches to the tab"
    );
    await close();
  });
  BrowserTestUtils.removeTab(background);
  await store.delete(guid);
  await PlacesUtils.history.clear();
});

add_task(async function a_favorite_among_the_top_sites_wears_the_star() {
  const page = "https://sval-top.example.net/";
  const [guid] = await store.insertTree([{ title: "Top Pick", url: page }]);
  // Five visits make a page a top site (`TopSitesFeed`'s threshold).
  await PlacesTestUtils.addVisits(Array(6).fill({ uri: page, title: "Top" }));
  // Top sites come from a cache the newtab feed refreshes on its own tick;
  // the visits reach it here as they would at the next tick.
  const feed = AboutNewTab.activityStream.store.feeds.get(
    "feeds.system.topsites"
  );
  feed.frecentCache.expire();
  await feed.refresh({ broadcast: true });
  await TestUtils.waitForCondition(
    () => AboutNewTab.getTopSites().some(site => site?.url === page),
    "the page is a top site"
  );
  // With nothing typed the address bar lists the tree's other tabs in place
  // of the top sites (launcher spec §5), so the tree holds this window's tab
  // alone, whatever an earlier file left in the profile's document.
  const own = SvalPanel.observer.nodeIdFor(gBrowser.selectedTab);
  for (const [id, node] of Object.entries(SvalPanel.nodes)) {
    if (node?.kind === "tab" && id !== own) {
      await SvalPanel.engine.mutate({ kind: "remove", id, now: Date.now() });
    }
  }
  await SvalPanel.refresh();
  const rows = await rowsFor("");
  const found = rows.filter(r => r.url === page);
  Assert.equal(found.length, 1, "the top sites list it once");
  Assert.ok(found[0].starred, "with the star");
  await close();
  await store.delete(guid);
  await PlacesUtils.history.clear();
});

add_task(async function the_favorites_setting_hides_them() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.suggest.bookmark", false]],
  });
  let rows = await rowsFor("quokka");
  Assert.equal(favoriteRows(rows).length, 0, "no favorite is suggested");
  await close();
  rows = await rowsFor("sval-nev");
  Assert.notEqual(
    rows[0].providerName,
    "SvalFavoritesAutofill",
    "and none fills in"
  );
  await close();
  await SpecialPowers.popPrefEnv();
});

add_task(async function the_home_page_field_lists_them() {
  const tab = await openPage("about:home");
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const input = content.document.querySelector(".search input");
    await ContentTaskUtils.waitForCondition(
      () => !!input.placeholder,
      "the page is answered"
    );
    input.focus();
    input.setUserInput("quokka");
  });
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(tab.linkedBrowser, [], () =>
        [...content.document.querySelectorAll(".suggestions .title")].some(
          el => el.textContent === "Quokka Mail"
        )
      ),
    "the field lists the favorite"
  );
  BrowserTestUtils.removeTab(tab);
});
