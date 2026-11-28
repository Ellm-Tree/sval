/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from history_head.js */

// History sync (history-sync spec §4): devices on one folder, each with a
// history of its own that reports what the user does as Places would.

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalHistorySync, HISTORY_INDEX, VISITS_PER_PAGE, weekOf, weeksWithin } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
  );
const { SvalDeviceNames, DEVICE_NAME_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs"
);

const { waitForCondition, within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { AsyncShutdown } = ChromeUtils.importESModule(
  "resource://gre/modules/AsyncShutdown.sys.mjs"
);

// Places needs a profile, for the task that runs the real one.
do_get_profile();

const TREE = "workspace-under-test";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const WORK = "3c1d9e2a-77b0-4f15-a8c6-5e0d2b9f1a47";

/**
 * When the ISO week holding `ms` begins: Monday, 00:00 UTC.
 *
 * @param {number} ms Milliseconds since the epoch.
 * @returns {number}
 */
function weekStart(ms) {
  const d = new Date(ms);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - ((d.getUTCDay() + 6) % 7)
  );
}

/**
 * The time on every device's clock, which Places' visit times are on: a
 * Wednesday at noon UTC, mid ISO week 2026-W42, so a task's visits from a few
 * hours before it are in its week. Only the current week syncs at every pass;
 * an earlier one goes through the index, a few weeks a pass (history-sync spec
 * §4.1).
 */
const NOW = Date.UTC(2026, 9, 14, 12);

/**
 * Devices on one folder, each with its own history.
 *
 * @param {object} [options]
 * @param {() => number} [options.clock] The devices' time.
 */
function devices({ clock = () => NOW } = {}) {
  const root = makeTempDir("sval-history-sync");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const made = [];
  registerCleanupFunction(() =>
    made.forEach(d => {
      d.sync.stop();
      d.engine.terminate();
    })
  );
  const make = async ({ history = new FakeHistory(), titleHoldMs } = {}) => {
    const engine = new SvalEngine({
      root: await root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const sync = new SvalHistorySync({
      engine,
      places: history,
      storage: memoryStorage(),
      requestPass: () => {},
      now: clock,
      titleHoldMs,
    });
    const device = {
      engine,
      history,
      sync,
      pass: async () => {
        await within(sync.whenIdle(), 10_000, "sync going idle");
        // On the engine's own clock, which stamps its writes; the devices'
        // clock is the one Places' visit times are on.
        const report = await engine.sync(TREE);
        await within(sync.whenIdle(), 10_000, "sync going idle");
        return report;
      },
      settle: () => within(sync.whenIdle(), 10_000, "sync going idle"),
    };
    made.push(device);
    return device;
  };
  return { make };
}

/**
 * Passes on each device in turn, `rounds` times.
 *
 * @param {number} rounds
 * @param {...object} all The devices.
 */
async function exchange(rounds, ...all) {
  for (let i = 0; i < rounds; i++) {
    for (const device of all) {
      await device.pass();
    }
  }
}

add_task(function weeks_are_iso_weeks_in_utc() {
  Assert.equal(weekOf(Date.UTC(2026, 0, 1)), "history-2026-W01");
  Assert.equal(weekOf(Date.UTC(2024, 11, 30)), "history-2025-W01");
  Assert.equal(weekOf(Date.UTC(2027, 0, 1, 23, 59)), "history-2026-W53");
  Assert.equal(weekOf(Date.UTC(2026, 9, 18, 23, 59)), "history-2026-W42");
  Assert.equal(weekOf(Date.UTC(2026, 9, 19)), "history-2026-W43");
  const known = [
    "history-2026-W43",
    "history-2025-W52",
    "history-2026-W40",
    "history-2026-W41",
    "history-2026-W44",
    "history-2026-W42",
  ];
  Assert.deepEqual(
    weeksWithin(known, Date.UTC(2026, 9, 10), Date.UTC(2026, 9, 20)),
    ["history-2026-W41", "history-2026-W42", "history-2026-W43"]
  );
  Assert.deepEqual(
    weeksWithin(known, 0, Date.UTC(2026, 9, 20)),
    known.filter(week => week !== "history-2026-W44").sort(),
    "a clear of everything takes every week up to its end"
  );
});

/**
 * A process instance stops the instance it replaces at once, which can be
 * while that one is still beginning. It then listens to nothing.
 */
add_task(async function a_stop_while_it_begins_leaves_nothing_listening() {
  const { make } = devices();
  const { engine, history, sync } = await make();
  const open = engine.openDocument.bind(engine);
  engine.openDocument = (...args) => {
    sync.stop();
    return open(...args);
  };
  await sync.start();
  Assert.equal(history.on, null, "it leaves no listener on Places");
});

add_task(async function a_visit_on_one_device_reaches_the_others_history() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();

  const at = NOW - 1000;
  a.history.visit("https://e.example/", at, { title: "Example" });
  await a.settle();
  await exchange(1, a, b);

  Assert.ok(b.history.has("https://e.example/", at), "the visit arrived");
  const arrived = b.history.visits.find(v => v.url === "https://e.example/");
  Assert.equal(arrived.transition, TYPED, "with its transition");
  Assert.equal(arrived.title, "Example", "and its title");
  const rows = await b.engine.visits(weekOf(at));
  Assert.equal(rows.length, 1, "inserting it wrote no visit of B's own");
  Assert.equal(rows[0].device, a.engine.deviceIdHex);
});

add_task(async function a_visit_to_a_file_stays_on_its_device() {
  const { make } = devices();
  const at = NOW - 2000;
  const a = await make({
    history: new FakeHistory([
      { url: "file:///Users/me/seeded.html", visitedAt: at },
    ]),
  });
  const b = await make();
  await a.sync.start();
  await b.sync.start();

  a.history.visit("file:///Users/me/notes.html", at + 1);
  a.history.visit("https://e.example/", at + 2);
  await a.settle();
  await exchange(1, a, b);

  const rows = await a.engine.visits(weekOf(at));
  Assert.deepEqual(
    rows.map(row => row.url),
    ["https://e.example/"],
    "neither the seeded nor the new file visit is written"
  );
  Assert.ok(b.history.has("https://e.example/", at + 2));
  Assert.ok(!b.history.visits.some(v => v.url.startsWith("file:")));
});

add_task(async function a_visits_workspace_reaches_the_other_device() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();

  const at = NOW - 1000;
  a.history.visit("https://in.example/", at, { workspace: WORK });
  a.history.visit("https://none.example/", at + 1);
  await a.settle();
  await exchange(1, a, b);

  const rows = await a.engine.visits(weekOf(at));
  const workspaceOf = (list, url) => list.find(v => v.url === url)?.workspace;
  Assert.equal(workspaceOf(rows, "https://in.example/"), WORK);
  Assert.equal(workspaceOf(rows, "https://none.example/"), null);
  Assert.equal(
    workspaceOf(b.history.visits, "https://in.example/"),
    WORK,
    "B's Places records the workspace the visit was made in"
  );
  Assert.equal(
    workspaceOf(b.history.visits, "https://none.example/"),
    null,
    "and none for a visit made in none"
  );
});

