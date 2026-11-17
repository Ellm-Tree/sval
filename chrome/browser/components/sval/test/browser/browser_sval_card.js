/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

/**
 * Waits for the card dialog to open in this window with its card drawn.
 *
 * @returns {Promise<object>} the dialog and its document.
 */
async function cardDialogShown() {
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "the dialog opens");
  const dialog = gDialogBox.dialog;
  await dialogShown(dialog, "the card dialog's load");
  const doc = dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-mcard svg"),
    "the card shows"
  );
  atTaskEnd(async () => {
    if (gDialogBox.isOpen) {
      doc.querySelector(".sval-card-dialog-done").click();
      await TestUtils.waitForCondition(
        () => !gDialogBox.isOpen,
        "the dialog closes"
      );
    }
  });
  return { dialog, doc };
}

/**
 * The foot of the Settings nav shows the user's card, and clicking it opens
 * the card dialog: startup gave the profile a Sval card, and the dialog
 * shows it with its title and the glare lying over the card.
 */
add_task(async function the_settings_nav_opens_the_card() {
  // Wide enough that the nav shows its labels, and with them the card.
  const { outerWidth, outerHeight } = window;
  window.resizeTo(Math.max(outerWidth, 1200), outerHeight);
  registerCleanupFunction(() => window.resizeTo(outerWidth, outerHeight));
  await panelWithFolder(null);
  const ui = await openSettings();
  const button = () => ui.byId("sval-nav-card");
  await TestUtils.waitForCondition(
    () => button()?.querySelector("svg")?.checkVisibility(),
    "the nav shows the card"
  );
  Assert.equal(button().slot, "secondary-nav", "with the nav's footer links");
  Assert.ok(
    !ui.byId("sval-card-button").checkVisibility(),
    "its icon waits for a narrow nav"
  );
  button().click();
  const { doc } = await cardDialogShown();
  const card = JSON.parse(Services.prefs.getStringPref("browser.sval.card"));
  Assert.equal(card.arc, null, "a Sval card");
  Assert.ok(doc.querySelector("#sval-card-dialog-title").textContent);
  Assert.ok(
    doc.querySelector('[data-fact="arc"]').hidden,
    "no Arc line on a Sval card"
  );

  const box = doc.querySelector(".sval-mcard").getBoundingClientRect();
  const glare = doc.querySelector(".sval-mcard-glare").getBoundingClientRect();
  Assert.deepEqual(
    [glare.left, glare.top, glare.width, glare.height],
    [box.left, box.top, box.width, box.height],
    "the glare lies over the card"
  );
});

/**
 * Settings draws its card once `settings.css`, which carries `card.css`, has
 * applied. A page that inserts a sheet itself gets it at once only from
 * Gecko's shared sheet cache, so the cache is emptied first. Drawn earlier,
 * the glow's canvas would be laid out at its bitmap's size, and on a screen
 * of more than one device pixel to the CSS pixel each repaint would grow it.
 */
add_task(async function settings_draws_the_card_once_styled() {
  closeSettings();
  ChromeUtils.clearResourceCache({ types: ["stylesheet"], target: "chrome" });
  let layout = null;
  const watch = doc => {
    if (!doc.documentURI?.startsWith("about:preferences")) {
      return;
    }
    new doc.defaultView.MutationObserver((records, observer) => {
      const stock = doc.querySelector(".sval-mcard-stock");
      if (stock) {
        layout = doc.defaultView.getComputedStyle(stock).position;
        observer.disconnect();
      }
    }).observe(doc, { childList: true, subtree: true });
  };
  Services.obs.addObserver(watch, "document-element-inserted");
  atTaskEnd(() =>
    Services.obs.removeObserver(watch, "document-element-inserted")
  );
  await openSettings();
  await TestUtils.waitForCondition(() => layout, "Settings draws the card");
  Assert.equal(layout, "absolute", "the glow is laid out by card.css");
});

/**
 * The dialog counts the user's Workspaces and open tabs from the synced
 * tree, and says which count is this computer's alone.
 */
