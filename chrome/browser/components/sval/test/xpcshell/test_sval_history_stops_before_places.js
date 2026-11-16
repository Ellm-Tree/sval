/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from history_head.js */

// History sync stops in Places' clients phase, before Places closes its
// connections, and that phase waits for a start already reading Places. A
// quit just after first run ends must leave nothing reading Places once it
// has closed.

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalHistorySync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
);
const { SVAL_LOG_PREFIX } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);
const { AsyncShutdown } = ChromeUtils.importESModule(
  "resource://gre/modules/AsyncShutdown.sys.mjs"
);

const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
  Ci.nsIConsoleAPIStorage
);

const TREE = "workspace-under-test";
const HOUR_MS = 60 * 60 * 1000;

/** The store calls that read or write Places' database. */
const DATABASE_CALLS = [
  "insert",
  "removeVisits",
  "workspacesOf",
  "recordWorkspaces",
  "seedPages",
  "recentVisits",
  "visitsBefore",
];

/**
 * A device's history whose database closes as Places' does: a call made or
 * finishing once it has closed fails as `Sqlite.sys.mjs` fails it, and is
 * recorded in `late`. Its seed reads one visit a page, and `holdNextCall()`
 * holds the next database call until the hold is released.
 */
class ClosingHistory extends FakeHistory {
  constructor(visits) {
    super(visits);
    this.closed = false;
    this.late = [];
    this.hold = null;
    for (const name of DATABASE_CALLS) {
      const call = this[name].bind(this);
      this[name] = async (...args) => {
        this.#check(name);
        const hold = this.hold;
        this.hold = null;
        if (hold) {
          hold.reached.resolve();
          await hold.released.promise;
        }
        const result = await call(...args);
        this.#check(name);
        return result;
      };
    }
  }

  #check(name) {
    if (this.closed) {
      this.late.push(name);
      throw new Error("Connection is not open.");
    }
  }

  visitsBefore(after) {
    return super.visitsBefore(after, 1);
  }

  /** @returns {object} `{ reached, released }`, two deferred promises. */
  holdNextCall() {
    this.hold = {
      reached: Promise.withResolvers(),
      released: Promise.withResolvers(),
    };
    return this.hold;
  }
}

/** Collects the history warnings Sval logs. */
function listenForWarnings() {
  const warnings = [];
  const observe = message => {
    if (
      message.prefix === SVAL_LOG_PREFIX &&
      ["warn", "error"].includes(message.level) &&
      /history/.test(message.arguments[0])
    ) {
      warnings.push(message.arguments[0]);
    }
  };
  ConsoleAPIStorage.addLogEventListener(
    observe,
    Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
  );
  registerCleanupFunction(() =>
    ConsoleAPIStorage.removeLogEventListener(observe)
  );
  return warnings;
}

/**
 * The process's history sync on a fresh engine, before first run has ended,
 * with its shutdown blocker on a barrier standing for Places' clients phase.
 * Places closes once that phase ends.
 *
 * @returns {Promise<object>} `{ engine, history, sync, endFirstRun, quit }`.
 */
async function launch() {
  const engine = new SvalEngine({
    root: await makeTempDir("sval-history-stops"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const now = Date.now();
  const history = new ClosingHistory([
    { url: "https://one.example/", visitedAt: now - HOUR_MS },
    { url: "https://two.example/", visitedAt: now - 2 * HOUR_MS },
    { url: "https://three.example/", visitedAt: now - 3 * HOUR_MS },
  ]);
  const placesClients = new AsyncShutdown.Barrier(
    "sval test: Places' clients phase"
  );
  SvalHistorySync.setShutdownClient(placesClients.client, {
    timeoutMs: 10_000,
  });
  registerCleanupFunction(async () => {
    await SvalHistorySync.stopShared();
    SvalHistorySync.setShutdownClient(null);
    engine.terminate();
  });
  let pastFirstRun = false;
  const sync = await SvalHistorySync.startFor(engine, {
    places: history,
    storage: memoryStorage(),
    canBegin: () => pastFirstRun,
    requestPass: () => {},
  });
  return {
    engine,
    history,
    sync,
    endFirstRun: () => (pastFirstRun = true),
    quit: async () => {
      await within(placesClients.wait(), 10_000, "Places' clients phase");
      history.closed = true;
    },
    placesClients,
  };
}

add_task(async function a_pass_after_places_closes_reads_nothing() {
  const warnings = listenForWarnings();
  const { engine, history, sync, endFirstRun, quit } = await launch();
  endFirstRun();
  await quit();
  // The pass that finds first run over, run as the application quits.
  await engine.sync(TREE);
  await within(sync.whenIdle(), 10_000, "history sync going idle");
  Assert.deepEqual(history.late, [], "nothing reads Places once it closes");
  Assert.deepEqual(warnings, [], "and history sync warns of nothing");
});

add_task(async function places_waits_for_a_start_reading_it() {
  const warnings = listenForWarnings();
  const { engine, history, sync, endFirstRun, placesClients } = await launch();
  const hold = history.holdNextCall();
  endFirstRun();
  await engine.sync(TREE);
  await within(hold.reached.promise, 10_000, "the start reading Places");
  // The read finishes on a later turn than the phase begins in, as a read
  // Places runs on its storage thread does.
  placesClients.client.addBlocker("sval test: the read in flight", () =>
    Services.tm.dispatchToMainThread(() => hold.released.resolve())
  );
  await within(placesClients.wait(), 10_000, "Places' clients phase");
  history.closed = true;
  await within(sync.whenIdle(), 10_000, "history sync going idle");
  Assert.deepEqual(history.late, [], "nothing reads Places once it closes");
  Assert.deepEqual(warnings, [], "and history sync warns of nothing");
});