add_task(async function a_page_syncs_its_newest_visits_in_a_week() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();

  const at = NOW - 60_000;
  const extra = 5;
  for (let i = 0; i < VISITS_PER_PAGE + extra; i++) {
    a.history.visit("https://loop.example/", at + i);
  }
  await a.settle();
  await exchange(1, a, b);

  const newest = Array.from(
    { length: VISITS_PER_PAGE },
    (_, i) => at + extra + i
  );
  const rows = await a.engine.visits(weekOf(at));
  Assert.deepEqual(
    rows.map(row => row.visitedAt).sort((x, y) => x - y),
    newest,
    "the week holds the page's newest visits"
  );
  Assert.deepEqual(
    b.history.visits
      .filter(v => v.url === "https://loop.example/")
      .map(v => v.visitedAt)
      .sort((x, y) => x - y),
    newest,
    "and the other device takes those"
  );
  Assert.equal(
    a.history.visits.length,
    VISITS_PER_PAGE + extra,
    "Places keeps every visit made here"
  );
});

add_task(async function framed_download_and_hidden_visits_stay_here() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();

  const at = NOW - 60_000;
  a.history.visit("https://framed.example/", at, { transition: FRAMED_LINK });
  a.history.visit("https://download.example/", at + 1, {
    transition: DOWNLOAD,
  });
  a.history.visit("https://hidden.example/", at + 2, { hidden: true });
  a.history.visit("https://e.example/", at + 3);
  await a.settle();
  await exchange(1, a, b);

  const rows = await a.engine.visits(weekOf(at));
  Assert.deepEqual(
    rows.map(row => row.url),
    ["https://e.example/"]
  );
  Assert.deepEqual(
    b.history.visits.map(v => v.url),
    ["https://e.example/"]
  );
});

add_task(
  async function a_week_holding_more_visits_to_a_page_keeps_the_newest() {
    const { make } = devices();
    const a = await make();
    const at = NOW - 60_000;
    const extra = 3;
    await a.engine.writeLocally(
      weekOf(at),
      Array.from({ length: VISITS_PER_PAGE + extra }, (_, i) => ({
        kind: "addVisit",
        url: "https://loop.example/",
        title: "",
        transition: LINK,
        visitedAt: at + i,
        workspace: null,
      }))
    );
    await a.sync.start();
    await a.settle();

    const rows = await a.engine.visits(weekOf(at));
    Assert.deepEqual(
      rows.map(row => row.visitedAt).sort((x, y) => x - y),
      Array.from({ length: VISITS_PER_PAGE }, (_, i) => at + extra + i),
      "the week is trimmed to the page's newest visits as it loads"
    );
  }
);

add_task(async function an_incoming_visit_places_holds_or_outdates_stays_out() {
  const { make } = devices();
  const at = NOW - 60 * 60 * 1000;
  const url = "https://busy.example/";
  const a = await make();
  const b = await make({
    history: new FakeHistory(
      Array.from({ length: VISITS_PER_PAGE }, (_, i) => ({
        url,
        visitedAt: at + 100 + i,
        transition: TYPED,
      }))
    ),
  });
  await a.sync.start();
  await b.sync.start();
  await b.settle();

  a.history.visit(url, at, { transition: TYPED });
  a.history.visit(url, at + 100, { transition: TYPED });
  a.history.visit(url, at + 200, { transition: TYPED });
  await a.settle();
  await exchange(2, a, b);

  const times = b.history.visits
    .filter(v => v.url === url)
    .map(v => v.visitedAt);
  Assert.ok(
    !times.includes(at),
    "an older visit than Places' newest is not inserted"
  );
  Assert.equal(
    times.filter(t => t === at + 100).length,
    1,
    "a visit Places holds at that time and transition is not inserted again"
  );
  Assert.ok(times.includes(at + 200), "a newer visit is inserted");
});

