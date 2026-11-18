/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pairing_helpers.js */

/**
 * This device joining another device's document (spec §6.7), through the
 * whole chain the user meets: an offer the other device writes into the
 * shared folder, a code this device's user types, and this device re-keyed
 * onto what the code opened.
 *
 * The claim under test is the spec's "a device that already has workspaces
 * keeps them". The key names the directory, `syncPrefix` being a hash of it,
 * so a device holding the wrong key does not fail loudly: it reads a
 * directory nobody writes to and shows an empty browser. A join that fails
 * leaves nothing of the other document behind, so a failed pairing cannot
 * graft one document's workspaces onto another's.
 *
 * These tasks change the profile's stored key, so the file runs on a fresh
 * profile of its own (browser-pairing-join.toml). Each task takes "this
 * device's own key" to be whatever is stored when it begins.
 * `browser_sval_pairing_join_first.js` is a device that never shared.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pairing_helpers.js",
  this
);

const { SvalPairing } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

/**
 * A device with a workspace of its own joins with a code from a device whose
 * workspace is already in the folder, and both survive, on both devices.
 */
add_task(async function adopting_a_key_keeps_this_devices_workspaces() {
  const us = await thisDevice("keeps");
  const theirKey = randomBytes(32);
  const them = await peerPublishing(
    us.root,
    theirKey,
    "Made on the other device"
  );
  await SvalSharedFolder._whenIdle();
  const { code, path } = await SvalPairing.offer(us.root, theirKey);

  const { ui, outcome, said } = await joinWithCode(code);
  Assert.equal(outcome, "adopted", "the panel adopted the key");
  Assert.equal(said, "joined", "in the one sentence that means it");
  BrowserTestUtils.removeTab(ui.tab);

  const ours = Object.keys(await nodes(us.engine));
  Assert.ok(ours.includes(us.workspace), "this device's workspace survived");
  Assert.ok(ours.includes(us.tab), "and the tab under it");
  Assert.ok(ours.includes(them.id), "and the other device's workspace arrived");

  // A window shows one workspace (spec §10.7): this device's own tab is a row,
  // and both workspaces are reachable through the switcher.
  Assert.ok(
    SvalPanel._rowElementFor(us.tab),
    "this device's tab is a row the panel draws"
  );
  Assert.deepEqual(
    SvalPanelModel.switcherItems(
      SvalPanel.nodes,
      SvalWindowWorkspace.of(window).id
    )
      .map(item => item.id)
      .filter(id => id === us.workspace || id === them.id)
      .sort(),
    [us.workspace, them.id].sort(),
    "and neither workspace is out of reach"
  );

  const children = await IOUtils.getChildren(them.directory);
  Assert.equal(
    children.length,
    2,
    `one file per device in the directory the adopted key names: ${children.join(", ")}`
  );
  await them.engine.sync(SYNC_DOCUMENT, Date.now());
  const theirs = await nodes(them.engine);
  Assert.ok(
    us.workspace in theirs && us.tab in theirs,
    "and the device whose key it was holds this device's tree"
  );

  await within(SvalSharedFolder._whenIdle(), 20_000, "the withdrawal");
  Assert.ok(
    !(await IOUtils.exists(path)),
    "the offer is withdrawn once the key is stored, so nobody else can claim it"
  );
  SvalIdentity.forgetCachedValues();
  Assert.deepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(theirKey),
    "a restart would read the adopted key, not generate a third one"
  );
});

/**
 * A code that is not the offered one adopts nothing and moves nothing. The
 * seal is the checksum (spec §6.7), so a wrong code never reaches a join.
 */
