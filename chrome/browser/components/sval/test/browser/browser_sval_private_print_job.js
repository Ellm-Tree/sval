/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A private window's print job is named for Sval, never for its page
 * (print-job-private-name.patch): the system's print queue and its history
 * keep a job's name. On macOS a job printed to a PDF file carries its name as
 * the file's title, which is where this reads it. Cairo's PDF writer, which
 * Windows and Linux print through, writes no title (PrintTargetPDF), so the
 * test runs on macOS alone.
 */

const TITLE = "svalprintjobtitle";

/**
 * Prints `tab`'s page, titled {@link TITLE}, to a PDF file.
 *
 * @param {Element} tab A loaded tab.
 * @returns {Promise<string>} The file's bytes, as Latin-1 text.
 */
async function printedPdf(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [TITLE], title => {
    content.document.title = title;
  });
  const settings = Cc["@mozilla.org/gfx/printsettings-service;1"]
    .getService(Ci.nsIPrintSettingsService)
    .createNewPrintSettings();
  settings.printSilent = true;
  settings.outputFormat = Ci.nsIPrintSettings.kOutputFormatPDF;
  settings.outputDestination = Ci.nsIPrintSettings.kOutputDestinationFile;
  settings.toFileName = tempPath("sval-print-job", ".pdf");
  await within(
    tab.linkedBrowser.browsingContext.print(settings),
    30_000,
    "the page printing to a file"
  );
  const bytes = await IOUtils.read(settings.toFileName);
  let text = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return text;
}

add_task(async function a_private_windows_print_job_is_named_for_sval() {
  const tab = await openPage(PAGE);
  Assert.ok(
    (await printedPdf(tab)).includes(`(${TITLE})`),
    "a normal window's job is named for its page"
  );

  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a private window opening"
  );
  const pdf = await printedPdf(await openPage(PAGE, win));
  Assert.ok(!pdf.includes(TITLE), "a private window's job does not name it");
  Assert.ok(pdf.includes("(Sval)"), "and is named for Sval");
});
