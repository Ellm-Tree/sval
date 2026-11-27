/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pairing_helpers.js */

/**
 * Pairing through Sval's settings page, from the offering side: the offer a
 * code names, what the page says about it, and the offer going when the
 * code is used or the page closes (spec §6.7, messages spec §7). The file
 * shares a fresh profile with `browser_sval_pairing_withdrawal.js`
 * (browser-pairing-offer.toml), since sharing makes the profile a sync key.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pairing_helpers.js",
  this
);

const { SvalPairing } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
);

/**
 * An offer is a key sitting in a folder other people can read. The page that
 * made it is the only thing watching it, so closing that page has to take it
 * back out.
 */
add_task(async function closing_the_page_withdraws_the_offer() {
  const us = await thisDevice("close");
  const ui = await openSettingsPage("offer");

  await showACode(ui);
  const path = ui.settings._offer.path;
  Assert.ok(
    await IOUtils.exists(path),
    `the offer is in ${us.root} while the page is open`
  );
  // Cancel code is drawn as the code's other action, Copy, is: an outlined
  // button in the page's ink.
  const win = ui.page.document.defaultView;
  const withdraw = win.getComputedStyle(ui.els.offerWithdraw);
  const copy = win.getComputedStyle(
    ui.page.document.getElementById("sval-offer-copy")
  );
  Assert.ok(
    BrowserTestUtils.isVisible(ui.els.offerWithdraw),
    "Cancel code shows"
  );
  for (const property of ["border-top-color", "color", "background-color"]) {
    Assert.equal(
      withdraw.getPropertyValue(property),
      copy.getPropertyValue(property),
      `Cancel code has Copy's ${property}`
    );
  }

  BrowserTestUtils.removeTab(ui.tab);

  await TestUtils.waitForCondition(
    async () => !(await IOUtils.exists(path)),
    "closing the page took the offer back out of the shared folder"
  );
});

/**
 * An offer goes only into a folder that holds `sval/`. Without it the folder
 * may be a share that is not mounted, so nothing is written and the page says
 * it cannot find the folder.
 */
add_task(async function an_offer_into_a_folder_without_sval_writes_nothing() {
  const us = await thisDevice("offer-unmarked");
  await SvalSharedFolder._whenIdle();
  await IOUtils.remove(PathUtils.join(us.root, "sval"), { recursive: true });
  const ui = await openSettingsPage("offer");
  ui.els.pairingOpen.click();
  await TestUtils.waitForCondition(
    () => ui.els.offerStatus.dataset.said?.startsWith("folder-"),
    "the page said something about the offer"
  );
  Assert.equal(
    ui.els.offerStatus.dataset.said,
    "folder-gone",
    "it cannot find the folder"
  );
  Assert.equal(ui.settings._offer, null, "no offer was made");
  Assert.equal(ui.els.offerCode.value, "", "and no code is shown");
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(us.root, "sval"))),
    "and nothing was written into the folder"
  );
  BrowserTestUtils.removeTab(ui.tab);
});

/**
 * The offering page notices when its code has been used.
 *
 * The adopting device deletes the offer once it has stored the key, and
 * nothing tells the device that made it. Without a check, that page would go
 * on showing a live code and a running countdown for the rest of the hour,
 * and a third device typing that code would wait forever. The other device's
 * delete waits its turn behind other folder work, and the page shows no
 * error on the way.
 *
 * The one task that waits out the page's check of its offer
 * (`CLAIM_POLL_MS`).
 */
add_task(async function the_offering_page_says_when_its_code_has_been_used() {
  const us = await thisDevice("used");
  const ui = await openSettingsPage("offer");
  await showACode(ui);
  const path = ui.settings._offer.path;

  // What the other device does at the end of a successful adoption, behind
  // Sval's own folder work.
  const other = anotherRequest(us.root);
  await SvalPairing.withdraw(path);
  await within(other, 20_000, "the other request");

  await TestUtils.waitForCondition(
    () => ui.els.offerStatus.dataset.said === "used",
    "the page says the code has been used",
    250,
    80
  );
  Assert.equal(ui.settings._offer, null, "the page holds no offer");
  Assert.equal(ui.settings._countdown, null, "and the countdown stopped");
  Assert.equal(ui.els.offerCode.value, "", "and no code is on screen");
  Assert.ok(
    BrowserTestUtils.isVisible(ui.els.pairingOpen) &&
      !ui.els.pairingOpen.disabled,
    "and a new code can be shown, for a third device"
  );

  BrowserTestUtils.removeTab(ui.tab);
});