/**
 * Seeds a device whose Places holds an old page and a page visited more often
 * than sync takes, from `at`, and passes with another device `rounds` times.
 *
 * @param {object} options
 * @param {() => number} options.clock The devices' time.
 * @param {number} options.at When the busy page's oldest visit was made.
 * @param {number} options.rounds
 */
async function seedTakesNewestVisits({ clock, at, rounds }) {
  const { make } = devices({ clock });
  const old = clock() - 40 * DAY_MS;
  const extra = 4;
  const a = await make({
    history: new FakeHistory([
      { url: "https://old.example/", visitedAt: old },
      ...Array.from({ length: VISITS_PER_PAGE + extra }, (_, i) => ({
        url: "https://loop.example/",
        visitedAt: at + i,
      })),
    ]),
  });
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  await exchange(rounds, a, b);

  Assert.deepEqual(
    b.history.visits
      .filter(v => v.url === "https://loop.example/")
      .map(v => v.visitedAt)
      .sort((x, y) => x - y),
    Array.from({ length: VISITS_PER_PAGE }, (_, i) => at + extra + i),
    "the seed publishes a page's newest visits"
  );
  Assert.ok(
    !b.history.has("https://old.example/"),
    "a page last visited before the seed's window stays here"
  );
}

add_task(async function the_seed_takes_recent_pages_newest_visits() {
  await seedTakesNewestVisits({
    clock: () => NOW,
    at: NOW - 60 * 60 * 1000,
    rounds: 3,
  });
});

add_task(async function the_seed_publishes_last_weeks_visits_early_this_week() {
  // Half an hour into a week, with the visits an hour before it began. Their
  // week is a cold one: A loads and publishes it, the index announces it, and
  // B loads it and inserts its visits, a pass for each.
  const begins = weekStart(NOW);
  await seedTakesNewestVisits({
    clock: () => begins + 30 * 60 * 1000,
    at: begins - 60 * 60 * 1000,
    rounds: 4,
  });
});

add_task(async function the_seed_carries_each_visits_workspace() {
  const { make } = devices();
  const at = NOW - 2000;
  const a = await make({
    history: new FakeHistory([
      { url: "https://old.example/", visitedAt: at },
      { url: "https://in.example/", visitedAt: at + 1, workspace: WORK },
    ]),
  });
  await a.sync.start();
  await a.settle();

  const rows = await a.engine.visits(weekOf(at));
  const workspaceOf = url => rows.find(v => v.url === url)?.workspace;
  Assert.equal(workspaceOf("https://old.example/"), null, "an older visit");
  Assert.equal(workspaceOf("https://in.example/"), WORK);
});

add_task(async function deleting_a_page_deletes_every_devices_visits_to_it() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  // Each device's visits reach the other before the other device visits.
  a.history.visit("https://x.example/", NOW - 3000);
  await exchange(2, a, b);
  b.history.visit("https://x.example/", NOW - 2000);
  b.history.visit("https://keep.example/", NOW - 1000);
  await exchange(2, b, a);
  Assert.equal(a.history.visits.length, 3, "each holds every visit");

  b.history.deletePage("https://x.example/");
  await b.settle();
  await exchange(2, b, a);

  for (const device of [a, b]) {
    Assert.ok(!device.history.has("https://x.example/"), "the page is gone");
    Assert.ok(device.history.has("https://keep.example/"), "the rest stays");
    const rows = await device.engine.visits(weekOf(NOW));
    Assert.deepEqual(
      rows.map(r => r.url),
      ["https://keep.example/"]
    );
  }
});

add_task(
  async function a_visit_deleted_elsewhere_that_places_kept_stays_gone() {
    const { make } = devices();
    const a = await make();
    const b = await make();
    await a.sync.start();
    await b.sync.start();
    a.history.visit("https://gone.example/", NOW - 3000);
    await exchange(2, a, b);
    Assert.ok(b.history.has("https://gone.example/"), "B has A's visit");

    // B deletes the page, and A's Places will not let go of it the first time.
    const remove = a.history.removeVisits.bind(a.history);
    let refusals = 1;
    a.history.removeVisits = list =>
      refusals-- > 0
        ? Promise.reject(new Error("Places did not remove the visit"))
        : remove(list);
    b.history.deletePage("https://gone.example/");
    await b.settle();
    await exchange(1, b, a);
    Assert.less(refusals, 1, "A tried to remove the visit from Places");

    // A visit made before the deleted one that its week did not take, so the
    // week catches up from Places at the next visit, reading past the deleted
    // one.
    const mutate = a.engine.mutate.bind(a.engine);
    let failing = 1;
    a.engine.mutate = op =>
      op.ops?.[0]?.kind === "addVisit" && failing-- > 0
        ? Promise.reject(new Error("the week did not take the visit"))
        : mutate(op);
    a.history.visit("https://earlier.example/", NOW - 4000);
    await a.settle();
    a.history.visit("https://later.example/", NOW - 1000);
    await a.settle();
    await exchange(2, a, b);

    for (const device of [a, b]) {
      Assert.ok(
        !device.history.has("https://gone.example/"),
        "the deleted visit is gone from each device's history"
      );
      Assert.ok(device.history.has("https://earlier.example/"));
      Assert.ok(device.history.has("https://later.example/"));
      const rows = await device.engine.visits(weekOf(NOW));
      Assert.ok(
        !rows.some(row => row.url === "https://gone.example/"),
        "and from each device's copy of the week"
      );
    }
  }
);

