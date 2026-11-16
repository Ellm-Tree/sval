/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The workspace each visit was made in, as Places keeps it (decision 1287):
// the table, what removes its rows, and the queries a workspace scopes.

const { SvalVisitWorkspaces, TABLE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalVisitWorkspaces.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);

do_get_profile();

const WORK = "3c1d9e2a-77b0-4f15-a8c6-5e0d2b9f1a47";
const HOME = "8f0a5b6c-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
const NHQO = Ci.nsINavHistoryQueryOptions;

/**
 * Inserts one visit to each of `pages`, as sync does.
 *
 * @param {object[]} pages `{ url, at }`.
 */
async function insert(pages) {
  await PlacesUtils.history.insertMany(
    pages.map(({ url, at }) => ({
      url,
      title: url,
      visits: [
        {
          date: new Date(at),
          transition: PlacesUtils.history.TRANSITIONS.TYPED,
        },
      ],
    }))
  );
}

async function rowCount() {
  const db = await PlacesUtils.promiseDBConnection();
  const [row] = await db.execute(`SELECT count(*) AS n FROM ${TABLE}`);
  return row.getResultByName("n");
}

/**
 * The URLs a query lists: a flat one's pages, or a container query's
 * containers and, opened, their pages.
 *
 * @param {object} options The query's options.
 * @param {string|null} workspace
 * @returns {Array<string|object>}
 */
function list(options, workspace) {
  const query = PlacesUtils.history.getNewQuery();
  query.svalWorkspace = workspace;
  const root = PlacesUtils.history.executeQuery(query, options).root;
  root.containerOpen = true;
  const out = [];
  for (let i = 0; i < root.childCount; i++) {
    const node = root.getChild(i);
    if (PlacesUtils.nodeIsContainer(node)) {
      const folder = PlacesUtils.asContainer(node);
      folder.containerOpen = true;
      const pages = [];
      for (let j = 0; j < folder.childCount; j++) {
        pages.push(folder.getChild(j).uri);
      }
      folder.containerOpen = false;
      out.push({ title: node.title, uri: node.uri, pages: pages.sort() });
    } else {
      out.push(node.uri);
    }
  }
  root.containerOpen = false;
  return out;
}

add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(() => PlacesUtils.history.clear());
});

add_task(async function places_keeps_a_visits_workspace_until_the_visit_goes() {
  const at = Date.now() - 60_000;
  await insert([
    { url: "https://work.example/", at },
    { url: "https://home.example/", at },
  ]);
  await SvalVisitWorkspaces.record([
    { url: "https://work.example/", visitedAt: at, workspace: WORK },
    { url: "https://home.example/", visitedAt: at, workspace: HOME },
  ]);
  Assert.equal(await rowCount(), 2);
  Assert.equal(
    await SvalVisitWorkspaces.latestOf("https://work.example/"),
    WORK
  );

  // One a later record says was made in none takes none.
  await SvalVisitWorkspaces.record([
    { url: "https://home.example/", visitedAt: at, workspace: null },
  ]);
  Assert.equal(
    await SvalVisitWorkspaces.latestOf("https://home.example/"),
    null
  );

  await PlacesUtils.history.remove("https://work.example/");
  Assert.equal(await rowCount(), 0, "a removed visit takes its workspace");
  await PlacesUtils.history.clear();
});

