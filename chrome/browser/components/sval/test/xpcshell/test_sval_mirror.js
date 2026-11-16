/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What `SvalMirror` promises every store (store-mirror spec §6), over the
 * smallest store there is: a map of keys to values, mirrored into a settings
 * document on real engines. Each adapter's own tests cover its store.
 */

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalMirror } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalMirror.sys.mjs"
);

const { waitForCondition, within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

const TREE = "workspace-under-test";
const DOC = "settings";

/**
 * A store of keys and values whose writes, the mirror's included, are heard
 * as they happen, as Gecko's prefs are.
 */
class MapStore {
  constructor() {
    this.values = new Map();
    this.listener = null;
    /** Keys whose next write the store refuses. */
    this.refuse = new Set();
    /** When set, a write waits on it before it takes effect. */
    this.hold = null;
    /** Whether a write is waiting on `hold`. */
    this.writing = false;
  }
  set(key, value) {
    this.values.set(key, value);
    this.listener?.(key, value);
  }
  adapter(engine) {
    return {
      document: DOC,
      keyOf: row => row.key,
      readDocument: async () => {
        const rows = new Map();
        for (const [key, value] of Object.entries(await engine.settings(DOC))) {
          const id = await engine.settingId(key);
          rows.set(id, { id, key, value });
        }
        return rows;
      },
      observe: ({ pending, changes }) => {
        this.listener = (key, value) => {
          pending([key]);
          changes([{ key, value }], [key]);
        };
        return () => (this.listener = null);
      },
      isEcho: (change, applied) => change.value === applied.value,
      toMutations: async changes =>
        changes.map(({ key, value }) => ({
          kind: "setSetting",
          key,
          valueJson: JSON.stringify(value),
        })),
      write: async (doc, upserts) => {
        const failed = [];
        for (const row of upserts) {
          if (this.refuse.delete(row.key)) {
            failed.push(row.id);
            continue;
          }
          if (this.hold) {
            this.writing = true;
            await this.hold;
            this.writing = false;
          }
          this.set(row.key, row.value);
        }
        return failed;
      },
    };
  }
}

/** Two devices on one folder, each a store mirrored by its own engine. */
async function twoDevices() {
  const root = await makeTempDir("sval-mirror");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  let tick = 10_000;
  const now = () => (tick += 1000);
  const made = [];
  registerCleanupFunction(() =>
    made.forEach(d => {
      d.mirror.stop();
      d.engine.terminate();
    })
  );
  const make = async () => {
    const engine = new SvalEngine({
      root,
      sharedRoot: root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const store = new MapStore();
    const writes = [];
    const mutate = engine.mutate.bind(engine);
    engine.mutate = op => {
      for (const each of op.kind === "batch" ? op.ops : [op]) {
        writes.push(each.key);
      }
      return mutate(op);
    };
    const mirror = new SvalMirror({
      engine,
      adapter: store.adapter(engine),
      requestPass: () => {},
      now,
    });
    const device = {
      engine,
      store,
      writes,
      mirror,
      settle: async () => {
        for (let i = 0; i < 2; i++) {
          await new Promise(resolve => executeSoon(resolve));
          await within(mirror.whenIdle(), 10_000, "mirror going idle");
        }
      },
      pass: async () => {
        await engine.sync(TREE, now());
        await device.settle();
      },
    };
    await mirror.start();
    made.push(device);
    return device;
  };
  return { make };
}

add_task(async function a_change_reaches_the_other_store() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  a.store.set("k", 1);
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.equal(b.store.values.get("k"), 1);
});

add_task(async function an_applied_value_is_never_written_back() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  a.store.set("k", 1);
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.equal(b.store.values.get("k"), 1, "b applied it");
  Assert.deepEqual(b.writes, [], "and wrote nothing back");
});

add_task(async function a_change_made_during_an_apply_survives_it() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  b.store.set("k", "peer");
  await b.settle();
  await b.pass();

  let release;
  a.store.hold = new Promise(resolve => (release = resolve));
  const passing = a.pass();
  await waitForCondition(() => a.store.writing, "a's apply is under way");
  a.store.set("k", "mine");
  release();
  a.store.hold = null;
  await passing;
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.equal(a.store.values.get("k"), "mine", "a keeps its change");
  Assert.equal(b.store.values.get("k"), "mine", "and b takes it");
});

add_task(async function a_refused_write_is_offered_again() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  b.store.refuse.add("k");
  a.store.set("k", 1);
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.ok(!b.store.values.has("k"), "the store refused it");
  await b.pass();
  Assert.equal(b.store.values.get("k"), 1, "the next pass wrote it");
});

add_task(async function a_stopped_mirror_hears_nothing() {
  const { make } = await twoDevices();
  const a = await make();
  a.mirror.stop();
  a.store.set("k", 1);
  await a.settle();
  Assert.deepEqual(a.writes, [], "nothing reached the document");
  Assert.equal(a.store.listener, null, "and nothing listens");
});
