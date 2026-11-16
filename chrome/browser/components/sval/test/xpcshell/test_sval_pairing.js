/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from pairing_head.js */

/**
 * A claim hands over the key and leaves the offer where it is.
 *
 * Deleting it belongs to the caller, once the adopted key is persisted
 * (`SvalPanel.adoptKey`): an adoption abandoned before that has changed
 * nothing, and the user must be able to retry with the code they already
 * have instead of fetching a fresh one over a channel §6.4 measures in tens
 * of minutes. The retry depends on claiming twice with the same code.
 */
add_task(async function an_offer_survives_its_claim_so_a_retry_can_use_it() {
  const root = await freshRoot();
  const key = crypto.getRandomValues(new Uint8Array(32));

  const offer = await SvalPairing.offer(root, key, Date.now());
  Assert.equal(offer.code.length, 14, "a grouped twelve-character code");
  Assert.ok(
    await IOUtils.exists(offer.path),
    "the sealed file is in the folder"
  );

  const claimed = await SvalPairing.claim(root, offer.code, Date.now());
  Assert.equal(claimed.status, "claimed", "a matching code claims the offer");
  Assert.deepEqual(
    Array.from(claimed.keyBytes),
    Array.from(key),
    "the second device gets the first device's key"
  );
  Assert.ok(
    await IOUtils.exists(offer.path),
    "and the offer is still there, because the adopter withdraws it"
  );

  const again = await SvalPairing.claim(root, offer.code, Date.now());
  Assert.equal(again.status, "claimed", "so the same code claims it again");
  Assert.deepEqual(
    Array.from(again.keyBytes),
    Array.from(key),
    "with the same key, which is what makes a failed adoption retryable"
  );

  await SvalPairing.withdraw(offer.path);
  Assert.ok(
    !(await IOUtils.exists(offer.path)),
    "and withdrawing is what finally consumes it"
  );

  await IOUtils.remove(root, { recursive: true });
});

/**
 * The expiry window is one hour, a product-owner decision: long enough to
 * survive one missed poll of a SharePoint-backed folder (spec §6.4's
 * ~30-minute figure). This pins the exact duration of `PAIRING_TTL_MS`.
 */
add_task(async function an_offer_expires_after_exactly_one_hour() {
  const root = await freshRoot();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const start = Date.now();

  const offer = await SvalPairing.offer(
    root,
    crypto.getRandomValues(new Uint8Array(32)),
    start
  );
  Assert.equal(
    offer.expiresAt,
    start + ONE_HOUR_MS,
    "the offer reports an expiry exactly one hour out"
  );

  const stillGood = await SvalPairing.claim(
    root,
    offer.code,
    start + ONE_HOUR_MS - 1
  );
  Assert.equal(
    stillGood.status,
    "claimed",
    "claimable one millisecond before the hour is up"
  );

  const secondOffer = await SvalPairing.offer(
    root,
    crypto.getRandomValues(new Uint8Array(32)),
    start
  );
  const tooLate = await SvalPairing.claim(
    root,
    secondOffer.code,
    start + ONE_HOUR_MS
  );
  Assert.equal(
    tooLate.status,
    "waiting",
    "expired at exactly the hour mark — and honestly reported as " +
      `"waiting", not "no-match": the code was never actually tried`
  );

  await IOUtils.remove(root, { recursive: true });
});

/**
 * A wrong code against a live candidate is the one case that means "that
 * code does not work": `no-match`.
 */
add_task(async function a_wrong_code_yields_no_match_and_deletes_nothing() {
  const root = await freshRoot();
  const key = crypto.getRandomValues(new Uint8Array(32));

  const offer = await SvalPairing.offer(root, key, Date.now());

  const claimed = await SvalPairing.claim(root, "WRNG-CODE-0000", Date.now());
  Assert.equal(
    claimed.status,
    "no-match",
    "a live candidate rejected the wrong code"
  );
  Assert.ok(
    await IOUtils.exists(offer.path),
    "and the offer is still there to try again"
  );

  await IOUtils.remove(root, { recursive: true });
});

/**
 * An expired offer is not a candidate. The answer is `"waiting"`: the
 * user's code may be right, and the offer timed out before it was claimed.
 * `"no-match"` would tell someone their correct code was wrong.
 */
add_task(async function an_expired_offer_reads_as_waiting_not_no_match() {
  const root = await freshRoot();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const code = "K7Q4-8MTZ-3RJW";
  const now = Date.now();

  await sealDirect(root, key, code, now, -1000);

  const claimed = await SvalPairing.claim(root, code, now);
  Assert.equal(
    claimed.status,
    "waiting",
    "an expired offer is reported as waiting, even though the code is right"
  );

  await IOUtils.remove(root, { recursive: true });
});

/**
 * An empty pairing folder, the ordinary state for the tens of minutes a slow
 * provider takes to deliver a first device's offer (spec §6.7), reads as
 * `"waiting"`: nothing has been tried yet, so nothing can be reported as
 * wrong.
 */
add_task(async function an_empty_folder_reads_as_waiting() {
  const root = await freshRoot();

  const claimed = await SvalPairing.claim(root, "K7Q4-8MTZ-3RJW", Date.now());
  Assert.equal(
    claimed.status,
    "waiting",
    "no folder, and therefore no candidate, at all"
  );

  await IOUtils.remove(root, { recursive: true });
});

/**
 * Junk in the folder, such as a `.DS_Store` or a half-synced leftover, is not
 * a candidate either, and produces no `"no-match"`: nothing this call could
 * put a code to was ever there.
 */
add_task(
  async function a_directory_holding_only_junk_reads_as_waiting_not_no_match() {
    const root = await freshRoot();
    const dir = pairDir(root);

    await IOUtils.makeDirectory(dir);
    await IOUtils.writeUTF8(
      PathUtils.join(dir, "not-a-pairing-file.json"),
      "this is not a sealed sval document"
    );
    await IOUtils.writeUTF8(PathUtils.join(dir, ".DS_Store"), "junk");

    const claimed = await SvalPairing.claim(root, "K7Q4-8MTZ-3RJW", Date.now());
    Assert.equal(
      claimed.status,
      "waiting",
      "junk is not a candidate, so this is indistinguishable from empty"
    );

    await IOUtils.remove(root, { recursive: true });
  }
);

add_task(async function claim_survives_a_directory_holding_junk() {
  const root = await freshRoot();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const dir = pairDir(root);

  await IOUtils.makeDirectory(dir);
  // A half-synced file, a stray artefact a cloud client left behind: neither
  // JSON nor a sealed pairing file.
  await IOUtils.writeUTF8(
    PathUtils.join(dir, "not-a-pairing-file.json"),
    "this is not a sealed sval document"
  );
  await IOUtils.writeUTF8(PathUtils.join(dir, ".DS_Store"), "junk");

  const offer = await SvalPairing.offer(root, key, Date.now());
  const claimed = await SvalPairing.claim(root, offer.code, Date.now());

  Assert.equal(claimed.status, "claimed", "the good offer was still found");
  Assert.deepEqual(
    Array.from(claimed.keyBytes),
    Array.from(key),
    "and its key recovered"
  );

  await IOUtils.remove(root, { recursive: true });
});
