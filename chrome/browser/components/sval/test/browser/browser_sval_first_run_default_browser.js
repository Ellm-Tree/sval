/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Yes on first run's default browser card asks the system to make Sval the
 * default browser when "A few more things" continues (first-run spec §3,
 * 2026-11-09 spec §3.6). Every other first-run file answers No
 * there; the manifest says where this one runs and why.
 */

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_first_run_helpers.js",
  this
);

add_task(async function yes_makes_sval_the_default_browser() {
  // The manifest's XDG folders outlive the browser, and a file run again
  // must find Sval not yet the default.
  registerCleanupFunction(() =>
    IOUtils.remove("/tmp/sval-first-run-default-browser", {
      recursive: true,
      ignoreAbsent: true,
    })
  );
  keepFirstRunPrefs();
  Assert.ok(
    !ShellService.isDefaultBrowser(false, true),
    "Sval starts out not the default browser"
  );
  const doc = await firstRunShown();
  while (shownStep(doc) !== STEPS.more) {
    const from = shownStep(doc);
    await settled(doc);
    // No task here reads this machine's own browsers.
    for (const box of shownSection(doc).querySelectorAll(".sval-im-tick")) {
      if (box.checked) {
        box.click();
      }
    }
    button(doc, from === STEPS.intro ? "skip" : "continue").click();
    await TestUtils.waitForCondition(
      () => shownStep(doc) !== from,
      `Continue from ${from}`
    );
  }
  Assert.ok(
    shownSection(doc).querySelector(
      'input[data-setting="defaultBrowser"][value="true"]'
    ).checked,
    "Yes is preset"
  );
  // The step takes Continue only once its own task has passed (`settled`).
  await settled(doc);
  button(doc, "continue").click();
  await startBrowsing(doc);
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await TestUtils.waitForCondition(
    () => ShellService.isDefaultBrowser(false, true),
    "the system names Sval the default browser"
  );
});
