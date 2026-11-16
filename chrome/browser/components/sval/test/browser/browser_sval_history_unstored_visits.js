/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A visit Places does not store reaches no week. Places' flooding
 * prevention keeps a visit to a restricted origin out of the database and
 * still notifies `page-visited` for it, with no time
 * (`NotifyOriginRestrictedVisit` in History.cpp).
 */

ChromeUtils.defineESModuleGetters(this, {
  PlacesTestUtils: "resource://testing-common/PlacesTestUtils.sys.mjs",
});

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalHistorySync, weekOf } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
);

const RESTRICTED = PAGE + "?restricted";
const STORED = "https://example.org/history-stored";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await PlacesUtils.history.clear();
  registerCleanupFunction(() => PlacesUtils.history.clear());
});

/**
 * History sync over Places and an engine of this task's own, with the state
 * it keeps readable.
 *
 * @returns {Promise<{engine: SvalEngine, state: () => object}>}
 */
async function historySync() {
  const bytes = n => crypto.getRandomValues(new Uint8Array(n));
  const engine = new SvalEngine({
    root: await makeTempDir("sval-history-unstored"),
    keyBytes: bytes(32),
    deviceId: bytes(16),
  });
  let current = null;
  const storage = {
    read: async () => ({ seed: { done: true, next: null } }),
    write: async () => {},
    saver: state => {
      current = state;
      return { saveSoon() {}, finalize() {} };
    },
  };
  await within(
    SvalHistorySync.startFor(engine, { canBegin: () => true, storage }),
    10_000,
    "history sync starts"
  );
  return { engine, state: () => current() };
}

add_task(async function a_visit_places_did_not_store_reaches_no_week() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["places.history.floodingPrevention.enabled", true],
      // Every visit to an origin is restricted, however recent the input.
      ["places.history.floodingPrevention.restrictionCount", 0],
      [
        "places.history.floodingPrevention.maxSecondsFromLastUserInteraction",
        0,
      ],
      // So the click below is user input (`UserActivation`).
      ["test.events.async.enabled", true],
    ],
  });
  const { engine, state } = await historySync();
  try {
    const notified = Promise.withResolvers();
    const listener = events => {
      for (const e of events) {
        if (e.url === RESTRICTED) {
          notified.resolve(e);
        }
      }
    };
    PlacesObservers.addListener(["page-visited"], listener);
    let event;
    try {
      const tab = await within(
        BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
        10_000,
        "a page loading"
      );
      // Places restricts an origin only once the user has given input
      // (`History::UpdateOriginFloodingRestriction`). The click lands on the
      // page's body, which is no control: the chrome's checker sees the
      // <browser>, as in `synthesizeVisitByUser` in Places' browser tests.
      AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
      try {
        await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
          EventUtils.synthesizeMouseAtCenter(
            content.document.body,
            {},
            content
          );
        });
      } finally {
        AccessibilityUtils.resetEnv();
      }
      const loaded = BrowserTestUtils.browserLoaded(
        tab.linkedBrowser,
        false,
        RESTRICTED
      );
      BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, RESTRICTED);
      event = await within(
        notified.promise,
        10_000,
        "Places notifying the visit"
      );
      await within(loaded, 10_000, "the restricted page loading");
    } finally {
      PlacesObservers.removeListener(["page-visited"], listener);
    }
    Assert.equal(event.visitId, 0, "Places stored no visit");
    Assert.equal(event.visitTime, 0, "and notified it with no time");

    // A visit Places stores, written once the one before it was handled.
    const at = Date.now();
    await PlacesTestUtils.addVisits({ uri: STORED, visitDate: at * 1000 });
    await TestUtils.waitForCondition(
      () => state().unpublished?.includes(weekOf(at)),
      "the stored visit reaches its week"
    );
    await within(
      SvalHistorySync.instance.whenIdle(),
      10_000,
      "history sync settling"
    );

    Assert.deepEqual(
      state().unpublished,
      [weekOf(at)],
      "only the stored visit's week was written"
    );
    // Places restricts the page the task starts from too when the process
    // had input before this file, so the week is checked only for the
    // visits this task decides.
    const urls = (await engine.visits(weekOf(at))).map(row => row.url);
    Assert.ok(urls.includes(STORED), "the week holds the stored visit");
    Assert.ok(!urls.includes(RESTRICTED), "and not the restricted one");
  } finally {
    await stopEngine(engine);
  }
});
