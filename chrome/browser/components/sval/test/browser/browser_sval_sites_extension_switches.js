/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * Settings › Sites and extension switches saved for a site or an address
 * (host-scoped rules spec §5): a switch gives its name a row, the row's
 * Reset takes it and Undo puts it back, a site's Reset leaves an address's
 * switch, and Forget counts switches with the synced choices.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const { SvalExtensionSites, SITE_BRANCH: EXTENSION_BRANCH } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
  );
const { SvalJavascript, SITE_BRANCH: JS_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalJavascript.sys.mjs"
);

// No page is ever served from these names, and no extension has this id,
// so the switches reach no tab and no extension.
const SITE = "sval-switches-test.com";
const HOST = `app.${SITE}`;
const ID = "sval-switch-test@example.com";

function reset() {
  clearPrefBranches(EXTENSION_BRANCH, JS_BRANCH);
}

add_setup(function () {
  registerCleanupFunction(reset);
});

async function openSites() {
  const { page } = await openAt("about:preferences#svalSites");
  const ui = partsOf(page);
  await until(ui.sitesShown, "the Sites list showing");
  return ui;
}

function rowOf(ui, name) {
  return ui.doc.querySelector(`#sval-sites-body [data-site="${name}"]`);
}

function differs(ui, name) {
  return rowOf(ui, name)?.querySelector(".sval-sites-summary").dataset.differs;
}

add_task(async function a_switch_alone_gives_an_address_a_row() {
  reset();
  await SvalExtensionSites.setOff(ID, HOST, true);
  const ui = await openSites();
  await until(() => rowOf(ui, HOST), "the address's row");
  is(differs(ui, HOST), `extension:${ID}:off`, "naming its switch");
  is(rowOf(ui, HOST).dataset.parent, SITE, "under its site");
  ok(rowOf(ui, HOST).querySelector(".sval-sites-reset"), "with a Reset");

  change(ui.byId("sval-sites-filter"), "extensions");
  await until(
    () => rowOf(ui, HOST) && rowOf(ui, SITE),
    "the filter keeping the address and its site"
  );
});

add_task(async function reset_takes_a_switch_and_undo_puts_it_back() {
  reset();
  await SvalExtensionSites.setOff(ID, SITE, true);
  await SvalExtensionSites.setOff(ID, HOST, false);
  const ui = await openSites();
  await until(() => rowOf(ui, HOST), "the address's row");
  is(differs(ui, HOST), `extension:${ID}:on`, "on where its site is off");

  rowOf(ui, HOST).querySelector(".sval-sites-reset").click();
  await until(() => !rowOf(ui, HOST), "the address's row going");
  is(SvalExtensionSites.ruleFor(ID, HOST), undefined, "its switch went");
  ok(SvalExtensionSites.isOff(ID, HOST), "so it follows its site");

  ui.byKey("sites-undo").click();
  await until(() => rowOf(ui, HOST), "Undo bringing the row back");
  is(SvalExtensionSites.ruleFor(ID, HOST), "on", "with its switch");
});

add_task(async function a_sites_reset_leaves_its_addresss_switch() {
  reset();
  SvalJavascript.setEnabled(SITE, false);
  await SvalExtensionSites.setOff(ID, SITE, true);
  await SvalExtensionSites.setOff(ID, HOST, false);
  const ui = await openSites();
  await until(() => rowOf(ui, HOST), "the address's row");
  rowOf(ui, SITE).querySelector(".sval-sites-reset").click();
  await until(
    () => rowOf(ui, SITE)?.querySelector(".sval-sites-summary").dataset.own,
    "the site left with no choices of its own"
  );
  is(SvalExtensionSites.ruleFor(ID, SITE), undefined, "the site's went");
  ok(!SvalJavascript.rules().has(SITE), "with its other choices");
  is(
    SvalExtensionSites.ruleFor(ID, HOST),
    "on",
    "the address keeps its switch"
  );

  ui.byKey("sites-undo").click();
  await until(
    () => SvalExtensionSites.ruleFor(ID, SITE) === "off",
    "Undo putting the site's switch back"
  );
});

add_task(async function forget_counts_switches_with_the_synced_choices() {
  reset();
  await SvalExtensionSites.setOff(ID, SITE, true);
  await SvalExtensionSites.setOff(ID, HOST, false);
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const forget = () => ui.byKey("site-forget");
  await until(() => forget() && !forget().disabled, "Forget… live");
  forget().click();
  const choices = () =>
    ui.doc.querySelector(
      '.sval-forget-group[data-device="every"] .sval-forget-row[data-part="choices"]'
    );
  await until(choices, "the confirm listing the choices");
  is(
    choices().querySelector(".sval-forget-count").textContent,
    "2",
    "the site's switch and its address's"
  );
  ui.byId("sval-blocking-dialog-cancel").click();
});