add_task(async function a_workspace_lists_its_own_pages_and_those_of_none() {
  const at = Date.now() - 60_000;
  await insert([
    { url: "https://work.example/", at },
    { url: "https://home.example/", at: at + 1 },
    { url: "https://none.example/", at: at + 2 },
  ]);
  await SvalVisitWorkspaces.record([
    { url: "https://work.example/", visitedAt: at, workspace: WORK },
    { url: "https://home.example/", visitedAt: at + 1, workspace: HOME },
  ]);

  const byLastVisited = PlacesUtils.history.getNewQueryOptions();
  byLastVisited.sortingMode = NHQO.SORT_BY_DATE_DESCENDING;
  Assert.deepEqual(list(byLastVisited, WORK), [
    "https://none.example/",
    "https://work.example/",
  ]);
  Assert.deepEqual(list(byLastVisited, null), [
    "https://none.example/",
    "https://home.example/",
    "https://work.example/",
  ]);

  const byDay = PlacesUtils.history.getNewQueryOptions();
  byDay.resultType = NHQO.RESULTS_AS_DATE_QUERY;
  const [today] = list(byDay, HOME);
  Assert.deepEqual(today.pages, [
    "https://home.example/",
    "https://none.example/",
  ]);
  Assert.ok(today.uri.includes(`svalWorkspace=${HOME}`), today.uri);

  const bySite = PlacesUtils.history.getNewQueryOptions();
  bySite.resultType = NHQO.RESULTS_AS_SITE_QUERY;
  bySite.sortingMode = NHQO.SORT_BY_TITLE_ASCENDING;
  Assert.deepEqual(
    list(bySite, WORK).map(site => site.title),
    ["none.example", "work.example"],
    "a site with no visit in the workspace has no folder"
  );

  const query = PlacesUtils.history.getNewQuery();
  query.svalWorkspace = WORK;
  query.searchTerms = "example";
  const search = PlacesUtils.history.getNewQueryOptions();
  search.sortingMode = NHQO.SORT_BY_FRECENCY_DESCENDING;
  const found = PlacesUtils.history.executeQuery(query, search).root;
  found.containerOpen = true;
  const urls = [];
  for (let i = 0; i < found.childCount; i++) {
    urls.push(found.getChild(i).uri);
  }
  found.containerOpen = false;
  Assert.deepEqual(urls.sort(), [
    "https://none.example/",
    "https://work.example/",
  ]);
  await PlacesUtils.history.clear();
});

add_task(
  async function a_day_holding_only_another_workspaces_visits_is_hidden() {
    const at = Date.now() - 60_000;
    await insert([{ url: "https://home.example/", at }]);
    await SvalVisitWorkspaces.record([
      { url: "https://home.example/", visitedAt: at, workspace: HOME },
    ]);
    const byDay = PlacesUtils.history.getNewQueryOptions();
    byDay.resultType = NHQO.RESULTS_AS_DATE_QUERY;
    Assert.deepEqual(list(byDay, WORK), []);
    Assert.equal(list(byDay, HOME).length, 1);
    await PlacesUtils.history.clear();
  }
);

add_task(async function a_workspace_survives_a_place_uri() {
  const query = PlacesUtils.history.getNewQuery();
  query.svalWorkspace = WORK;
  const options = PlacesUtils.history.getNewQueryOptions();
  const text = PlacesUtils.history.queryToQueryString(query, options);
  Assert.ok(text.includes(`svalWorkspace=${WORK}`), text);
  const back = {};
  PlacesUtils.history.queryStringToQuery(text, back, {});
  Assert.equal(back.value.svalWorkspace, WORK);
  Assert.equal(
    PlacesUtils.history.getNewQuery().svalWorkspace,
    null,
    "a query names no workspace unless asked"
  );
});

add_task(async function an_imports_visits_take_its_workspace() {
  const at = Date.now() - 60_000;
  const inserted = await SvalVisitWorkspaces.whileImporting(
    WORK,
    async () => {
      await insert([
        { url: "https://imported.example/", at },
        { url: "https://synced.example/", at },
      ]);
      return 2;
    },
    url => url === "https://synced.example/"
  );
  Assert.equal(inserted, 2, "the import's answer");
  Assert.equal(
    await SvalVisitWorkspaces.latestOf("https://imported.example/"),
    WORK
  );
  Assert.equal(
    await SvalVisitWorkspaces.latestOf("https://synced.example/"),
    null,
    "a visit history sync inserted meanwhile is left to it"
  );
  await PlacesUtils.history.clear();
});