add_task(async function the_dialog_counts_workspaces_and_tabs() {
  document.getElementById("svalCardMenu").doCommand();
  const { doc } = await cardDialogShown();
  const stat = name => doc.querySelector(`[data-stat="${name}"]`);
  await TestUtils.waitForCondition(
    () => !stat("workspaces").hidden && !stat("tabs").hidden,
    "the counts show"
  );
  const { nodes } = await SvalPanel.engine.tree();
  const { workspaceIds } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTree.sys.mjs"
  );
  const own = workspaceIds(nodes).filter(id => !nodes[id]?.agent);
  Assert.equal(
    stat("workspaces").querySelector("dd").textContent,
    String(own.length)
  );
  Assert.ok(!stat("blocked").hidden, "this computer's blocking tally shows");
});

/** The View menu's item opens the same dialog. */
add_task(async function view_opens_the_card() {
  const item = document.getElementById("svalCardMenu");
  Assert.equal(item.parentNode.id, "menu_viewPopup", "in the View menu");
  item.doCommand();
  const { doc } = await cardDialogShown();
  Assert.ok(doc.querySelector(".sval-card-dialog"));
});

/** An Arc card's dialog says when its user joined Arc. */
add_task(async function an_arc_card_says_when_it_began() {
  const pref = "browser.sval.card";
  const startupCard = Services.prefs.getStringPref(pref);
  registerCleanupFunction(() =>
    Services.prefs.setStringPref(pref, startupCard)
  );
  Services.prefs.setStringPref(
    pref,
    JSON.stringify({
      title: "VAGUE ARCHIVIST",
      seed: 99,
      since: "2024-05-17",
      svalSince: "2026-11-07",
      arc: { shape: 3, palette: 4 },
    })
  );
  document.getElementById("svalCardMenu").doCommand();
  const { doc } = await cardDialogShown();
  Assert.ok(!doc.querySelector('[data-fact="arc"]').hidden);
  Services.prefs.setStringPref(pref, startupCard);
});

/**
 * Save image puts the card into the downloads folder as a PNG, without
 * asking where.
 */
add_task(async function save_image_puts_a_png_in_downloads() {
  const dir = await makeTempDir("sval-card-save");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", dir],
      ["browser.download.folderList", 2],
      ["browser.download.useDownloadDir", true],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  atTaskEnd(async () => {
    for (const download of await list.getAll()) {
      await list.remove(download);
      await download.finalize(true);
    }
  });
  document.getElementById("svalCardMenu").doCommand();
  const { doc } = await cardDialogShown();
  doc.querySelector(".sval-card-dialog-save").click();
  const [download] = await within(
    TestUtils.waitForCondition(
      async () => {
        const all = await list.getAll();
        return all.some(d => d.succeeded) && all;
      },
      "the image is saved",
      100,
      250
    ),
    30_000,
    "the saved image"
  );
  Assert.equal(PathUtils.parent(download.target.path), dir, "in Downloads");
  const bytes = await IOUtils.read(download.target.path, { maxBytes: 8 });
  Assert.deepEqual(
    Array.from(bytes),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "a PNG"
  );
  // The download opens the Downloads panel (`browser.download.alwaysOpenPanel`),
  // which would otherwise stay open and take a later file's Escape.
  const panel = document.getElementById("downloadsPanel");
  await TestUtils.waitForCondition(
    () => panel?.state === "open",
    "the saved image shows in the Downloads panel"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  DownloadsPanel.hidePanel();
  await within(hidden, 10_000, "the Downloads panel closing");
});

/**
 * The About dialog shows the user's card where the globe would be, with its
 * name, and clicking the card opens the card dialog in the browser window.
 */
add_task(async function the_about_dialog_shows_the_card() {
  const { cardName } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalCardArt.sys.mjs"
  );
  const { readCard } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalCard.sys.mjs"
  );
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    win => win.document.documentElement.id == "aboutDialog"
  );
  openAboutDialog();
  const about = await within(opened, 10_000, "the About dialog opening");
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(about), 10_000, "the dialog closing")
  );
  const doc = about.document;
  const card = doc.getElementById("svalCard");
  await TestUtils.waitForCondition(
    () => card.querySelector(".sval-mcard svg")?.checkVisibility(),
    "the About dialog shows the card"
  );
  Assert.equal(
    doc.getElementById("svalCardName").textContent,
    cardName(readCard()),
    "with its name under it"
  );
  Assert.equal(
    about.getComputedStyle(doc.getElementById("leftBox")).backgroundImage,
    "none",
    "in place of the globe"
  );

  card.click();
  await cardDialogShown();
});