add_task(async function a_wrong_code_changes_nothing_at_all() {
  const us = await thisDevice("wrong");
  const theirKey = randomBytes(32);
  const them = await peerPublishing(us.root, theirKey, "Not this device's");
  await SvalSharedFolder._whenIdle();
  const { code, path } = await SvalPairing.offer(us.root, theirKey);
  // Right shape, right alphabet, 60 bits away from the offered one.
  const wrong = code.startsWith("A")
    ? `B${code.slice(1)}`
    : `A${code.slice(1)}`;

  const { ui, outcome, said } = await joinWithCode(wrong);
  Assert.equal(said, "no-match", "a wrong code against a real offer is wrong");
  Assert.equal(outcome, undefined, "and no join was tried");
  BrowserTestUtils.removeTab(ui.tab);

  Assert.deepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(us.ourKey),
    "the stored key is untouched"
  );
  Assert.ok(
    await IOUtils.exists(path),
    "the offer is still in the folder for the right code to open"
  );
  const ours = await nodes(us.engine);
  Assert.ok(!(them.id in ours), "this device holds nothing of theirs");
  Assert.equal(
    (await IOUtils.getChildren(them.directory)).length,
    1,
    "and has published nothing into the other device's directory"
  );
});

/**
 * Joining the document this device is already on is a merge and nothing
 * more. A user meets it by pressing the button twice, and a provider that
 * delivers the same folder twice produces it on its own.
 */
add_task(async function adopting_twice_is_harmless() {
  const us = await thisDevice("twice");
  const theirKey = randomBytes(32);
  const them = await peerPublishing(us.root, theirKey, "Theirs");
  await SvalSharedFolder._whenIdle();
  const first = await SvalPairing.offer(us.root, theirKey);
  let joined = await joinWithCode(first.code);
  Assert.equal(joined.outcome, "adopted", "adopted once");
  // The settings page's tab is a tab of the window's workspace, and its node
  // goes once the observer has filed the close.
  BrowserTestUtils.removeTab(joined.ui.tab);
  await within(SvalPanel.observer.settled(), 10_000, "the close filed");
  const after = Object.keys(await nodes(us.engine)).sort();

  Assert.equal(
    await SvalIdentity.adoptSyncKey(theirKey),
    false,
    "storing the same key again reports that nothing changed"
  );
  await SvalSharedFolder._whenIdle();
  const again = await SvalPairing.offer(us.root, theirKey);
  joined = await joinWithCode(again.code);
  Assert.equal(joined.outcome, "adopted", "a second join of the same key");
  BrowserTestUtils.removeTab(joined.ui.tab);
  await within(SvalPanel.observer.settled(), 10_000, "the close filed");
  await within(SvalSharedFolder._whenIdle(), 20_000, "the withdrawal");
  Assert.ok(
    !(await IOUtils.exists(again.path)),
    "with the second offer withdrawn like the first"
  );
  Assert.deepEqual(
    Object.keys(await nodes(us.engine)).sort(),
    after,
    "the tree is what it was"
  );
  Assert.equal(
    (await IOUtils.getChildren(them.directory)).length,
    2,
    "still one file per device, with no third file minted"
  );
});

/**
 * Re-keying is not a new installation (spec §6.7). Every watermark this
 * device's peers hold is keyed on its device id, so an id that changed with
 * the key would stop this device's deletions from ever propagating again.
 */
add_task(async function the_device_id_does_not_change_when_the_key_does() {
  const us = await thisDevice("device-id");
  const before = await SvalIdentity.deviceId();
  const theirKey = randomBytes(32);
  await peerPublishing(us.root, theirKey, "Theirs");
  await SvalSharedFolder._whenIdle();
  const { code } = await SvalPairing.offer(us.root, theirKey);
  const { ui, outcome } = await joinWithCode(code);
  Assert.equal(outcome, "adopted", "the key was adopted");
  BrowserTestUtils.removeTab(ui.tab);
  SvalIdentity.forgetCachedValues();
  Assert.notDeepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(us.ourKey),
    "so the key this device uses did change"
  );
  Assert.deepEqual(
    asArray(await SvalIdentity.deviceId()),
    asArray(before),
    "while the device id a restart reads is the one from before the join"
  );
});

/**
 * A join the folder refuses leaves this device exactly where it was, with
 * nothing of the other device's on it and nothing of its own in the other
 * document, and the same code joins once the folder takes it.
 *
 * The other document's directory refuses this device's file, as a provider
 * that refuses a write does: the publish comes after the join has merged the
 * other device's tree, the point where a join has something of theirs in
 * hand. A peer on this device's own key is the witness: had anything of the
 * other document reached this device, the next pass would publish it there.
 */
