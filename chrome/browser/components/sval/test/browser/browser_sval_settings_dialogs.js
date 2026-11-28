/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Settings' confirmations: each a native `<dialog>`, for modality and
 * Escape, around the card `sval-dialog` draws in Settings' roles. Each
 * opens on its card with Cancel focused, or the server's first field, names
 * and describes itself to the
 * accessibility API, dims the page, and closes on Escape and on Cancel.
 * What each confirmation's other answer does is its own pane's test's:
 * `browser_sval_blocking_settings.js`, `browser_sval_site_page_data.js`,
 * `browser_sval_settings_folder.js`, `browser_sval_extensions_settings.js`
 * and `browser_sval_agent_settings.js`.
 */

/* import-globals-from head.js */

/**
 * Each confirmation's dialog, the category of Settings it is in, its card's
 * width and the control it opens on.
 */
const DIALOGS = [
  ["sval-blocking-dialog", "privacy", 480, "sval-blocking-dialog-cancel"],
  ["sval-stop-dialog", "svalSync", 480, "sval-stop-dialog-cancel"],
  ["sval-server-dialog", "svalSync", 480, "sval-server-host"],
  ["sval-dropbox-dialog", "svalSync", 480, "sval-dropbox-up"],
  [
    "sval-extension-dialog",
    "svalExtensions",
    480,
    "sval-extension-dialog-cancel",
  ],
  ["sval-unpair-dialog", "svalAgents", 480, "sval-unpair-cancel"],
];

/**
 * Shows `dialog` in its category, as its pane's script does: a modal
 * dialog shows only while its ancestors render.
 *
 * @param {object} ui
 * @param {Element} dialog
 * @returns {Promise<Element>} Its card.
 */
async function show(ui, dialog) {
  const [, category] = DIALOGS.find(([id]) => id === dialog.id);
  await showPane(ui.page, category);
  if (dialog.id === "sval-server-dialog") {
    // Its opener fills the fields and focuses the first one to fill.
    ui.settings.chooseServerFolder();
  } else {
    dialog.showModal();
  }
  const card = dialog.querySelector("sval-dialog");
  await within(card.updateComplete, 5_000, "the card drawing");
  return card;
}

add_task(async function each_confirmation_is_a_card_in_a_modal_dialog() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const ui = await openSvalSettings();
  const doc = ui.page.document;
  for (const [id, , width, cancel] of DIALOGS) {
    const dialog = doc.getElementById(id);
    const card = await show(ui, dialog);
    Assert.ok(dialog.open && dialog.matches(":modal"), `${id} is modal`);
    const title = doc.getElementById(dialog.getAttribute("aria-labelledby"));
    Assert.equal(title.assignedSlot?.name, "title", `${id}: its title slots`);
    Assert.equal(
      Math.round(card.getBoundingClientRect().width),
      width,
      `${id}: its card is ${width}px wide`
    );
    const view = ui.page;
    Assert.deepEqual(
      InspectorUtils.colorToRGBA(view.getComputedStyle(card).backgroundColor),
      InspectorUtils.colorToRGBA(
        view
          .getComputedStyle(doc.documentElement)
          .getPropertyValue("--sval-raised")
          .trim()
      ),
      `${id}: the card is Settings' raised surface`
    );
    Assert.equal(
      view.getComputedStyle(dialog).backgroundColor,
      "rgba(0, 0, 0, 0)",
      `${id}: the native dialog draws nothing of its own`
    );
    Assert.notEqual(
      view.getComputedStyle(dialog, "::backdrop").backgroundColor,
      "rgba(0, 0, 0, 0)",
      `${id}: the page under it is dimmed`
    );
    Assert.equal(
      doc.activeElement,
      doc.getElementById(cancel),
      `${id}: ${cancel} has the focus`
    );
    const accessible = await accessibleOf(dialog);
    Assert.equal(
      accessible.role,
      Ci.nsIAccessibleRole.ROLE_DIALOG,
      `${id}: a dialog to the accessibility API`
    );
    await closeDialog(
      dialog,
      () => EventUtils.synthesizeKey("KEY_Escape", {}, view),
      `${id}: Escape closes it`
    );

    await show(ui, dialog);
    await closeDialog(
      dialog,
      () => pressDialogButton(dialog, "cancel"),
      `${id}: Cancel closes it`
    );
  }
});

add_task(async function a_delete_confirmation_shows_its_danger_tile() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const ui = await openSvalSettings();
  const doc = ui.page.document;
  const dialog = doc.getElementById("sval-blocking-dialog");
  const card = await show(ui, dialog);
  const tile = card.shadowRoot.querySelector('[part~="icon"]');
  Assert.ok(!tile.checkVisibility(), "a confirmation of a level has no tile");
  card.icon = "trash";
  card.tone = "danger";
  await card.updateComplete;
  Assert.ok(tile.checkVisibility(), "a deletion's tile shows");
  const view = ui.page;
  Assert.deepEqual(
    InspectorUtils.colorToRGBA(view.getComputedStyle(tile).color),
    InspectorUtils.colorToRGBA(
      view
        .getComputedStyle(doc.documentElement)
        .getPropertyValue("--sval-problem")
        .trim()
    ),
    "in the problem colour"
  );
  card.icon = null;
  card.tone = "default";
  await closeDialog(
    dialog,
    () => EventUtils.synthesizeKey("KEY_Escape", {}, view),
    "Escape closes it"
  );
});