add_task(async function clearing_this_devices_history_leaves_the_others() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  a.history.visit("https://a.example/", NOW - 3000);
  b.history.visit("https://b.example/", NOW - 2000);
  await exchange(2, a, b);

  SvalHistorySync.nextClearScope = "device";
  const from = NOW - 60_000;
  await b.sync.clearHistory([from * 1000, NOW * 1000], async () =>
    b.history.clearBetween(from, NOW)
  );
  await b.settle();
  await exchange(2, b, a);

  Assert.ok(!b.history.has("https://b.example/"), "B's own visit is gone");
  Assert.ok(!a.history.has("https://b.example/"), "from A too");
  Assert.ok(a.history.has("https://a.example/"), "A's stays on A");
  Assert.ok(
    b.history.has("https://a.example/", NOW - 3000),
    "and goes back into B's history"
  );
});

add_task(async function clearing_every_devices_history_clears_both() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  a.history.visit("https://a.example/", NOW - 3000);
  b.history.visit("https://b.example/", NOW - 2000);
  await exchange(2, a, b);

  SvalHistorySync.nextClearScope = "all";
  const from = NOW - 60_000;
  await b.sync.clearHistory([from * 1000, NOW * 1000], async () =>
    b.history.clearBetween(from, NOW)
  );
  Assert.equal(
    SvalHistorySync.nextClearScope,
    "device",
    "the choice applies to one clear"
  );
  await b.settle();
  await exchange(2, b, a);

  Assert.deepEqual(a.history.visits, [], "A's history is empty");
  Assert.deepEqual(b.history.visits, [], "so is B's");
});

add_task(async function expiry_on_one_device_leaves_the_others_alone() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  const at = NOW - 1000;
  a.history.visit("https://old.example/", at);
  await exchange(2, a, b);
  Assert.ok(b.history.has("https://old.example/"));

  b.history.expire("https://old.example/");
  await b.settle();
  await exchange(3, a, b);

  Assert.ok(a.history.has("https://old.example/"), "A keeps its visit");
  Assert.ok(
    !b.history.has("https://old.example/"),
    "and B does not take back what it expired"
  );
  Assert.equal((await a.engine.visits(weekOf(at))).length, 1);
});

add_task(async function an_older_week_reaches_a_device_through_the_index() {
  const { make } = devices();
  const old = NOW - 3 * WEEK_MS;
  const a = await make({
    history: new FakeHistory([
      { url: "https://before.example/", visitedAt: old, title: "Before" },
    ]),
  });
  await a.sync.start();
  // The seed's week is published, and only then named in the index.
  await exchange(4, a);
  const shards = await a.engine.shards(HISTORY_INDEX);
  Assert.ok(
    shards.some(shard => shard.name === weekOf(old)),
    "the index names the seeded week"
  );

  const b = await make();
  await b.sync.start();
  await exchange(3, b);

  Assert.ok(
    b.history.has("https://before.example/", old),
    "a week B never loaded arrived through the index"
  );
});

add_task(async function a_device_that_keeps_no_history_takes_none_in() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  b.history.recording = false;
  await a.sync.start();
  await b.sync.start();
  const at = NOW - 1000;
  a.history.visit("https://a.example/", at);
  b.history.visit("https://b.example/", at);
  await exchange(2, a, b);

  Assert.ok(!b.history.has("https://a.example/"), "nothing was inserted");
  Assert.ok(!a.history.has("https://b.example/"), "nothing was published");
});

/**
 * A page whose title keeps changing, a timer or an unread count, has its
 * visits retitled once per hold, the first title at once and the latest when
 * the hold ends.
 */
add_task(async function a_ticking_title_is_written_once_per_hold() {
  const { make } = devices();
  const a = await make({ titleHoldMs: 100 });
  await a.sync.start();
  const url = "https://mail.example/";
  const at = NOW - 1000;
  a.history.visit(url, at, { title: "Inbox" });
  await a.settle();

  const writes = { count: 0 };
  const mutate = a.engine.mutate.bind(a.engine);
  a.engine.mutate = op => {
    if (op.ops?.some(o => o.kind === "setVisitTitle")) {
      writes.count++;
    }
    return mutate(op);
  };
  const title = async () =>
    (await a.engine.visits(weekOf(at))).find(v => v.url === url).title;

  const ticks = 20;
  for (let i = 1; i <= ticks; i++) {
    a.history.on.titled(url, `Inbox (${i})`);
  }
  await waitForCondition(
    async () => (await title()) === `Inbox (${ticks})`,
    "the latest title is written once the hold ends"
  );
  Assert.equal(
    writes.count,
    2,
    "the first title was written at once and the latest when the hold ended"
  );
});

add_task(async function a_devices_name_reaches_the_other() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  for (const device of [a, b]) {
    await device.engine.addDocument("settings");
  }
  Services.prefs.setStringPref(DEVICE_NAME_PREF, "Desk");
  registerCleanupFunction(() => {
    SvalDeviceNames.stop();
    Services.prefs.clearUserPref(DEVICE_NAME_PREF);
  });
  // A publishes its name. B's pass brings it in, and B reads every name as
  // it starts.
  await SvalDeviceNames.startFor(a.engine);
  Assert.equal(SvalDeviceNames.nameOf(a.engine.deviceIdHex), "Desk");
  await a.pass();
  await b.pass();
  await SvalDeviceNames.startFor(b.engine);
  Assert.equal(
    SvalDeviceNames.nameOf(a.engine.deviceIdHex),
    "Desk",
    "B reads A's name"
  );
});