add_task(async function a_failed_join_changes_nothing_and_can_be_retried() {
  const us = await thisDevice("failed-join");
  const theirKey = randomBytes(32);
  const them = await peerPublishing(us.root, theirKey, "Theirs");
  const onOurKey = new SvalEngine({
    root: us.root,
    keyBytes: us.ourKey,
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(onOurKey));
  await SvalSharedFolder._whenIdle();
  const { code, path } = await SvalPairing.offer(us.root, theirKey);

  await SvalTestDeny.write(them.directory);
  atTaskEnd(() => SvalTestDeny.allow(them.directory));
  const { ui, outcome, said } = await joinWithCode(code);
  Assert.equal(outcome, "unchanged", "the join did not happen");
  Assert.equal(said, "folder", "and the folder is said to be what stopped it");
  const retry = ui.els.claimActions.querySelector("button");
  Assert.ok(retry, "with a way to try again");

  Assert.ok(
    !(them.id in (await nodes(us.engine))),
    "this device holds nothing of theirs"
  );
  Assert.deepEqual(
    asArray(us.engine.syncKey),
    asArray(us.ourKey),
    "it is still syncing under its own key"
  );
  SvalIdentity.forgetCachedValues();
  Assert.deepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(us.ourKey),
    "and a restart would read its own key"
  );
  Assert.ok(await IOUtils.exists(path), "the code still works");
  await TestUtils.waitForCondition(
    async () => (await SvalPanel.syncWithFolder()) === "reached",
    "this device's pass on its own key"
  );
  await onOurKey.sync(SYNC_DOCUMENT, Date.now());
  const seenByPeer = await nodes(onOurKey);
  Assert.ok(us.workspace in seenByPeer, "this device's peers see its tree");
  Assert.ok(!(them.id in seenByPeer), "and nothing of the other document");
  Assert.equal(
    (await IOUtils.getChildren(them.directory)).length,
    1,
    "nothing of this device's is in the other document's folder"
  );

  await SvalTestDeny.allow(them.directory);
  retry.click();
  await TestUtils.waitForCondition(
    () => ui.els.claimStatus.dataset.outcome === "adopted",
    "Try Again joins with the same code",
    250,
    120
  );
  BrowserTestUtils.removeTab(ui.tab);
  const ours = Object.keys(await nodes(us.engine));
  Assert.ok(ours.includes(us.workspace), "with this device's tree kept");
  Assert.ok(ours.includes(them.id), "and the other device's arrived");
  await within(SvalSharedFolder._whenIdle(), 20_000, "the withdrawal");
  Assert.ok(!(await IOUtils.exists(path)), "and only now is the offer gone");
});

/**
 * The store's file, which holds the profile's sync key
 * (`SvalSecretStore`'s default path).
 *
 * @returns {string}
 */
function secretsFile() {
  return (
    SvalSecretStore.path ??
    PathUtils.join(PathUtils.profileDir, "sval-secrets.json")
  );
}

/**
 * A join that published and whose key did not save is told truthfully: the
 * other device has this device's workspaces, which cannot be recalled, and
 * this device stays on its own key. The same code, tried again once the
 * store answers, joins without publishing again.
 *
 * The store's file refuses to be read, so the key cannot be written into
 * it, as a disk that refuses the file does.
 */
