/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from pairing_head.js */

add_task(async function offering_twice_leaves_two_independent_offers() {
  const root = await freshRoot();
  const keyA = crypto.getRandomValues(new Uint8Array(32));
  const keyB = crypto.getRandomValues(new Uint8Array(32));

  const offerA = await SvalPairing.offer(root, keyA, Date.now());
  const offerB = await SvalPairing.offer(root, keyB, Date.now());

  Assert.notEqual(offerA.path, offerB.path, "two independent filenames");

  const children = await IOUtils.getChildren(pairDir(root));
  Assert.equal(children.length, 2, "both offers are on disk at once");

  const claimedA = await SvalPairing.claim(root, offerA.code, Date.now());
  Assert.equal(claimedA.status, "claimed");
  Assert.deepEqual(Array.from(claimedA.keyBytes), Array.from(keyA));
  Assert.ok(
    await IOUtils.exists(offerB.path),
    "claiming one offer leaves the other untouched"
  );

  const claimedB = await SvalPairing.claim(root, offerB.code, Date.now());
  Assert.equal(claimedB.status, "claimed");
  Assert.deepEqual(Array.from(claimedB.keyBytes), Array.from(keyB));

  await IOUtils.remove(root, { recursive: true });
});

add_task(async function sweep_removes_expired_offers_and_spares_live_ones() {
  const root = await freshRoot();
  const now = Date.now();

  const expiredPath = await sealDirect(
    root,
    crypto.getRandomValues(new Uint8Array(32)),
    "K7Q4-8MTZ-3RJW",
    now,
    -1000
  );
  const live = await SvalPairing.offer(
    root,
    crypto.getRandomValues(new Uint8Array(32)),
    now
  );

  await SvalPairing.sweep(root, now);

  Assert.ok(
    !(await IOUtils.exists(expiredPath)),
    "the expired offer was swept"
  );
  Assert.ok(await IOUtils.exists(live.path), "the live offer was spared");

  await IOUtils.remove(root, { recursive: true });
});

/**
 * An unreachable folder is "waiting", never "wrong code", and an offer whose
 * folder does not answer is neither there nor gone.
 */
add_task(async function an_unreachable_folder_is_waiting_not_wrong() {
  const missing = tempPath("sval-pair-missing");
  Assert.deepEqual(await SvalPairing.claim(missing, "ABCDEFGHJKMN"), {
    status: "waiting",
  });
  Assert.strictEqual(
    await SvalPairing.stillOffered(
      PathUtils.join(missing, "sval", "pair", "x.json")
    ),
    null
  );
  await Assert.rejects(
    SvalPairing.offer(missing, crypto.getRandomValues(new Uint8Array(32))),
    /shared folder is unavailable/
  );
});

/** An offer is there until it is withdrawn, and then it is gone. */
add_task(async function still_offered_follows_the_file() {
  const root = await freshRoot();
  const { path } = await SvalPairing.offer(
    root,
    crypto.getRandomValues(new Uint8Array(32))
  );
  Assert.strictEqual(await SvalPairing.stillOffered(path), true);
  await SvalPairing.withdraw(path);
  Assert.strictEqual(await SvalPairing.stillOffered(path), false);
});

/**
 * A live offer in a folder never published into, unmounted while a sync step
 * writes `sval/` into the bare mount point and then mounted again: the offer
 * is never read as used.
 */
add_task(async function an_unmount_and_remount_never_reads_as_used() {
  const root = await freshRoot();
  const { path } = await SvalPairing.offer(
    root,
    crypto.getRandomValues(new Uint8Array(32))
  );
  const volume = `${root}-volume`;
  await IOUtils.move(PathUtils.join(root, "sval"), volume);
  await IOUtils.makeDirectory(PathUtils.join(root, "sval", "ws"));
  Assert.strictEqual(
    await SvalPairing.stillOffered(path),
    null,
    "unmounted, with a step's sval/ in the mount point, nothing is said"
  );

  await IOUtils.remove(PathUtils.join(root, "sval"), { recursive: true });
  await IOUtils.move(volume, PathUtils.join(root, "sval"));
  Assert.strictEqual(
    await SvalPairing.stillOffered(path),
    true,
    "mounted again, the offer is there"
  );
  await SvalPairing.withdraw(path);
});

add_task(async function pairing_reaches_the_folder_only_through_the_helper() {
  const response = await fetch(
    "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
  );
  Assert.ok(response.ok, "the module is where it is expected to be");
  Assert.ok(
    !/\bIOUtils\./.test(await response.text()),
    "SvalPairing calls no IOUtils"
  );
});

/**
 * A folder without `sval/pair/` is not evidence that an offer was taken: an
 * unmounted mount point looks like that, with or without a `sval/` in it.
 * With `sval/pair/` present, an offer that is not in it is gone.
 */
add_task(async function an_offer_is_gone_only_from_a_folder_with_a_pair_dir() {
  const root = await emptyRoot();
  const offer = PathUtils.join(pairDir(root), "x.json");
  Assert.strictEqual(
    await SvalPairing.stillOffered(offer),
    null,
    "an empty folder says nothing"
  );
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(root, "sval"))),
    "and asking created nothing"
  );

  await IOUtils.makeDirectory(PathUtils.join(root, "sval", "ws"));
  Assert.strictEqual(
    await SvalPairing.stillOffered(offer),
    null,
    "nor does a folder whose sval/ holds no sval/pair/"
  );

  await IOUtils.makeDirectory(pairDir(root));
  Assert.strictEqual(
    await SvalPairing.stillOffered(offer),
    false,
    "sval/pair/ without the offer in it holds no offer"
  );
});
