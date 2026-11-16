/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The lists the chrome keeps beside the engine's own: the colour tokens the
 * engine's boundary accepts, and the characters a pairing code is made of.
 * The chrome checks against its copy without a round trip to the worker, so
 * a copy the engine disagrees with writes what the engine refuses, or turns
 * away a code the engine generated.
 */

const { BACKUP_ALPHABET, GROUP, WORKSPACE, normalizeCode } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

do_get_profile();

async function engine() {
  const made = new SvalEngine({
    root: await makeTempDir("sval-vocabulary"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => made.terminate());
  return made;
}

add_task(async function the_engine_accepts_every_colour_token() {
  const eng = await engine();
  const id = crypto.randomUUID();
  await eng.mutate({ kind: "addWorkspace", id, name: "W", icon: null });
  for (const color of SvalColor.PRESETS) {
    await eng.mutate({ kind: "setAppearance", id, color, emoji: null });
    const { nodes } = await eng.tree();
    Assert.equal(nodes[id].kind, WORKSPACE);
    Assert.equal(nodes[id].appearance.color, color, `${color} is stored`);
  }
  const before = await eng.treeJson();
  await Assert.rejects(
    eng.mutate({ kind: "setAppearance", id, color: "teal", emoji: null }),
    err => err.code === "invalid_argument" && err.reason === "bad_color",
    "a token outside the list is refused, so the list is the engine's"
  );
  Assert.equal(
    await eng.treeJson(),
    before,
    "and the refusal left the document alone"
  );
});

/**
 * The custom colours the pickers make, and a Workspace's transparency, are
 * what the engine stores: a shape the browser writes and the engine refuses
 * would lose the person's choice.
 */
add_task(async function the_engine_stores_the_pickers_custom_colours() {
  const eng = await engine();
  const ws = crypto.randomUUID();
  const group = crypto.randomUUID();
  await eng.mutate({ kind: "addWorkspace", id: ws, name: "W", icon: null });
  await eng.mutate({ kind: "addGroup", parent: ws, name: "G", id: group });
  const custom = SvalColor.customFrom("orange", "light", false);
  await eng.mutate({
    kind: "setAppearance",
    id: ws,
    color: custom,
    emoji: null,
    transparency: 0.4,
  });
  await eng.mutate({
    kind: "setAppearance",
    id: group,
    color: { h: 123.4, c: 0.087 },
    emoji: null,
  });
  const { nodes } = await eng.tree();
  Assert.deepEqual(nodes[ws].appearance.color, custom, "the Workspace's");
  Assert.equal(nodes[ws].appearance.transparency, 0.4, "and how see-through");
  Assert.equal(nodes[group].kind, GROUP);
  Assert.deepEqual(
    nodes[group].appearance.color,
    { h: 123.4, c: 0.087 },
    "the group's"
  );
  Assert.deepEqual(
    SvalColor.colorOf(nodes[ws].appearance.color, "workspace"),
    custom,
    "and each reads back as a colour this build draws"
  );
  await Assert.rejects(
    eng.mutate({
      kind: "setAppearance",
      id: group,
      color: custom,
      emoji: null,
    }),
    err => err.reason === "bad_color",
    "a Workspace's shape on a group is refused"
  );
});

add_task(async function a_pairing_code_uses_the_backup_alphabet() {
  const eng = await engine();
  // Each code draws its characters uniformly from the engine's alphabet, so
  // a hundred of them leave any one of its characters out with a chance
  // under 1e-15.
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const code = await eng.generatePairingCode();
    Assert.equal(normalizeCode(code), code, "a code is canonical as given");
    for (const character of code.replaceAll("-", "")) {
      seen.add(character);
    }
  }
  Assert.deepEqual(
    [...seen].sort(),
    [...BACKUP_ALPHABET].sort(),
    "the engine's codes use the characters normalizeCode accepts"
  );
});