add_task(async function a_key_that_did_not_save_says_so_and_can_be_retried() {
  const us = await thisDevice("published");
  const theirKey = randomBytes(32);
  const them = await peerPublishing(us.root, theirKey, "Theirs");
  await SvalSharedFolder._whenIdle();
  const { code, path } = await SvalPairing.offer(us.root, theirKey);

  const secrets = secretsFile();
  await SvalTestDeny.read(secrets);
  atTaskEnd(() => SvalTestDeny.allow(secrets));
  const { ui, outcome, said } = await joinWithCode(code);
  await SvalTestDeny.allow(secrets);
  Assert.equal(outcome, "published", "the outcome says which half happened");
  Assert.equal(said, "key-store", "and that the key store refused the key");

  await them.engine.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(
    us.workspace in (await nodes(them.engine)),
    "the other device has this device's workspace"
  );
  Assert.deepEqual(
    asArray(us.engine.syncKey),
    asArray(us.ourKey),
    "this device is still on its own key"
  );
  SvalIdentity.forgetCachedValues();
  Assert.deepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(us.ourKey),
    "which is the one stored"
  );
  Assert.ok(
    !(them.id in (await nodes(us.engine))),
    "and holds nothing of the document it did not join"
  );
  Assert.ok(await IOUtils.exists(path), "the same code can finish the job");

  const retry = ui.els.claimActions.querySelector("button");
  Assert.ok(retry, "the page offers to try again");
  retry.click();
  await TestUtils.waitForCondition(
    () => ui.els.claimStatus.dataset.outcome === "adopted",
    "the retry joins",
    250,
    120
  );
  BrowserTestUtils.removeTab(ui.tab);
  SvalIdentity.forgetCachedValues();
  Assert.deepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(theirKey),
    "a restart would read the joined key"
  );
  const ours = Object.keys(await nodes(us.engine));
  Assert.ok(ours.includes(us.workspace), "this device's workspace is kept");
  Assert.ok(ours.includes(them.id), "and the other device's arrived");
  await within(SvalSharedFolder._whenIdle(), 20_000, "the withdrawal");
  Assert.ok(!(await IOUtils.exists(path)), "and the offer is withdrawn");
});

/**
 * An offer of the key this device already holds names a folder it may not
 * reach. A pass that fails is not reported as a join, and the offer that
 * lets the user retry is kept; with the folder back, the same offer joins.
 */
add_task(async function the_same_key_is_not_adopted_when_the_pass_fails() {
  const us = await thisDevice("samekey");
  const { path } = await offerAndClaim(us.root, us.ourKey);
  const bringBack = await folderAway(us.root);

  const result = await SvalPanel.adoptKey(us.ourKey, path);
  Assert.equal(result.outcome, "unchanged", "a failed pass is not a join");
  Assert.ok(!result.adopted, "and does not report itself as one");
  Assert.equal(shownReason(result), "folder", "told as the folder");

  await bringBack();
  Assert.ok(
    await IOUtils.exists(path),
    "the offer is left where it is, so the retry has something to open"
  );
  const again = await SvalPanel.adoptKey(us.ourKey, path);
  Assert.equal(again.outcome, "adopted", "with the folder back, it joins");
  await within(SvalSharedFolder._whenIdle(), 20_000, "the withdrawal");
  Assert.ok(
    !(await IOUtils.exists(path)),
    "and only then is the offer withdrawn"
  );
});

/**
 * A folder that went away between the claim and the join changes nothing,
 * and says so within the shared step's limit.
 */
add_task(async function pairing_with_an_unreachable_folder_changes_nothing() {
  const us = await thisDevice("unreachable-folder");
  const theirKey = randomBytes(32);
  await peerPublishing(us.root, theirKey, "Theirs");
  const { claimed, path } = await offerAndClaim(us.root, theirKey);
  await folderAway(us.root);

  const result = await within(
    SvalPanel.adoptKey(claimed.keyBytes, path),
    20_000,
    "the join's answer"
  );
  Assert.equal(result.outcome, "unchanged", "nothing changed, and it says so");
  Assert.equal(shownReason(result), "folder");
  Assert.deepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(us.ourKey),
    "the stored key is this device's own"
  );
});

/**
 * A join's publish, the read that confirms it and the offer's delete wait
 * their turn behind Sval's own folder work.
 */
add_task(async function an_adoption_behind_other_folder_work_is_adopted() {
  const us = await thisDevice("busy-publish");
  const theirKey = randomBytes(32);
  const them = await peerPublishing(us.root, theirKey, "Theirs");
  const { path, claimed } = await offerAndClaim(us.root, theirKey);

  const other = anotherRequest(us.root);
  const result = await SvalPanel.adoptKey(claimed.keyBytes, path);
  await within(other, 20_000, "the other request");
  Assert.equal(result.outcome, "adopted", `${result.message}`);
  Assert.equal(shownReason(result), "joined", "and says so");
  const kept = await nodes(us.engine);
  Assert.ok(us.workspace in kept, "this device's workspace is kept");
  Assert.ok(them.id in kept, "and the other device's is brought in");
  await within(SvalSharedFolder._whenIdle(), 20_000, "the withdrawal");
  Assert.ok(!(await IOUtils.exists(path)), "and the offer is deleted");
});
