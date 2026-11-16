/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from pairing_head.js */

/**
 * A well-formed offer Sval did not write: anyone who can write to the shared
 * folder can seal one under a code of their own and give it any expiry, since
 * the expiry is read without the code. Thirty days out is far past any offer
 * Sval writes.
 *
 * @param {string} root Absolute path of the storage folder.
 * @param {number} now Milliseconds since the epoch.
 * @returns {Promise<string>} The forgery's path.
 */
function forge(root, now) {
  return sealDirect(
    root,
    crypto.getRandomValues(new Uint8Array(32)),
    "K7Q4-8MTZ-3RJW",
    now,
    30 * 24 * 60 * 60 * 1000
  );
}

/**
 * With a forgery in the folder, the user's right code still pairs once the
 * real offer arrives, and before it arrives they are told to wait, never that
 * their code is wrong (spec §6.7).
 */
add_task(async function a_forged_offer_never_makes_a_right_code_look_wrong() {
  const root = await freshRoot();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const now = Date.now();
  await forge(root, now);

  const code = "ABCD-EFGH-JKMN";
  Assert.deepEqual(
    await SvalPairing.claim(root, code, now),
    { status: "waiting" },
    "before the real offer arrives, the user is told to wait"
  );

  const offer = await SvalPairing.offer(root, key, now);
  const claimed = await SvalPairing.claim(root, offer.code, now);
  Assert.equal(claimed.status, "claimed", "the real offer pairs");
  Assert.deepEqual(
    Array.from(claimed.keyBytes),
    Array.from(key),
    "with the offering device's key"
  );

  await IOUtils.remove(root, { recursive: true });
});

/** Any device that sees a forgery removes it, and spares the real offer. */
add_task(async function sweep_removes_a_forged_offer() {
  const root = await freshRoot();
  const now = Date.now();
  const forged = await forge(root, now);
  const live = await SvalPairing.offer(
    root,
    crypto.getRandomValues(new Uint8Array(32)),
    now
  );

  await SvalPairing.sweep(root, now);

  Assert.ok(!(await IOUtils.exists(forged)), "the forgery was swept");
  Assert.ok(await IOUtils.exists(live.path), "the real offer was spared");

  await IOUtils.remove(root, { recursive: true });
});
