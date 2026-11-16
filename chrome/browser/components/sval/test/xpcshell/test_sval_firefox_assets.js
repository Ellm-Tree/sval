/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

/**
 * Sval never shows Firefox's branding (CONTRIBUTING.md, "Never use Firefox
 * branding"). Each of these chrome URLs names an image of Mozilla's that draws
 * Firefox's fox or a Firefox or Mozilla logo on a surface Sval keeps, and
 * Sval's jar.mn overrides it.
 * docs/firefox-assets.md lists each with where it shows; a URL that stops
 * resolving to Sval's file brings the Firefox art back.
 */
const SVAL = "chrome://browser/content/sval/";
const APP_ICON = "chrome://branding/content/about-logo.svg";
const OVERRIDES = {
  "chrome://browser/skin/addons/extensions-panel-empty-illustration.svg": `${SVAL}illustrations/puzzle.svg`,
  "chrome://global/skin/illustrations/no-connection.svg": `${SVAL}illustrations/unplug.svg`,
  "chrome://global/skin/illustrations/security-error.svg": `${SVAL}illustrations/shield-alert.svg`,
  "chrome://browser/skin/trustpanel-graphic-enabled.svg": `${SVAL}illustrations/trustpanel-shield-check.svg`,
  "chrome://browser/skin/trustpanel-graphic-disabled.svg": `${SVAL}illustrations/trustpanel-shield-x.svg`,
  "chrome://browser/skin/trustpanel-graphic-warning.svg": `${SVAL}illustrations/trustpanel-shield-alert.svg`,
  "chrome://global/content/megalist/icons/cpm-fox-illustration.svg": `${SVAL}illustrations/key-round.svg`,
  "chrome://browser/content/logos/lockwise.svg": `${SVAL}illustrations/key-round.svg`,
  "chrome://browser/skin/preferences/fox-ai.svg": `${SVAL}illustrations/sparkles.svg`,
  "chrome://mozapps/skin/extensions/line.svg": `${SVAL}icons/badge-check.svg`,
  "chrome://browser/content/firefoxview/history-empty.svg": `${SVAL}illustrations/history.svg`,
  "chrome://browser/content/firefoxview/synced-tabs-empty.svg": `${SVAL}illustrations/monitor-smartphone.svg`,
  "chrome://browser/content/firefoxview/synced-tabs-error.svg": `${SVAL}illustrations/monitor-smartphone.svg`,
  "chrome://global/skin/illustrations/kit-concerned.svg": APP_ICON,
  "chrome://global/skin/illustrations/kit-happy.svg": APP_ICON,
  "chrome://global/skin/illustrations/kit-in-circle.svg": APP_ICON,
  "chrome://browser/skin/sidebar/firefox.svg": `${SVAL}sval-glyph.svg`,
  "chrome://browser/skin/firefox-view.svg": `${SVAL}sval-glyph.svg`,
  "chrome://browser/skin/window-firefox.svg":
    "chrome://browser/skin/window.svg",
  "chrome://devtools/skin/images/fox-smiling.svg": APP_ICON,
  "chrome://devtools/skin/images/aboutdebugging-firefox-logo.svg": `${SVAL}sval-glyph.svg`,
  "chrome://devtools/skin/images/aboutdebugging-firefox-release.svg": APP_ICON,
  "chrome://devtools/skin/images/aboutdebugging-firefox-beta.svg": APP_ICON,
  "chrome://devtools/skin/images/aboutdebugging-firefox-aurora.svg": APP_ICON,
  "chrome://devtools/skin/images/aboutdebugging-firefox-nightly.svg": APP_ICON,
};

function resolve(url) {
  const registry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
    Ci.nsIChromeRegistry
  );
  // An override maps to another chrome URL, which the registry maps in turn.
  let uri = Services.io.newURI(url);
  while (uri.schemeIs("chrome")) {
    uri = registry.convertChromeURL(uri);
  }
  return uri.spec;
}

function read(url) {
  const channel = NetUtil.newChannel({
    uri: url,
    loadUsingSystemPrincipal: true,
  });
  const stream = channel.open();
  try {
    return NetUtil.readInputStreamToString(stream, stream.available());
  } finally {
    stream.close();
  }
}

add_task(function each_firefox_image_resolves_to_svals() {
  for (const [firefox, sval] of Object.entries(OVERRIDES)) {
    Assert.equal(resolve(firefox), resolve(sval), `${firefox} is Sval's`);
  }
});

add_task(function each_replacement_is_an_svg_sval_ships() {
  for (const sval of new Set(Object.values(OVERRIDES))) {
    Assert.ok(read(sval).includes("<svg"), `${sval} is an SVG`);
  }
});