add_task(async function a_renamed_device_reaches_names_already_read() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  for (const device of [a, b]) {
    await device.engine.addDocument("settings");
  }
  registerCleanupFunction(() => {
    SvalDeviceNames.stop();
    Services.prefs.clearUserPref(DEVICE_NAME_PREF);
  });
  Services.prefs.setStringPref(DEVICE_NAME_PREF, "Desk");
  await SvalDeviceNames.startFor(a.engine);
  await a.pass();
  await SvalDeviceNames.startFor(b.engine);
  await b.pass();
  await waitForCondition(
    () => SvalDeviceNames.nameOf(a.engine.deviceIdHex) === "Desk",
    "B reads A's name"
  );

  // A is renamed while B's names keep running: B's next pass brings it in.
  const key = `sval.device.name.${a.engine.deviceIdHex}`;
  await a.engine.mutate({
    kind: "setSetting",
    document: "settings",
    key,
    valueJson: JSON.stringify("Laptop"),
    now: Date.now(),
  });
  await a.pass();
  await b.pass();
  await waitForCondition(
    () => SvalDeviceNames.nameOf(a.engine.deviceIdHex) === "Laptop",
    "B reads A's new name"
  );
});

/**
 * A phone or tablet says which it is in the settings document, so every
 * device draws its Workspace with that device's mark.
 */
add_task(async function a_devices_kind_reaches_the_other_devices() {
  const { make } = devices();
  const a = await make();
  const b = await make();
  for (const device of [a, b]) {
    await device.engine.addDocument("settings");
  }
  registerCleanupFunction(() => SvalDeviceNames.stop());
  await a.engine.mutate({
    kind: "setSetting",
    document: "settings",
    key: `sval.device.kind.${a.engine.deviceIdHex}`,
    valueJson: JSON.stringify("tablet"),
    now: Date.now(),
  });
  await a.pass();
  await SvalDeviceNames.startFor(b.engine);
  Assert.equal(
    SvalDeviceNames.kindOf(a.engine.deviceIdHex),
    null,
    "nothing before the pass brings it in"
  );
  await b.pass();
  await waitForCondition(
    () => SvalDeviceNames.kindOf(a.engine.deviceIdHex) === "tablet",
    "B reads that A is a tablet"
  );
  Assert.equal(
    SvalDeviceNames.kindOf(b.engine.deviceIdHex),
    null,
    "and a device that never said has no kind"
  );
});

add_task(async function places_holds_what_the_store_inserts_and_removes() {
  await PlacesUtils.history.clear();
  registerCleanupFunction(() => PlacesUtils.history.clear());
  const places = SvalHistorySync.historyStore();
  const reported = Promise.withResolvers();
  const stop = places.observe({
    visited: visits => reported.resolve(visits),
    titled: () => {},
    removed: () => {},
    cleared: () => {},
  });
  registerCleanupFunction(stop);
  const at = NOW - 60_000;
  await places.insert([
    {
      url: "https://in.example/",
      title: "In",
      visitedAt: at,
      transition: TYPED,
    },
  ]);

  const {
    visits: [visit],
  } = await places.visitsBefore(null, 10);
  Assert.equal(visit.url, "https://in.example/");
  Assert.equal(visit.visitedAt, at, "at its own time");
  Assert.equal(visit.transition, TYPED, "with its own transition");
  Assert.equal(visit.title, "In");
  const [echo] = await within(
    reported.promise,
    10_000,
    "Places reports the visit it inserted"
  );
  Assert.equal(echo.visitedAt, at, "as the visit it was asked to insert");

  await places.removeVisits([{ url: "https://in.example/", at }]);
  Assert.deepEqual(await places.visitsBefore(null, 10), {
    visits: [],
    next: null,
  });
});

add_task(async function places_reports_deleted_pages_alone() {
  const places = SvalHistorySync.historyStore();
  const reported = { removed: [] };
  const done = Promise.withResolvers();
  const stop = places.observe({
    visited: () => {},
    titled: () => {},
    removed: urls => reported.removed.push(...urls),
    cleared: () => {},
  });
  const end = events => {
    if (events.some(e => e.url === "https://end.example/")) {
      done.resolve();
    }
  };
  PlacesUtils.observers.addListener(["page-removed"], end);
  registerCleanupFunction(() => {
    stop();
    PlacesUtils.observers.removeListener(["page-removed"], end);
  });
  const removal = (url, reason, isRemovedFromStore, isPartialVisistsRemoval) =>
    new PlacesVisitRemoved({
      url,
      pageGuid: "____________",
      reason,
      isRemovedFromStore,
      isPartialVisistsRemoval,
    });
  const { REASON_DELETED, REASON_EXPIRED } = PlacesVisitRemoved;
  PlacesObservers.notifyListeners([
    removal("https://gone.example/", REASON_EXPIRED, true, false),
    removal("https://kept.example/", REASON_EXPIRED, false, false),
    removal("https://older.example/", REASON_EXPIRED, false, true),
    removal("https://deleted.example/", REASON_DELETED, true, false),
    removal("https://end.example/", REASON_DELETED, false, true),
  ]);
  await within(done.promise, 10_000, "Places reports the removals");

  Assert.deepEqual(
    reported.removed,
    ["https://deleted.example/"],
    "only a page the user deleted is reported as removed"
  );
});

