/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A headless browser shows nothing on the desktop it runs on: no native menu,
 * picker or dialog (`SvalHeadless.sys.mjs`). `scripts/test.sh` runs the suites
 * headless on macOS, so there this file checks the guard is in place; with a
 * display, on Linux's Xvfb and Windows' desktop, it checks the guard left the
 * platform alone.
 */

const { SvalHeadless } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHeadless.sys.mjs"
);

const headless = Cc["@mozilla.org/gfx/info;1"].getService(
  Ci.nsIGfxInfo
).isHeadless;

const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

add_task(async function the_guard_follows_whether_the_process_is_headless() {
  Assert.equal(
    SvalHeadless.guarded,
    headless,
    "the guard is in place exactly when the process is headless"
  );
});

add_task(async function a_headless_process_uses_no_native_menu() {
  if (!headless) {
    return;
  }
  for (const pref of SvalHeadless.NATIVE_UI_PREFS) {
    Assert.equal(Services.prefs.getBoolPref(pref), false, `${pref} is off`);
  }
});

add_task(async function a_headless_process_cancels_every_picker_and_dialog() {
  if (!headless) {
    return;
  }

  const filePicker = Cc["@mozilla.org/filepicker;1"].createInstance(
    Ci.nsIFilePicker
  );
  filePicker.init(
    window.browsingContext,
    "sval headless",
    Ci.nsIFilePicker.modeOpen
  );
  const fileResult = await new Promise(resolve =>
    filePicker.open({ done: resolve })
  );
  Assert.equal(
    fileResult,
    Ci.nsIFilePicker.returnCancel,
    "a file picker answers as if cancelled"
  );
  Assert.equal(filePicker.file, null, "and picks no file");

  const colorPicker = Cc["@mozilla.org/parent/colorpicker;1"].createInstance(
    Ci.nsIColorPicker
  );
  colorPicker.init(window.browsingContext, "sval headless", "#000000", []);
  const color = await new Promise(resolve =>
    colorPicker.open({ update() {}, done: resolve })
  );
  Assert.equal(color, "", "a colour picker closes with no colour");

  const printDialog = Cc[
    "@mozilla.org/widget/printdialog-service;1"
  ].getService(Ci.nsIPrintDialogService);
  const settings = Cc["@mozilla.org/gfx/printsettings-service;1"]
    .getService(Ci.nsIPrintSettingsService)
    .createNewPrintSettings();
  for (const show of [
    () => printDialog.showPrintDialog(window, false, settings),
    () => printDialog.showPageSetupDialog(window, settings),
  ]) {
    await Assert.rejects(
      show(),
      e => e.result == Cr.NS_ERROR_ABORT,
      "a print dialog answers as if cancelled"
    );
  }
});

add_task(async function a_process_with_a_display_keeps_the_platforms_own() {
  if (headless) {
    return;
  }
  for (const contractID of SvalHeadless.REPLACED_CONTRACTS) {
    if (!(contractID in Cc)) {
      continue;
    }
    Assert.ok(
      !SvalHeadless.REPLACED_CLASS_IDS.some(id =>
        id.equals(registrar.contractIDToCID(contractID))
      ),
      `${contractID} is the platform's own`
    );
  }
});
