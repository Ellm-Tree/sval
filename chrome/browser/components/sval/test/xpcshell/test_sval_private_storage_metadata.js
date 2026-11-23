/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A private origin's storage folder names no site
 * (quota-private-metadata-no-site.patch). The folder outlives a killed
 * process, and its `.metadata-v2` file held the origin's site and the site
 * the origin is partitioned under.
 */

const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

const SITE = "svalprivatesite";
const TOP_SITE = "svalprivatetop";

/**
 * @param {IDBRequest} request
 * @param {string} what
 * @returns {Promise<*>} The request's result.
 */
function done(request, what) {
  return within(
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
    15_000,
    what
  );
}

/**
 * @returns {Promise<string[]>} Every `.metadata-v2` under the profile's
 *   private storage, each read as Latin-1 text.
 */
async function privateMetadata() {
  const root = PathUtils.join(PathUtils.profileDir, "storage", "private");
  const texts = [];
  for (const folder of await IOUtils.getChildren(root)) {
    const file = PathUtils.join(folder, ".metadata-v2");
    if (await IOUtils.exists(file)) {
      const bytes = await IOUtils.read(file);
      texts.push(String.fromCharCode(...bytes));
    }
  }
  return texts;
}

add_task(async function a_private_origins_metadata_names_no_site() {
  do_get_profile();
  // A private origin's databases are encrypted with a key NSS makes, and
  // nothing else here starts NSS.
  Cc["@mozilla.org/psm;1"].getService(Ci.nsISupports);
  // A third-party origin in a private window: its origin attributes carry
  // the site of the page it is in.
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(`https://${SITE}.example`),
    {
      privateBrowsingId: 1,
      userContextId: 7,
      partitionKey: `(https,${TOP_SITE}.example)`,
    }
  );

  const opening = indexedDB.openForPrincipal(principal, "sval");
  opening.onupgradeneeded = () => opening.result.createObjectStore("store");
  let db = await done(opening, "the private database opening");
  const write = db.transaction("store", "readwrite");
  write.objectStore("store").put("kept", "key");
  await within(
    new Promise(resolve => (write.oncomplete = resolve)),
    15_000,
    "the write completing"
  );

  const texts = await privateMetadata();
  Assert.equal(texts.length, 1, "the private origin has one metadata file");
  Assert.ok(texts[0].includes("uuid://"), "which holds its storage origin");
  for (const name of [SITE, TOP_SITE]) {
    Assert.ok(!texts[0].includes(name), `and does not name ${name}`);
  }

  // The origin is read back from its storage origin, for as long as the
  // session lasts.
  db.close();
  db = await done(
    indexedDB.openForPrincipal(principal, "sval"),
    "the private database opening again"
  );
  Assert.equal(
    await done(
      db.transaction("store").objectStore("store").get("key"),
      "the read"
    ),
    "kept",
    "the origin's data reads back"
  );
  db.close();
});