add_task(async function a_visit_from_a_clock_ahead_keeps_the_rest() {
  await PlacesUtils.history.clear();
  registerCleanupFunction(() => PlacesUtils.history.clear());
  const places = SvalHistorySync.historyStore();
  const at = NOW - 60_000;
  // Later than any clock Places checks a visit's time against.
  const ahead = Date.UTC(9999, 0, 1);
  await places.insert([
    { url: "https://past.example/", title: "Past", visitedAt: at },
    { url: "https://ahead.example/", title: "Ahead", visitedAt: ahead },
    { url: "https://both.example/", title: "Both", visitedAt: ahead },
    { url: "https://both.example/", title: "Both", visitedAt: at },
  ]);

  const { visits } = await places.visitsBefore(null, 10);
  Assert.deepEqual(
    visits.map(v => [v.url, v.visitedAt]).sort(),
    [
      ["https://both.example/", at],
      ["https://past.example/", at],
    ],
    "every visit Places accepts is inserted, and only the future ones are left out"
  );
});

add_task(async function a_visit_with_no_time_keeps_the_rest() {
  await PlacesUtils.history.clear();
  registerCleanupFunction(() => PlacesUtils.history.clear());
  const places = SvalHistorySync.historyStore();
  const at = NOW - 60_000;
  // What a Places notification for a visit it did not store carries
  // (`VisitData`'s defaults in History.cpp), as an earlier build wrote it.
  const unstored = { visitedAt: 0, transition: 0xffffffff };
  await places.insert([
    { url: "https://past.example/", title: "Past", visitedAt: at },
    { url: "https://none.example/", title: "", ...unstored },
    { url: "https://both.example/", title: "Both", ...unstored },
    { url: "https://both.example/", title: "Both", visitedAt: at },
  ]);

  const { visits } = await places.visitsBefore(null, 10);
  Assert.deepEqual(
    visits.map(v => [v.url, v.visitedAt]).sort(),
    [
      ["https://both.example/", at],
      ["https://past.example/", at],
    ],
    "the visits with a time are inserted, and those with none are left out"
  );
});

add_task(async function visits_made_at_one_instant_all_reach_another_device() {
  await PlacesUtils.history.clear();
  const { make } = devices();
  const a = await make({ history: SvalHistorySync.historyStore() });
  const b = await make();
  // More visits than one read of Places takes, the oldest of them made at one
  // instant, as an import makes them: the first read ends partway through that
  // instant.
  // The visits are spread over fewer pages than the seed takes, each with
  // no more visits than sync.
  const at = NOW - 60 * 60 * 1000;
  const count = 5005;
  const pageCount = Math.ceil(count / VISITS_PER_PAGE);
  const made = [];
  const pages = new Map();
  for (let i = 0; i < count; i++) {
    const url = `https://instant.example/${i % pageCount}`;
    const visitedAt = i < 10 ? at : at + i;
    made.push({ url, visitedAt });
    if (!pages.has(url)) {
      pages.set(url, { url, visits: [] });
    }
    pages
      .get(url)
      .visits.push({ date: new Date(visitedAt), transition: TYPED });
  }
  await PlacesUtils.history.insertMany([...pages.values()]);

  await a.sync.start();
  await b.sync.start();
  await exchange(4, a, b);
  a.sync.stop();
  await PlacesUtils.history.clear();

  Assert.deepEqual(
    made.filter(({ url, visitedAt }) => !b.history.has(url, visitedAt)),
    [],
    "every visit reached the other device"
  );
});

add_task(async function a_week_that_would_not_load_loads_at_the_next_visit() {
  const root = await makeTempDir("sval-history-unloadable");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const deviceId = crypto.getRandomValues(new Uint8Array(16));
  const old = NOW - 3 * WEEK_MS;
  const week = weekOf(old);
  const launch = async () => {
    const engine = new SvalEngine({ root, keyBytes, deviceId });
    const history = new FakeHistory();
    const sync = new SvalHistorySync({
      engine,
      places: history,
      storage: memoryStorage(),
      requestPass: () => {},
      now: () => NOW,
    });
    await sync.start();
    const pass = async () => {
      await within(sync.whenIdle(), 10_000, "sync going idle");
      await engine.sync(TREE);
      await within(sync.whenIdle(), 10_000, "sync going idle");
    };
    const quit = () => {
      sync.stop();
      engine.terminate();
    };
    registerCleanupFunction(quit);
    return { engine, history, sync, pass, quit };
  };

  // A week this device wrote to, on disk only.
  const first = await launch();
  first.history.visit("https://first.example/", old);
  await first.pass();
  const { prefix, mine } = await first.engine.post("layout", [
    { workspace: week, keyBytes, deviceId },
  ]);
  const ownFile = PathUtils.join(root, ...prefix.split("/"), mine);
  first.quit();

  // After a restart its file will not read, as an iCloud placeholder or a
  // locked file would not, so the week does not load for a visit to it.
  const second = await launch();
  await SvalTestDeny.read(ownFile);
  registerCleanupFunction(() => SvalTestDeny.allow(ownFile));
  second.history.visit("https://refused.example/", old + 1000);
  await within(second.sync.whenIdle(), 10_000, "second.sync going idle");

  // The file reads again, and the next visit to the week is written.
  await SvalTestDeny.allow(ownFile);
  second.history.visit("https://later.example/", old + 2000);
  await second.pass();
  second.quit();

  const third = new SvalEngine({ root, keyBytes, deviceId });
  registerCleanupFunction(() => third.terminate());
  await third.openDocument(week, () => {});
  const urls = (await third.visits(week)).map(row => row.url);
  Assert.ok(urls.includes("https://first.example/"), "the earlier visit stays");
  Assert.ok(
    urls.includes("https://later.example/"),
    "the visit made once the file read again is on disk after a restart"
  );
});

