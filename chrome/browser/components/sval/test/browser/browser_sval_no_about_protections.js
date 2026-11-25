/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * about:protections is not built: no page, no privacy metrics service, no
 * link to it. `ContentBlockingPrefs`, which Settings' tracking protection
 * and Sval's blocking set their prefs through, stays.
 */

add_task(function about_protections_does_not_ship() {
  for (const spec of [
    "chrome://browser/content/protections.mjs",
    "chrome://browser/content/privacy-metrics-card.mjs",
    "moz-src:///browser/components/protections/PrivacyMetricsService.sys.mjs",
    "chrome://browser/content/logos/lockwise.svg",
  ]) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
  Assert.ok(
    packaged(
      "moz-src:///browser/components/protections/ContentBlockingPrefs.sys.mjs"
    ),
    "ContentBlockingPrefs is in the package"
  );
});

add_task(function no_report_pref_has_a_default() {
  Assert.deepEqual(
    Services.prefs
      .getDefaultBranch("browser.contentblocking.report.")
      .getChildList("")
      .filter(name => name != "vpn_regions"),
    [],
    "only the VPN regions list, which BrowserUtils reads, keeps a default"
  );
});

add_task(function the_protections_panel_links_no_dashboard() {
  Assert.equal(
    typeof gProtectionsHandler.openProtections,
    "undefined",
    "the protections panel has no way to the dashboard"
  );
  Assert.ok(
    !document.getElementById("protections-popup-show-report-button"),
    "the protections panel has no dashboard button"
  );
});
