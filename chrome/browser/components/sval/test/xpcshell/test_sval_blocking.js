/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The levels, Custom, the allowed domains and the list loader
// (protections spec §1.2 and §1.3, decision 0102).

do_get_profile();

const { SvalBlocking, LEVEL_PREF, CUSTOM_LIST_BRANCH } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
  );
const {
  ALLOWED_DOMAIN_BRANCH,
  BLOCKING_TOPIC,
  SvalBlockingLists,
  ENGINE_LISTS_PREF,
  FIRST_PARTIES_ID,
  listUrlPref,
  preprocessList,
  removeparamRules,
  TRACKER_LISTS_PREF,
  TRACKER_TAG_LISTS_PREF,
  USER_LIST_BRANCH,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);

/**
 * Stores a list the user added as settings sync applies one from another
 * device.
 *
 * @param {object} entry `{url, category}`.
 * @returns {string} The list's id.
 */
function userListArrives(entry) {
  const id = SvalBlockingLists.userListId(entry.url);
  Services.prefs.setStringPref(USER_LIST_BRANCH + id, JSON.stringify(entry));
  return id;
}

const { FIRST_PARTIES_URL_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTrackerOwners.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

const ENGINES = "privacy.trackingprotection.content.protection.engines";
const TAG_ENGINES = "privacy.trackingprotection.content.annotation.engines";

/**
 * @param {string} name A comma-separated pref.
 * @returns {string[]} Its entries.
 */
function listPref(name) {
  return Services.prefs.getStringPref(name, "").split(",").filter(Boolean);
}
const DAY = 24 * 60 * 60 * 1000;

/** @returns {string[]} Every list either blocking engine runs, once each. */
function blockingLists() {
  return [...new Set([...engineLists(), ...listPref(TRACKER_LISTS_PREF)])];
}

function engineLists() {
  return Services.prefs
    .getStringPref(ENGINE_LISTS_PREF, "")
    .split(",")
    .filter(Boolean);
}

const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

const server = new HttpServer();
server.start(-1);
const ORIGIN = `http://localhost:${server.identity.primaryPort}`;

/**
 * Publishes `responses` in turn from the local server at the address of list
 * `id`, which `listUrlPref` gives it, and at every path beside it, as an
 * include's. A response is `{body, status, headers}`.
 *
 * @param {string} id A curated list's id, or `FIRST_PARTIES_ID`.
 * @param {object[]} responses
 * @returns {object[]} each request, `{url, headers}`, as it arrives.
 */
function publish(id, responses) {
  const requests = [];
  server.registerPrefixHandler(`/${id}/`, (request, response) => {
    const headers = {};
    for (const name of ["If-None-Match", "If-Modified-Since"]) {
      if (request.hasHeader(name)) {
        headers[name] = request.getHeader(name);
      }
    }
    requests.push({ url: `${ORIGIN}${request.path}`, headers });
    const next = responses.shift() ?? { status: 404 };
    response.setStatusLine(request.httpVersion, next.status ?? 200, "");
    for (const [name, value] of Object.entries(next.headers ?? {})) {
      response.setHeader(name, value, false);
    }
    response.write(next.body ?? "");
  });
  Services.prefs.setStringPref(
    id == FIRST_PARTIES_ID ? FIRST_PARTIES_URL_PREF : listUrlPref(id),
    `${ORIGIN}/${id}/list.txt`
  );
  return requests;
}

async function reset() {
  SvalBlockingLists.resetForTesting();
  await IOUtils.remove(SvalBlockingLists.dir, {
    recursive: true,
    ignoreAbsent: true,
  });
  for (const pref of [
    LEVEL_PREF,
    "browser.sval.adblock.customFrom",
    "browser.sval.adblock.userListsConfirmed",
    ENGINE_LISTS_PREF,
    TRACKER_LISTS_PREF,
    TRACKER_TAG_LISTS_PREF,
    FIRST_PARTIES_URL_PREF,
    ...[
      CUSTOM_LIST_BRANCH,
      USER_LIST_BRANCH,
      ALLOWED_DOMAIN_BRANCH,
      "browser.sval.adblock.list.",
    ].flatMap(branch => Services.prefs.getChildList(branch)),
  ]) {
    Services.prefs.clearUserPref(pref);
  }
}

add_setup(() => {
  registerCleanupFunction(reset);
  registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
});

add_task(async function levels_load_their_lists() {
  await reset();
  SvalBlocking.setLevel("balanced");
  const balanced = engineLists();
  Assert.ok(balanced.includes("sval-easylist"), "Balanced has EasyList");
  Assert.ok(balanced.includes("sval-ublock-filters"), "and uBlock filters");
  Assert.ok(!balanced.includes("sval-hagezi-pro-mini"), "but not HaGeZi");
  Assert.ok(
    Services.prefs.getStringPref(ENGINES).split(",").includes("ads"),
    "the ads feature blocks"
  );

  SvalBlocking.setLevel("strict");
  const strict = engineLists();
  Assert.ok(
    balanced.every(id => strict.includes(id)),
    "Strict keeps Balanced"
  );
  Assert.ok(strict.includes("sval-hagezi-pro-mini"), "and adds HaGeZi");

  SvalBlocking.setLevel("off");
  Assert.deepEqual(engineLists(), [], "Off uses no lists");
  const engines = Services.prefs.getStringPref(ENGINES).split(",");
  Assert.ok(!engines.includes("ads"), "the ads feature is out");
  Assert.equal(
    engines.at(-1),
    "allowed-domains",
    "the allowed domains come last"
  );
});

/**
 * The level's lists run as two engines by category, each with the fixes, and
 * the tracker lists tag requests with the owners' exceptions; none of
 * Mozilla's Disconnect-backed features runs (decision 1051).
 */
add_task(async function tracker_lists_block_and_tag_apart_from_the_ads() {
  await reset();
  SvalBlocking.setLevel("balanced");
  const fixes = [
    "sval-ublock-unbreak",
    "sval-ublock-quick-fixes",
    "sval-brave-unbreak",
  ];
  const trackers = listPref(TRACKER_LISTS_PREF);
  Assert.ok(
    trackers.includes("sval-easyprivacy"),
    "EasyPrivacy blocks as a tracker list"
  );
  Assert.ok(
    trackers.includes("sval-ublock-privacy"),
    "and uBlock's privacy list"
  );
  Assert.ok(!trackers.includes("sval-easylist"), "EasyList is not one");
  Assert.ok(
    !engineLists().includes("sval-easyprivacy"),
    "the ads engine runs no tracker list"
  );
  for (const id of fixes) {
    Assert.ok(
      trackers.includes(id) && engineLists().includes(id),
      `${id} reaches both engines`
    );
  }
  Assert.deepEqual(listPref(ENGINES), ["trackers", "ads", "allowed-domains"]);
  Assert.deepEqual(
    listPref(TAG_ENGINES),
    ["trackers-content", "allowed-domains"],
    "only the tag feature annotates"
  );
  const tag = listPref(TRACKER_TAG_LISTS_PREF);
  Assert.ok(
    tag.includes("sval-easyprivacy") && tag.includes("sval-tracker-owners"),
    "the tag runs the tracker lists with the owners' exceptions"
  );
  Assert.ok(!tag.includes("sval-easylist"), "and no ad list");

  SvalBlocking.setLevel("off");
  Assert.deepEqual(listPref(TRACKER_LISTS_PREF), [], "Off blocks no trackers");
  Assert.deepEqual(listPref(TAG_ENGINES), [], "and tags none");
  Assert.deepEqual(listPref(ENGINES), ["allowed-domains"]);
});

/**
 * The owners' exceptions are built from the tracker lists Sval has, and a
 * tracker list that changes rebuilds them.
 */
add_task(async function the_owners_exceptions_follow_the_tracker_lists() {
  await reset();
  publish("sval-easyprivacy", [
    {
      body: "||google-analytics.com^$third-party\n||nobody-owns-this.example^\n",
    },
  ]);
  SvalBlocking.setLevel("balanced");
  const changed = [];
  SvalBlockingLists.attach({
    onListsChanged: ids => changed.push(...ids),
  });
  registerCleanupFunction(() => SvalBlockingLists.detach());
  await SvalBlockingLists.update("sval-easyprivacy");
  Assert.ok(
    changed.includes("sval-tracker-owners"),
    "a tracker list's change rebuilds the owners' exceptions"
  );
  const rules = new TextDecoder()
    .decode(await SvalBlockingLists.getListBytes("sval-tracker-owners"))
    .split("\n");
  const analytics = rules.find(rule =>
    rule.startsWith("@@||google-analytics.com^$domain=")
  );
  Assert.ok(analytics, "Google Analytics is excepted on its owner's sites");
  Assert.ok(
    analytics.split("=")[1].split("|").includes("youtube.com"),
    "YouTube among them"
  );
  Assert.ok(
    !rules.some(rule => rule.includes("nobody-owns-this.example")),
    "a tracker no group owns gets no exception"
  );
});

add_task(function regional_list_follows_the_language() {
  Assert.deepEqual(SvalBlockingLists.regionalFor("de-DE"), ["sval-region-deu"]);
  Assert.deepEqual(SvalBlockingLists.regionalFor("pt-BR"), ["sval-region-por"]);
  Assert.deepEqual(
    SvalBlockingLists.regionalFor("es-ES"),
    ["sval-region-spa", "sval-region-por"],
    "every list for the language, as uBlock Origin enables"
  );
  Assert.deepEqual(SvalBlockingLists.regionalFor("en-US"), []);
});

add_task(async function an_edit_switches_to_custom_from_the_level() {
  await reset();
  SvalBlocking.setLevel("balanced");
  const balanced = SvalBlocking.listsForLevel("balanced");
  const { switchedFrom } = SvalBlocking.setListEnabled("sval-easylist", false);
  SvalBlocking.flush();
  Assert.equal(switchedFrom, "balanced");
  Assert.equal(SvalBlocking.level, "custom");
  Assert.deepEqual(
    blockingLists().toSorted(),
    balanced.filter(id => id != "sval-easylist").toSorted(),
    "Custom starts from Balanced's lists"
  );

  const added = SvalBlocking.addList(
    "https://lists.example.com/mine.txt",
    "ads"
  );
  SvalBlocking.flush();
  Assert.equal(added.switchedFrom, null, "already Custom");
  Assert.ok(added.id.startsWith("sval-user-"));
  Assert.ok(engineLists().includes(added.id), "an added list is on");
  Assert.throws(
    () => SvalBlocking.addList("http://lists.example/x.txt", "ads"),
    /not-https/
  );

  SvalBlocking.setLevel("strict");
  Assert.equal(SvalBlocking.level, "strict", "a curated level replaces Custom");
  Assert.deepEqual(
    blockingLists().toSorted(),
    SvalBlocking.listsForLevel("strict").toSorted()
  );
});

add_task(async function allowed_domains_become_exceptions() {
  await reset();
  Assert.equal(
    SvalBlocking.addAllowedDomain("https://Shop.Example.com/page"),
    "shop.example.com"
  );
  Assert.throws(() => SvalBlocking.addAllowedDomain("not a domain"), /invalid/);
  const bytes = await SvalBlockingLists.getListBytes("sval-allowed-domains");
  Assert.equal(
    new TextDecoder().decode(bytes),
    "@@||shop.example.com^$important"
  );
  SvalBlocking.removeAllowedDomain("shop.example.com");
  Assert.deepEqual(SvalBlocking.allowedDomains(), []);
});

add_task(async function a_failed_download_keeps_the_last_good_copy() {
  await reset();
  SvalBlocking.setLevel("balanced");
  const requests = publish("sval-easylist", [
    {
      body: "! Title: Test list\n! Expires: 2 days\n||ads.example^\n",
      headers: {
        ETag: '"v1"',
        "Last-Modified": "Mon, 12 Oct 2026 00:00:00 GMT",
      },
    },
    { status: 503 },
    { status: 304 },
  ]);
  Assert.ok(await SvalBlockingLists.update("sval-easylist"), "downloaded");
  let status = SvalBlockingLists.status("sval-easylist");
  Assert.equal(status.state, "ok");
  Assert.equal(status.title, "Test list", "the name is the list's Title");

  Assert.ok(!(await SvalBlockingLists.update("sval-easylist")), "it failed");
  status = SvalBlockingLists.status("sval-easylist");
  Assert.equal(status.state, "stale", "the copy is kept, and shown as old");
  Assert.equal(
    new TextDecoder().decode(
      await SvalBlockingLists.getListBytes("sval-easylist")
    ),
    "! Title: Test list\n! Expires: 2 days\n||ads.example^\n",
    "the engine still gets the last good copy"
  );

  await SvalBlockingLists.update("sval-easylist");
  Assert.equal(requests[2].headers["If-None-Match"], '"v1"', "conditional");
  Assert.equal(
    requests[2].headers["If-Modified-Since"],
    "Mon, 12 Oct 2026 00:00:00 GMT"
  );
  Assert.equal(SvalBlockingLists.status("sval-easylist").state, "ok");

  await Assert.rejects(
    SvalBlockingLists.getListBytes("sval-easyprivacy"),
    /not downloaded/,
    "a list never downloaded is skipped"
  );
});

add_task(async function a_list_is_fetched_again_only_once_it_expires() {
  await reset();
  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  Assert.deepEqual(
    SvalBlockingLists.enabledIds(),
    ["sval-easylist"],
    "the engine uses the one list"
  );
  const requests = publish("sval-easylist", [
    { body: "! Expires: 4 days\n||ads.example^\n", headers: { ETag: '"v1"' } },
    { status: 304 },
  ]);
  await SvalBlockingLists.update("sval-easylist");
  Assert.equal(requests.length, 1);

  // A later launch reads the cache, finds the list fresh, and schedules it
  // for when it expires.
  Services.prefs.setBoolPref("browser.sval.adblock.updates.enabled", true);
  try {
    SvalBlockingLists.resetForTesting();
    await SvalBlockingLists.start();
    Assert.greater(
      SvalBlockingLists.nextDue,
      Date.now() + 3 * DAY,
      "a fresh copy is due once it expires"
    );
    Assert.equal(requests.length, 1, "and nothing is fetched at start");

    // Five days on, the state file says the copy has expired.
    SvalBlockingLists.stop();
    const statePath = PathUtils.join(SvalBlockingLists.dir, "lists.json");
    const state = await IOUtils.readJSON(statePath);
    const now = Date.now();
    Object.assign(state["sval-easylist"], {
      fetchedAt: now - 5 * DAY,
      expiresAt: now - DAY,
    });
    await IOUtils.writeJSON(statePath, state);
    SvalBlockingLists.resetForTesting();
    await SvalBlockingLists.start();
    Assert.equal(
      SvalBlockingLists.status("sval-easylist").ageDays,
      5,
      "the copy is five days old"
    );
    Assert.less(
      SvalBlockingLists.nextDue,
      Date.now() + 11 * 60 * 1000,
      "and due within minutes of the launch"
    );
  } finally {
    SvalBlockingLists.stop();
    Services.prefs.clearUserPref("browser.sval.adblock.updates.enabled");
  }
  await SvalBlockingLists.update("sval-easylist");
  Assert.equal(requests.length, 2, "the expired list is fetched again");
  Assert.equal(requests[1].headers["If-None-Match"], '"v1"', "conditionally");
});

/**
 * A damaged state file is not read as empty and then written over: it is
 * kept beside the new one as `.corrupt`, and the lists start over, fetched
 * afresh.
 */
add_task(async function a_damaged_state_file_is_kept_aside() {
  await reset();
  await IOUtils.makeDirectory(SvalBlockingLists.dir, { ignoreExisting: true });
  const statePath = PathUtils.join(SvalBlockingLists.dir, "lists.json");
  await IOUtils.writeUTF8(statePath, '{"sval-easylist": {"etag": ');
  const damaged = await IOUtils.read(statePath);

  const requests = publish("sval-easylist", [{ body: "||ads.example^\n" }]);
  Assert.ok(
    await SvalBlockingLists.update("sval-easylist"),
    "the list is fetched afresh"
  );
  Assert.equal(requests.length, 1);

  const aside = (await IOUtils.getChildren(SvalBlockingLists.dir)).filter(
    child => PathUtils.filename(child).startsWith("lists.json.corrupt")
  );
  Assert.equal(aside.length, 1, "the damaged file was moved aside");
  Assert.deepEqual(
    Array.from(await IOUtils.read(aside[0])),
    Array.from(damaged),
    "exactly as it was"
  );
  Assert.ok(
    (await IOUtils.readJSON(statePath))["sval-easylist"].fetchedAt,
    "and the new state file is valid and records the download"
  );
});

add_task(async function includes_beside_the_list_are_inlined() {
  await reset();
  const requests = publish("sval-fanboy-annoyance", [
    { body: "! Title: Parts\n!#include part.txt\n||a.example^" },
    { body: "||b.example^" },
  ]);
  Assert.ok(await SvalBlockingLists.update("sval-fanboy-annoyance"));
  Assert.equal(
    requests[1].url,
    `${ORIGIN}/sval-fanboy-annoyance/part.txt`,
    "the include is fetched beside the list"
  );
  Assert.equal(
    new TextDecoder().decode(
      await SvalBlockingLists.getListBytes("sval-fanboy-annoyance")
    ),
    "! Title: Parts\n||b.example^\n||a.example^"
  );
});

add_task(async function allowed_domains_cannot_carry_filter_syntax() {
  await reset();
  // As if they arrived through sync, past the settings page's checks.
  for (const domain of [
    "good.example.com",
    "evil.com^$important",
    "a.com\n||tracker.example^",
    "two words.com",
    "com",
    "1.2.3.4",
    "x.com/path",
  ]) {
    Services.prefs.setBoolPref(ALLOWED_DOMAIN_BRANCH + domain, true);
  }
  Services.prefs.setStringPref(ALLOWED_DOMAIN_BRANCH + "other.example", "yes");
  Assert.equal(
    new TextDecoder().decode(
      await SvalBlockingLists.getListBytes("sval-allowed-domains")
    ),
    "@@||good.example.com^$important",
    "only the hostname becomes a rule"
  );
  Assert.deepEqual(SvalBlocking.allowedDomains(), ["good.example.com"]);
  for (const bad of ["evil.com^", "a.com|b", "*.com", "co.uk", "a,b.com"]) {
    Assert.throws(() => SvalBlocking.addAllowedDomain(bad), /invalid/, bad);
  }
  Assert.equal(SvalBlocking.addAllowedDomain("BÜCHER.de"), "xn--bcher-kva.de");
});

add_task(async function a_list_address_must_be_a_public_https_host() {
  await reset();
  for (const bad of [
    "https://user:pw@lists.example.com/l.txt",
    "https://127.0.0.1/l.txt",
    "https://10.0.0.1/l.txt",
    "https://[::1]/l.txt",
    "https://localhost/l.txt",
    "https://router.local/l.txt",
    "https://intranet/l.txt",
  ]) {
    Assert.throws(() => SvalBlocking.addList(bad, "ads"), /invalid/, bad);
  }
  Assert.throws(
    () => SvalBlocking.addList("http://lists.example.com/l.txt", "ads"),
    /not-https/
  );
});

add_task(async function a_user_list_on_a_curated_host_stays_a_user_list() {
  await reset();
  const { id } = SvalBlocking.addList(
    "https://raw.githubusercontent.com/someone/list.txt",
    "ads"
  );
  Assert.ok(id.startsWith("sval-user-"));
  const entry = SvalBlocking.catalog().find(list => list.id == id);
  Assert.ok(entry.user, "it is the user's");
  Assert.equal(entry.license, null, "with no curated attribution");
});

add_task(async function a_synced_list_waits_for_this_device() {
  await reset();
  const url = "https://lists.example.com/synced.txt";
  const id = userListArrives({ url, category: "ads" });
  SvalBlocking.setListEnabled(id, true);
  Assert.ok(!(await SvalBlockingLists.update(id)), "not fetched");
  Assert.equal(SvalBlockingLists.status(id).state, "unconfirmed");
  SvalBlocking.confirmList(id);
  Assert.equal(
    SvalBlockingLists.status(id).state,
    "pending",
    "allowed, it waits for its download"
  );
});

add_task(async function an_unreachable_list_host_fails_without_an_error() {
  await reset();
  const closed = new HttpServer();
  closed.start(-1);
  const port = closed.identity.primaryPort;
  await new Promise(resolve => closed.stop(resolve));
  Services.prefs.setStringPref(
    listUrlPref("sval-easylist"),
    `http://localhost:${port}/list.txt`
  );
  Services.console.reset();
  Assert.ok(!(await SvalBlockingLists.update("sval-easylist")), "it failed");
  Assert.equal(SvalBlockingLists.status("sval-easylist").state, "never");
  Assert.deepEqual(
    Services.console
      .getMessageArray()
      .filter(m => m instanceof Ci.nsIScriptError)
      .map(m => m.errorMessage),
    [],
    "the console shows no error"
  );
});

add_task(async function an_oversized_list_is_refused() {
  await reset();
  publish("sval-easylist", [
    { body: "a".repeat(33 * 1024 * 1024) },
    { body: "! Title: Fits\n||fits.example^\n" },
  ]);
  Assert.ok(!(await SvalBlockingLists.update("sval-easylist")), "refused");
  Assert.equal(SvalBlockingLists.status("sval-easylist").state, "never");
  Assert.ok(
    await SvalBlockingLists.update("sval-easylist"),
    "one that fits loads"
  );
  Assert.equal(SvalBlockingLists.status("sval-easylist").state, "ok");
});

add_task(async function a_list_and_its_includes_share_one_budget() {
  await reset();
  const half = "a".repeat(17 * 1024 * 1024);
  publish("sval-fanboy-annoyance", [
    { body: `!#include part.txt\n${half}` },
    { body: half },
  ]);
  Assert.ok(
    !(await SvalBlockingLists.update("sval-fanboy-annoyance")),
    "two halves past the cap are refused together"
  );
  const many = Array.from({ length: 40 }, (_, i) => `!#include p${i}.txt`);
  publish("sval-fanboy-annoyance", [
    { body: many.join("\n") },
    ...Array.from({ length: 40 }, () => ({ body: "||x.example^" })),
  ]);
  Assert.ok(
    !(await SvalBlockingLists.update("sval-fanboy-annoyance")),
    "too many includes are refused"
  );
});

add_task(function if_blocks_resolve_for_firefox_on_the_desktop() {
  const list = [
    "||always.example^",
    "!#if env_firefox",
    "||firefox.example^",
    "!#if env_mobile",
    "||mobile.example^",
    "!#else",
    "||desktop.example^",
    "!#endif",
    "!#else",
    "||not-firefox.example^",
    "!#endif",
    "!#if !cap_html_filtering && cap_user_stylesheet",
    "||no-html.example^",
    "!#endif",
    "!#if (env_chromium || env_safari)",
    "||chromium.example^",
    "!#endif",
    "!#if cap_something_new",
    "||unknown-cap.example^",
    "!#endif",
    "!#if env_unheard_of",
    "||unknown-env.example^",
    "!#endif",
  ].join("\n");
  Assert.deepEqual(preprocessList(list).split("\n"), [
    "||always.example^",
    "||firefox.example^",
    "||desktop.example^",
    "||no-html.example^",
    "||unknown-env.example^",
  ]);
});

add_task(async function a_synced_list_does_not_wake_the_schedule() {
  await reset();
  const url = "https://lists.example.com/synced.txt";
  const id = userListArrives({ url, category: "ads" });
  // From Off, so the user's list is the only one Custom has.
  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled(id, true);
  SvalBlocking.flush();
  Services.prefs.setBoolPref("browser.sval.adblock.updates.enabled", true);
  try {
    await SvalBlockingLists.start();
    Assert.equal(SvalBlockingLists.nextDue, Infinity, "nothing to wake for");
    SvalBlocking.confirmList(id);
    Assert.less(SvalBlockingLists.nextDue, Infinity, "allowed, it is due");
  } finally {
    SvalBlockingLists.stop();
    Services.prefs.clearUserPref("browser.sval.adblock.updates.enabled");
  }
});

add_task(async function reading_the_state_tells_settings_once() {
  await reset();
  let told = 0;
  const count = () => told++;
  Services.obs.addObserver(count, BLOCKING_TOPIC);
  try {
    const first = TestUtils.topicObserved(BLOCKING_TOPIC);
    for (const id of ["sval-easylist", "sval-easyprivacy", "sval-easylist"]) {
      Assert.equal(SvalBlockingLists.status(id).state, "pending");
    }
    await within(first, 5_000, "the state file's read");
    // Every notice the reads asked for is due by the next turn.
    await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
    Assert.equal(told, 1, "one notice for the one read");
  } finally {
    Services.obs.removeObserver(count, BLOCKING_TOPIC);
  }
});

/** Privacy Badger's module, cut down to one group nobody else knows. */
const FIRST_PARTIES = `let multiDomainFirstPartiesArray = [
  ["owner-cdn.example", "owner-one.example"],
];
`;

/** @returns {Promise<string[]>} The owners' exceptions as served. */
async function ownerRules() {
  return new TextDecoder()
    .decode(await SvalBlockingLists.getListBytes("sval-tracker-owners"))
    .split("\n");
}

const OWNED =
  "@@||owner-cdn.example^$domain=owner-cdn.example|owner-one.example";

/**
 * Until Privacy Badger's groups first download, the owners' exceptions come
 * from the bundled sources alone, and serving them waits on nothing.
 */
add_task(async function the_owners_exceptions_need_no_downloaded_copy() {
  await reset();
  SvalBlocking.setLevel("balanced");
  publish("sval-easyprivacy", [
    { body: "||google-analytics.com^\n||owner-cdn.example^\n" },
  ]);
  await SvalBlockingLists.update("sval-easyprivacy");
  const rules = await ownerRules();
  Assert.ok(
    rules.some(rule => rule.startsWith("@@||google-analytics.com^$domain=")),
    "the bundled owners serve"
  );
  Assert.ok(!rules.includes(OWNED), "and nothing of Privacy Badger's");
});

/**
 * Privacy Badger's groups download from a local server through Sval's own
 * download; a later download that does not parse leaves the copy there is.
 */
add_task(async function privacy_badgers_groups_keep_their_last_good_copy() {
  await reset();
  SvalBlocking.setLevel("balanced");
  publish("sval-easyprivacy", [{ body: "||owner-cdn.example^\n" }]);
  await SvalBlockingLists.update("sval-easyprivacy");
  publish(FIRST_PARTIES_ID, [
    { body: FIRST_PARTIES },
    { body: FIRST_PARTIES.replace("]", `], fetch("https://x.example/")`) },
    { body: FIRST_PARTIES + `// ${"x".repeat(3 * 1024 * 1024)}\n` },
  ]);
  const changed = [];
  SvalBlockingLists.attach({
    onListsChanged: ids => changed.push(...ids),
  });
  registerCleanupFunction(() => SvalBlockingLists.detach());

  Assert.ok(await SvalBlockingLists.update(FIRST_PARTIES_ID), "it downloads");
  Assert.deepEqual(
    changed,
    ["sval-tracker-owners"],
    "the owners' exceptions rebuild, under their own id"
  );
  Assert.ok((await ownerRules()).includes(OWNED), "its groups are used");

  for (const what of ["code", "an oversized file"]) {
    changed.length = 0;
    Assert.ok(
      !(await SvalBlockingLists.update(FIRST_PARTIES_ID)),
      `${what} is refused`
    );
    Assert.equal(
      SvalBlockingLists.status(FIRST_PARTIES_ID).state,
      "stale",
      `and recorded as a failure after ${what}`
    );
    Assert.deepEqual(changed, [], "nothing rebuilds");
    Assert.ok(
      (await ownerRules()).includes(OWNED),
      `the last good copy serves after ${what}`
    );
  }
});

/**
 * The schedule keeps the tracker lists and Privacy Badger's groups as it does
 * the ad lists, and only while list updates are on.
 */
add_task(async function the_schedule_keeps_what_the_tag_and_trackers_run() {
  await reset();
  Services.prefs.setBoolPref("browser.sval.adblock.updates.enabled", true);
  try {
    await SvalBlockingLists.start();
    Assert.equal(SvalBlockingLists.nextDue, Infinity, "nothing to keep");
    Services.prefs.setStringPref(TRACKER_TAG_LISTS_PREF, "sval-tracker-owners");
    Assert.less(
      SvalBlockingLists.nextDue,
      Infinity,
      "the owners' exceptions keep Privacy Badger's groups"
    );
    Services.prefs.clearUserPref(TRACKER_TAG_LISTS_PREF);
    Assert.equal(SvalBlockingLists.nextDue, Infinity, "and only they do");
    Services.prefs.setStringPref(TRACKER_LISTS_PREF, "sval-easyprivacy");
    Assert.less(SvalBlockingLists.nextDue, Infinity, "a tracker list is kept");
    Services.prefs.setBoolPref("browser.sval.adblock.updates.enabled", false);
    Services.prefs.setStringPref(TRACKER_TAG_LISTS_PREF, "sval-tracker-owners");
    Assert.equal(
      SvalBlockingLists.nextDue,
      Infinity,
      "with updates off, nothing is fetched"
    );
  } finally {
    SvalBlockingLists.stop();
    Services.prefs.clearUserPref("browser.sval.adblock.updates.enabled");
  }
});

add_task(function removeparam_rules_keep_what_query_stripping_applies() {
  const rules = removeparamRules(
    [
      "! A comment about $removeparam=commented",
      "$removeparam=gclid",
      "*$removeparam=MC_EID",
      "$removeparam=__cft__[0]",
      "$removeparam=igshid,domain=instagram.com",
      "||example.com^$removeparam=scoped",
      "$removeparam=/^utm_/",
      "||reddit.com^$doc,removeparam=/web_only=/",
      "@@||web.archive.org/*/http$removeparam",
      "@@||archive.*/http$removeparam,doc,to=archive.ph|~archive.is",
      "@@|https://shop.example.co.uk/path$removeparam=cls",
      "@@*$removeparam=gclid",
    ].join("\n")
  );
  Assert.deepEqual(
    rules.params.sort(),
    ["__cft__[0]", "gclid", "mc_eid"],
    "a rule naming one parameter with no option, lower-cased"
  );
  Assert.deepEqual(
    rules.sites.sort(),
    ["archive.org", "archive.ph", "example.co.uk"],
    "an exception's sites, by their registrable domain"
  );
  Assert.deepEqual(rules.kept, ["gclid"], "an exception with no pattern");
});

add_task(async function the_lists_parameters_merge_from_their_downloads() {
  await reset();
  publish("sval-ublock-privacy", [
    {
      body: "$removeparam=fbclid\n$removeparam=gclid\n@@||a.example^$removeparam\n",
    },
  ]);
  publish("sval-easyprivacy", [
    { body: "$removeparam=yclid\n@@$removeparam=gclid\n" },
  ]);
  await SvalBlockingLists.update("sval-ublock-privacy");
  await SvalBlockingLists.update("sval-easyprivacy");
  Assert.deepEqual(
    await SvalBlockingLists.removeparams([
      "sval-ublock-privacy",
      "sval-easyprivacy",
      "sval-easylist",
    ]),
    { params: ["fbclid", "yclid"], sites: ["a.example"] },
    "every list's parameters, less one any list keeps, and a list never downloaded adds none"
  );

  // A later launch reads the rules from the state file, and a state file
  // without them from the list's copy.
  const statePath = PathUtils.join(SvalBlockingLists.dir, "lists.json");
  const state = await IOUtils.readJSON(statePath);
  Assert.deepEqual(state["sval-ublock-privacy"].removeparam.params, [
    "fbclid",
    "gclid",
  ]);
  delete state["sval-ublock-privacy"].removeparam;
  await IOUtils.writeJSON(statePath, state);
  SvalBlockingLists.resetForTesting();
  Assert.deepEqual(
    await SvalBlockingLists.removeparams(["sval-ublock-privacy"]),
    { params: ["fbclid", "gclid"], sites: ["a.example"] },
    "read from the copy"
  );
});

add_task(async function the_level_sets_the_strip_lists_defaults() {
  await reset();
  publish("sval-ublock-privacy", [
    { body: "$removeparam=fbclid\n@@||a.example^$removeparam\n" },
  ]);
  await SvalBlockingLists.update("sval-ublock-privacy");
  const defaults = Services.prefs.getDefaultBranch("");
  try {
    SvalBlocking.setLevel("balanced");
    await SvalBlocking._applyStripList();
    Assert.equal(
      defaults.getStringPref("privacy.query_stripping.strip_list"),
      "fbclid"
    );
    Assert.equal(
      defaults.getStringPref("privacy.query_stripping.allow_list"),
      "a.example"
    );

    SvalBlocking.setLevel("off");
    await SvalBlocking._applyStripList();
    Assert.equal(
      defaults.getStringPref("privacy.query_stripping.strip_list"),
      ""
    );
    Assert.equal(
      defaults.getStringPref("privacy.query_stripping.allow_list"),
      ""
    );
  } finally {
    SvalBlocking.setLevel("off");
  }
});