/**
 * One device whose week `week`, the current one unless given, will not load
 * while `gate.refusing` is set, as when iCloud has not downloaded the week's
 * file yet or the worker fails, and another on the same folder.
 * `gate.loads` counts the first device's loads of the week. Calling `first`
 * again starts the first device again on the same profile, its Places and
 * state kept.
 *
 * @param {object} [options]
 * @param {string} [options.week]
 */
async function aWeekThatWillNotLoad({ week = weekOf(NOW) } = {}) {
  const root = await makeTempDir("sval-history-unloadable-week");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const deviceId = crypto.getRandomValues(new Uint8Array(16));
  const storage = memoryStorage();
  const history = new FakeHistory();
  const gate = { refusing: true, loads: 0 };
  const launch = async ({
    id = deviceId,
    places = history,
    state = storage,
  }) => {
    const engine = new SvalEngine({ root, keyBytes, deviceId: id });
    const open = engine.openDocument.bind(engine);
    if (places === history) {
      engine.openDocument = (name, onPass) => {
        if (name !== week) {
          return open(name, onPass);
        }
        gate.loads++;
        return gate.refusing
          ? Promise.reject(new Error("the week's file did not read"))
          : open(name, onPass);
      };
    }
    const sync = new SvalHistorySync({
      engine,
      places,
      storage: state,
      requestPass: () => {},
      now: () => NOW,
    });
    const device = {
      engine,
      history: places,
      sync,
      pass: async () => {
        await within(sync.whenIdle(), 10_000, "sync going idle");
        await engine.sync(TREE);
        await within(sync.whenIdle(), 10_000, "sync going idle");
      },
      quit: () => {
        sync.stop();
        engine.terminate();
      },
    };
    registerCleanupFunction(device.quit);
    await sync.start();
    return device;
  };
  return {
    week,
    gate,
    root,
    keyBytes,
    deviceId,
    first: () => launch({}),
    other: () =>
      launch({
        id: crypto.getRandomValues(new Uint8Array(16)),
        places: new FakeHistory(),
        state: memoryStorage(),
      }),
  };
}

add_task(async function visits_made_while_this_week_would_not_load_sync() {
  const setup = await aWeekThatWillNotLoad();
  const a = await setup.first();
  const b = await setup.other();
  const at = NOW - 1000;
  a.history.visit("https://while-refused.example/", at);
  await a.pass();
  a.history.visit("https://still-refused.example/", at + 1);
  await a.pass();

  // The week reads again, and the next poll loads it.
  setup.gate.refusing = false;
  await a.pass();
  a.history.visit("https://once-loaded.example/", at + 2);
  await exchange(4, a, b);
  for (const url of [
    "https://while-refused.example/",
    "https://still-refused.example/",
    "https://once-loaded.example/",
  ]) {
    Assert.ok(b.history.has(url), `the other device has ${url}`);
  }

  // This device's own copy of the week holds them after a restart.
  a.quit();
  const after = new SvalEngine({
    root: setup.root,
    keyBytes: setup.keyBytes,
    deviceId: setup.deviceId,
  });
  registerCleanupFunction(() => after.terminate());
  await after.openDocument(setup.week, () => {});
  const urls = (await after.visits(setup.week)).map(row => row.url).sort();
  Assert.deepEqual(urls, [
    "https://once-loaded.example/",
    "https://still-refused.example/",
    "https://while-refused.example/",
  ]);
});

add_task(async function an_older_week_that_will_not_load_is_tried_once() {
  const old = NOW - 3 * WEEK_MS;
  const setup = await aWeekThatWillNotLoad({ week: weekOf(old) });
  const a = await setup.first();
  const b = await setup.other();
  a.history.visit("https://refused.example/", old);
  await within(a.sync.whenIdle(), 10_000, "a.sync going idle");
  Assert.equal(setup.gate.loads, 1, "the visit tried to load its week");
  await exchange(4, a, b);
  Assert.equal(
    setup.gate.loads,
    1,
    "passes that change nothing about the week leave it alone"
  );

  // The week reads again, and the next start loads it.
  setup.gate.refusing = false;
  a.quit();
  const again = await setup.first();
  await exchange(4, again, b);
  Assert.ok(
    b.history.has("https://refused.example/", old),
    "the other device has the visit the week would not take"
  );
});

add_task(
  async function a_visit_made_before_quitting_unloaded_syncs_next_start() {
    const setup = await aWeekThatWillNotLoad();
    const a = await setup.first();
    a.history.visit("https://before-quit.example/", NOW - 1000);
    await a.pass();
    a.quit();

    // The next start finds the week readable.
    setup.gate.refusing = false;
    const again = await setup.first();
    const b = await setup.other();
    await exchange(4, again, b);
    Assert.ok(
      b.history.has("https://before-quit.example/"),
      "the other device has the visit made before the quit"
    );
  }
);

