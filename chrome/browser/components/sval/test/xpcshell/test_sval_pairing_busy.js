/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from pairing_head.js */

/**
 * An offer goes only into a folder that holds `sval/`. An empty directory may
 * be a mount point that is not mounted, and an offer there would make `sval/`
 * on this machine for the next sync step to publish into. Nothing is written,
 * and the failure says why.
 */
add_task(async function an_offer_never_makes_sval() {
  const root = await emptyRoot();
  await Assert.rejects(
    SvalPairing.offer(root, crypto.getRandomValues(new Uint8Array(32))),
    e => e.reason == "no-sval-dir"
  );
  Assert.deepEqual(
    await IOUtils.getChildren(root),
    [],
    "the folder is still empty"
  );

  await IOUtils.makeDirectory(PathUtils.join(root, TOP_DIR));
  const { path } = await SvalPairing.offer(
    root,
    crypto.getRandomValues(new Uint8Array(32))
  );
  Assert.ok(await IOUtils.exists(path), "with sval/ there, the offer is made");
});

/**
 * Pairing's requests made while another request holds the helper wait their
 * turn, and each then does what it was asked.
 */
add_task(async function requests_behind_another_wait_their_turn() {
  const { SvalSharedFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
  );
  const root = await freshRoot();
  const { path } = await SvalPairing.offer(
    root,
    crypto.getRandomValues(new Uint8Array(32))
  );
  const ahead = () =>
    SvalSharedFolder.exists({
      root,
      path: "sval",
      deadline: Date.now() + 20000,
    });

  let holder = ahead();
  Assert.deepEqual(
    await SvalPairing.claim(root, "ABCDEFGHJKMN"),
    { status: "no-match" },
    "a claim behind it reads the offer, which this code does not open"
  );
  await holder;

  holder = ahead();
  const offered = await SvalPairing.offer(
    root,
    crypto.getRandomValues(new Uint8Array(32))
  );
  Assert.ok(await IOUtils.exists(offered.path), "an offer is written");
  await holder;

  holder = ahead();
  Assert.strictEqual(
    await SvalPairing.stillOffered(path),
    true,
    "a check reads the folder"
  );
  await holder;

  holder = ahead();
  await SvalPairing.withdraw(path);
  Assert.ok(!(await IOUtils.exists(path)), "and a withdrawal removes it");
  await holder;
});
