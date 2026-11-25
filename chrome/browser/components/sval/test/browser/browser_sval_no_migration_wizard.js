/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Firefox's import wizard is not built: no wizard, no dialog, no startup
 * migration and no way to either. Sval's own import page reads other
 * browsers through Firefox's migrators, which stay.
 */

const { MigrationUtils } = ChromeUtils.importESModule(
  "resource:///modules/MigrationUtils.sys.mjs"
);

add_task(function the_wizard_does_not_ship() {
  for (const spec of [
    "chrome://browser/content/migration/migration-wizard.mjs",
    "chrome://browser/content/migration/migration-dialog-window.html",
    "resource:///actors/MigrationWizardParent.sys.mjs",
    "resource:///modules/ProfileMigrator.sys.mjs",
    "chrome://browser/skin/migration/migration-wizard.css",
  ]) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
  Assert.ok(
    !("@mozilla.org/toolkit/profile-migrator;1" in Cc),
    "no profile migrator runs at startup"
  );
  Assert.equal(
    typeof MigrationUtils.showMigrationWizard,
    "undefined",
    "nothing can open the wizard"
  );
});

add_task(function the_migrators_stay() {
  for (const spec of [
    "resource:///modules/ChromeProfileMigrator.sys.mjs",
    "chrome://browser/content/migration/migration-wizard-constants.mjs",
    "chrome://browser/content/migration/brands/chrome.png",
  ]) {
    Assert.ok(packaged(spec), `${spec} is in the package`);
  }
});

add_task(function no_window_holds_a_way_to_the_wizard() {
  for (const id of ["import-button", "cmd_help_importFromAnotherBrowser"]) {
    Assert.ok(!document.getElementById(id), `the window has no ${id}`);
  }
  Assert.ok(
    document.getElementById("cmd_file_importFromAnotherBrowser"),
    "File › Import keeps its command, which Sval's import page answers"
  );
});

add_task(async function settings_hold_no_wizard_dialog() {
  const tab = await openPage("about:preferences");
  Assert.ok(
    !tab.linkedBrowser.contentDocument.getElementById("migrationWizardDialog"),
    "Settings has no wizard dialog"
  );
  BrowserTestUtils.removeTab(tab);
});