add_task(
  async function visits_waiting_for_their_week_stay_after_history_is_off() {
    const setup = await aWeekThatWillNotLoad();
    const a = await setup.first();
    const b = await setup.other();
    a.history.visit("https://before-off.example/", NOW - 1000);
    await a.pass();

    // The user turns history off, then the week loads. A visit the week
    // took would reach the other device within these passes.
    a.history.recording = false;
    setup.gate.refusing = false;
    await exchange(12, a, b);
    Assert.deepEqual(
      await a.engine.visits(setup.week),
      [],
      "this device's copy of the week holds nothing to publish"
    );
    Assert.ok(
      !b.history.has("https://before-off.example/"),
      "the other device gets nothing from a device that keeps no history"
    );
  }
);

/**
 * A visit made just before quitting reaches the other devices after the next
 * start. Its week is recorded as waiting to be published only in the state
 * file, and the profile's shutdown phase writes that record although the
 * save it was waiting for had not come round.
 */
add_task(async function a_visit_made_just_before_quitting_is_published_later() {
  const root = await makeTempDir("sval-history-quit");
  const profile = await makeTempDir("sval-history-quit-profile");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const deviceId = crypto.getRandomValues(new Uint8Array(16));
  const old = NOW - 3 * WEEK_MS;
  const launch = async (statePath, finalizeAt) => {
    const engine = new SvalEngine({ root, keyBytes, deviceId });
    const history = new FakeHistory();
    const sync = new SvalHistorySync({
      engine,
      places: history,
      // A save that would not come round before the phase ends.
      storage: SvalHistorySync.profileStorage({
        path: statePath,
        finalizeAt,
        saveDelayMs: 10 * 60 * 1000,
      }),
      requestPass: () => {},
      now: () => NOW,
    });
    await sync.start();
    const quit = () => {
      sync.stop();
      engine.terminate();
    };
    registerCleanupFunction(quit);
    return { engine, history, sync, quit };
  };

  const quitting = new AsyncShutdown.Barrier("sval test: quit after a visit");
  const statePath = PathUtils.join(profile, "sval-history-sync.json");
  const first = await launch(statePath, quitting.client);
  // The engine's own last pass at quit, as `SvalEngine` holds the phase for
  // the profile's engine.
  quitting.client.addBlocker("sval test: the engine's last pass", () =>
    first.engine.publishBeforeShutdown()
  );
  first.history.visit("https://last.example/", old);
  await within(first.sync.whenIdle(), 10_000, "first.sync going idle");
  await within(quitting.wait(), 10_000, "the shutdown phase");
  // What the disk holds as the process ends with the phase.
  const atQuit = PathUtils.join(profile, "at-quit.json");
  await IOUtils.copy(statePath, atQuit);
  first.quit();
  Assert.ok(
    (await IOUtils.readJSON(atQuit)).unpublished.includes(weekOf(old)),
    "the shutdown phase recorded the visit's week as not yet published"
  );

  const second = await launch(
    atQuit,
    new AsyncShutdown.Barrier("unused").client
  );
  const otherEngine = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const otherHistory = new FakeHistory();
  const other = new SvalHistorySync({
    engine: otherEngine,
    places: otherHistory,
    storage: memoryStorage(),
    requestPass: () => {},
    now: () => NOW,
  });
  registerCleanupFunction(() => {
    other.stop();
    otherEngine.terminate();
  });
  await other.start();
  for (let i = 0; i < 4; i++) {
    for (const [sync, engine] of [
      [second.sync, second.engine],
      [other, otherEngine],
    ]) {
      await within(sync.whenIdle(), 10_000, "sync going idle");
      await engine.sync(TREE);
      await within(sync.whenIdle(), 10_000, "sync going idle");
    }
  }
  Assert.ok(
    otherHistory.has("https://last.example/", old),
    "and the other device has the visit after the next start"
  );
});

/**
 * The state file names pages, so a key no code reads would outlive every
 * clear of history if a load carried it into the next save.
 */
add_task(async function a_saved_key_no_code_reads_is_dropped() {
  const root = await makeTempDir("sval-history-unknown-key");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const storage = memoryStorage();
  await storage.write({
    unpublished: [],
    stale: { "https://private.example/": ["d1", NOW] },
  });
  const history = new FakeHistory();
  const sync = new SvalHistorySync({
    engine,
    places: history,
    storage,
    requestPass: () => {},
    now: () => NOW,
  });
  registerCleanupFunction(() => {
    sync.stop();
    engine.terminate();
  });
  await sync.start();
  history.visit("https://e.example/", NOW - 1000);
  await within(sync.whenIdle(), 10_000, "sync going idle");

  const saved = await storage.read();
  Assert.ok(!("stale" in saved), "the next save leaves the key out");
  Assert.ok(Array.isArray(saved.unpublished), "and keeps the state's own");
});

/**
 * The state file names pages, so a damaged one is removed rather than kept
 * beside the new one: no copy of it outlives Clear History.
 */
add_task(async function a_damaged_state_file_leaves_no_copy() {
  const dir = await makeTempDir("sval-history-damaged-state");
  const path = PathUtils.join(dir, "sval-history-sync.json");
  await IOUtils.writeUTF8(
    path,
    '{"deletions": [{"urls": ["https://private.example/"'
  );
  const storage = SvalHistorySync.profileStorage({ path });
  Assert.equal(await storage.read(), null, "it reads as a fresh start");
  Assert.deepEqual(
    await IOUtils.getChildren(dir),
    [],
    "and nothing of it is left in the profile"
  );
});
