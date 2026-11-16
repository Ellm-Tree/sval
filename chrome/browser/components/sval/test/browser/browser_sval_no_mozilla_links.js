/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Firefox's pages that linked or sent to Mozilla's sites with no pref to
 * change them: about:logging's profiler output, about:policies'
 * documentation links, about:processes' profiler buttons and the
 * Translations panel's gear-menu help (`docs/outbound-links.md`).
 */

add_task(async function about_logging_logs_to_a_file_only() {
  await SpecialPowers.pushPrefEnv({ clear: [["logging.config.output_type"]] });
  const tab = await openPage("about:logging");
  const shown = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const doc = content.document;
    return {
      profilerHidden: doc.getElementById("logging-output-profiler").hidden,
      profilerSettingsHidden: doc.getElementById("profiler-configuration")
        .hidden,
      fileChosen: doc.getElementById("radio-logging-file").checked,
    };
  });
  Assert.ok(shown.profilerHidden, "the profiler output is not offered");
  Assert.ok(shown.profilerSettingsHidden, "nor its settings");
  Assert.ok(shown.fileChosen, "the file output is chosen");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function about_logging_refuses_the_profiler_by_address() {
  await SpecialPowers.pushPrefEnv({ clear: [["logging.config.output_type"]] });
  const url = "about:logging?output=profiler";
  const tab = await openPage(url);
  const error = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const el = content.document.getElementById("error");
    await ContentTaskUtils.waitForCondition(
      () => !el.hidden,
      "the page shows its error"
    );
    return content.document.getElementById("radio-logging-file").checked;
  });
  Assert.ok(error, "the page keeps the file output and shows an error");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function about_policies_links_no_documentation() {
  // The page builds its Documentation tab as it loads, shown or not.
  const tab = await openPage("about:policies");
  const links = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const body = content.document.getElementById("documentationContent");
    await ContentTaskUtils.waitForCondition(
      () => body.querySelector("tr"),
      "the documentation lists the policies"
    );
    return [...content.document.querySelectorAll("a[href]")].map(a => a.href);
  });
  Assert.deepEqual(
    links.filter(href => href.startsWith("http")),
    [],
    "about:policies links to no website"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function about_processes_draws_no_profiler_buttons() {
  const tab = await openPage("about:processes");
  const buttons = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(
      () => doc.querySelector("#process-tbody tr"),
      "the page lists the processes"
    );
    return doc.querySelectorAll(".profiler-icon").length;
  });
  Assert.equal(buttons, 0, "no process has a profiler button");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function translations_help_goes_to_svals_support() {
  const opened = [];
  const original = window.openTrustedLinkIn;
  window.openTrustedLinkIn = url => opened.push(url);
  try {
    FullPageTranslationsPanel.onAboutTranslations();
  } finally {
    window.openTrustedLinkIn = original;
  }
  Assert.deepEqual(
    opened,
    [
      Services.urlFormatter.formatURLPref("app.support.baseURL") +
        "website-translation",
    ],
    "the gear menu's help opens Sval's support page"
  );
});
