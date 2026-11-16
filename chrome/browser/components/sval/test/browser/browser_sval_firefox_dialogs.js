/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Every Firefox dialog in a modal box wears Sval's dialog frame
 * (`SvalPageStyle.styleDialog`), and Sval's own dialogs keep their own. A
 * dialog that opens as a window of its own takes the frame's palette.
 */

ChromeUtils.defineESModuleGetters(this, {
  PAGE_SHEET: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  dialogSheetsFor: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  sheetsFor: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
});

/* import-globals-from sval_preferences_helpers.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);

const FRAME_SHEETS = [
  "chrome://browser/content/sval/sval-dialog.css",
  "chrome://browser/content/sval/pages/dialog.css",
];
const COMMON_DIALOG = "chrome://global/content/commonDialog.xhtml";

add_task(function each_dialog_takes_the_frame_sheets() {
  Assert.deepEqual(
    dialogSheetsFor(
      "chrome://browser/content/preferences/dialogs/siteDataSettings.xhtml"
    ),
    [PAGE_SHEET, ...FRAME_SHEETS],
    "a dialog no list names takes the page sheet, then the frame's"
  );
  Assert.deepEqual(
    dialogSheetsFor(COMMON_DIALOG),
    [
      PAGE_SHEET,
      ...FRAME_SHEETS,
      "chrome://browser/content/sval/pages/common-dialog.css",
    ],
    "the common dialog takes its own sheet last"
  );
  Assert.deepEqual(
    dialogSheetsFor("chrome://browser/content/sval/sval-dialog.xhtml"),
    [],
    "Sval's own dialog takes none"
  );
});

add_task(async function a_page_confirm_wears_the_frame() {
  const tab = await openPage("https://example.com/");
  const browser = tab.linkedBrowser;
  const shown = PromptTestUtils.waitForPrompt(browser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
    promptType: "confirm",
  });
  await SpecialPowers.spawn(browser, [], () => {
    content.setTimeout(() => content.confirm("Go on?"), 0);
  });
  const dialog = await within(shown, 10_000, "the page's confirm");
  const doc = dialog.ui.button0.ownerDocument;
  const win = doc.defaultView;
  Assert.equal(doc.documentURI, COMMON_DIALOG, "the common dialog");

  const root = win.getComputedStyle(doc.documentElement);
  Assert.ok(
    root.getPropertyValue("--sval-dialog-card").trim(),
    "the dialog has Sval's dialog palette"
  );
  Assert.equal(root.borderTopLeftRadius, "20px", "the card's corners");
  Assert.equal(root.width, "400px", "the frame's width");
  // The box draws the card's edge around the frame (`SvalDialogBox`), so its
  // inside follows the card's corners.
  const box = win.frameElement.documentGlobal.getComputedStyle(
    win.frameElement.closest(".dialogBox")
  );
  Assert.equal(box.borderTopWidth, "1px", "the box draws the card's edge");
  Assert.equal(box.borderTopLeftRadius, "21px", "around the card's corners");
  Assert.equal(
    root.borderTopColor,
    "rgba(0, 0, 0, 0)",
    "the card leaves its edge to the box"
  );

  await within(
    PromptTestUtils.handlePrompt(dialog),
    10_000,
    "the confirm closing once handled"
  );
});

add_task(function a_dialog_window_takes_the_window_sheet() {
  Assert.deepEqual(
    sheetsFor("chrome://pippki/content/deletecert.xhtml"),
    [PAGE_SHEET, "chrome://browser/content/sval/pages/window-dialog.css"],
    "a dialog that opens as a window takes the page sheet, then its own"
  );
});

add_task(async function the_update_elevation_window_is_as_tall_as_its_words() {
  // The window reads the ready update as it loads, and a test has none.
  const manager =
    Cc["@mozilla.org/updates/update-manager;1"].getService().wrappedJSObject;
  manager.getReadyUpdate = async () => ({ name: "Sval 0.1.0-rc.10" });
  registerCleanupFunction(() => delete manager.getReadyUpdate);
  const url = "chrome://mozapps/content/update/updateElevation.xhtml";
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    win => win.document.documentURI == url
  );
  // As `UpdateService` opens it for an update that needs an administrator.
  Services.ww.openWindow(
    null,
    url,
    "_blank",
    "chrome,centerscreen,resizable=no,titlebar,toolbar=no,dialog=no",
    null
  );
  const win = await within(opened, 10_000, "the elevation window");
  const doc = win.document;
  await within(
    TestUtils.waitForCondition(
      () => doc.getElementById("updateFinishedName").value,
      "the window names the update"
    ),
    10_000,
    "the window reading the update"
  );
  Assert.ok(
    doc.getElementById("elevateAccept").label,
    "its buttons are labelled"
  );
  const content = doc.querySelector(".update-content");
  const shown = [...content.children].filter(el => el.checkVisibility());
  const box = content.getBoundingClientRect();
  Assert.lessOrEqual(
    box.bottom - shown.at(-1).getBoundingClientRect().bottom,
    1,
    "no empty band below the text"
  );
  Assert.equal(
    win.getComputedStyle(doc.getElementById("updates")).backgroundColor,
    "rgba(0, 0, 0, 0)",
    "the card shows through the dialog"
  );
  Assert.equal(
    win.getComputedStyle(doc.documentElement).appearance,
    "none",
    "and no native window background covers it"
  );
  Assert.ok(
    // `macWindow.inc.xhtml` gives the window a menu bar on macOS alone.
    !doc.getElementById("main-menubar")?.checkVisibility(),
    "the menu bar takes no room in the card"
  );
  const probe = doc.createElement("div");
  probe.style.color = "var(--sval-dialog-primary)";
  doc.documentElement.append(probe);
  Assert.equal(
    win.getComputedStyle(doc.getElementById("elevateAccept")).backgroundColor,
    win.getComputedStyle(probe).color,
    "Restart is the primary button"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
});

add_task(async function page_info_wears_the_dialog_palette() {
  await openPage("https://example.com/");
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    win =>
      win.document.documentURI ==
      "chrome://browser/content/pageinfo/pageInfo.xhtml"
  );
  BrowserCommands.pageInfo();
  const win = await within(opened, 10_000, "Page Info");
  const root = win.getComputedStyle(win.document.documentElement);
  Assert.ok(
    root.getPropertyValue("--sval-dialog-card").trim(),
    "the window has Sval's dialog palette"
  );
  Assert.equal(root.borderTopWidth, "0px", "the system draws its edge");
  Assert.equal(
    root.appearance,
    "none",
    "and no native window background covers the card"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "Page Info closing");
});

add_task(async function a_settings_dialog_is_one_card() {
  const ui = await openSettings();
  ui.page.gSubDialog.open("chrome://mozapps/content/update/history.xhtml");
  let dialog;
  await within(
    TestUtils.waitForCondition(() => {
      dialog = ui.page.gSubDialog._topDialog;
      // Shaped once its document has loaded (`sval-dialog-frame.js`).
      return (
        dialog?._frame.contentDocument?.querySelector("dialog") &&
        dialog._box.style.borderTopWidth
      );
    }, "Update History opens"),
    10_000,
    "Update History opening"
  );
  const box = dialog._box.getBoundingClientRect();
  const frame = dialog._frame.getBoundingClientRect();
  // The box draws the card's edge (`SvalDialogBox`), and the card fills it
  // inside that edge.
  const edge = parseFloat(ui.page.getComputedStyle(dialog._box).borderTopWidth);
  Assert.equal(edge, 1, "the box draws the card's edge");
  Assert.deepEqual(
    [frame.left, frame.top, frame.right, frame.bottom],
    [box.left + edge, box.top + edge, box.right - edge, box.bottom - edge],
    "the card fills the box, so no part of it shows the page through"
  );
  Assert.equal(
    ui.page.getComputedStyle(dialog._box).resize,
    "none",
    "the box has no resize grip, as a window's has none"
  );
  const win = dialog._frame.contentWindow;
  Assert.equal(
    win.getComputedStyle(win.document.querySelector("dialog")).backgroundColor,
    "rgba(0, 0, 0, 0)",
    "the dialog leaves the card's rounded edge uncovered"
  );
  dialog.close();
  BrowserTestUtils.removeTab(ui.tab);
});
