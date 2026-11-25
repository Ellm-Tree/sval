/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Firefox's profile backup is not built: no service, no Settings section, no
 * actor, no enterprise policy. Sval's own backup of its sync key is a
 * separate thing and stays.
 */

const { Policies } = ChromeUtils.importESModule(
  "resource:///modules/policies/Policies.sys.mjs"
);

add_task(function the_backup_service_does_not_ship() {
  for (const spec of [
    "resource:///modules/backup/BackupService.sys.mjs",
    "resource:///actors/BackupUIParent.sys.mjs",
    "chrome://browser/content/backup/backup-settings.mjs",
  ]) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
  Assert.ok(
    packaged("chrome://browser/content/sval/backup-key.xhtml"),
    "Sval's own key backup is found"
  );
});

add_task(function the_backup_policy_is_gone() {
  Assert.ok(!("BrowserDataBackup" in Policies), "no BrowserDataBackup policy");
});

add_task(function no_backup_pref_has_a_default() {
  Assert.deepEqual(
    Services.prefs.getDefaultBranch("browser.backup.").getChildList(""),
    [],
    "Firefox's backup prefs are gone"
  );
});

add_task(async function settings_shows_no_backup_section() {
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    await pageReady(browser, "about:preferences");
    await TestUtils.waitForCondition(
      () => browser.contentWindow?.SvalSettings?._els,
      "Settings shows Sval's panes"
    );
    const settings = browser.contentWindow;
    await showPane(settings, "paneSync");
    const doc = settings.document;
    await TestUtils.waitForCondition(
      () => doc.querySelector('setting-group[groupid="downloads"]'),
      "General builds its groups"
    );
    Assert.ok(
      !doc.querySelector('setting-group[groupid="backup"]'),
      "General has no Backup group"
    );
    Assert.ok(
      !doc.querySelector("backup-settings"),
      "no backup control is built"
    );
  });
});
