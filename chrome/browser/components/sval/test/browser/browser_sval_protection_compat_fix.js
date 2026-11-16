/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A site Mozilla's webcompat fix covers. With Mozilla's fixes off, Sval's
 * default, the site gets the global target set and the panel shows
 * fingerprinting protection on. With them on, the panel's fingerprinting
 * switch shows it off, and turning it on keeps the fix out of the site with
 * the global target set, through a choice that syncs. A private window keeps
 * the fix, and its panel says so.
 */

const { SvalSiteProtections, SITE_BRANCH, GRANULAR_PREFS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
const { SvalProtectionButton } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
);
const { RemoteSettings } = ChromeUtils.importESModule(
  "resource://services-settings/remote-settings.sys.mjs"
);

const REMOTE_PREF = "privacy.fingerprintingProtection.remoteOverrides.enabled";
const FIX_SITE = "example.com";
const FIX_PAGE = "https://example.com/";

/** Mozilla's entries for Google, as Remote Settings delivers them. */
const FIX_ENTRIES = [
  {
    id: "sval-fix-fpp",
    firstPartyDomain: FIX_SITE,
    isBaseline: false,
    overrides:
      "-CanvasRandomization,-WebGLVendorRandomize,-WebGLVendorConstant,-WebGLVendorSanitize",
  },
  {
    id: "sval-fix-baseline",
    firstPartyDomain: FIX_SITE,
    isBaseline: true,
    overrides: "-CanvasRandomization,-EfficientCanvasRandomization",
  },
];

/**
 * Sets Mozilla's webcompat entries as Remote Settings delivers them, and
 * waits for nsRFPService to hold them.
 *
 * @param {object[]} entries
 */
async function setRemote(entries) {
  const client = RemoteSettings("fingerprinting-protection-overrides");
  const set = TestUtils.topicObserved("fpp-test:set-overrides-finishes");
  await client.db.clear();
  await client.db.importChanges({}, Date.now(), entries);
  await client.emit("sync", { data: { current: entries } });
  await within(set, 10000, "the remote entries reach nsRFPService");
}

/**
 * @param {nsIRFPTargetSetIDL} set
 * @returns {number[]} The set's bits, 32 at a time.
 */
function bitsOf(set) {
  return [0, 1, 2, 3].map(part => set.getNth32BitSet(part));
}

/**
 * @returns {number[]|null} The targets the site's first-party loads get from
 *   an entry, or null with none.
 */
function siteTargets() {
  try {
    return bitsOf(Services.rfp.getFingerprintingOverrides(`${FIX_SITE},0`));
  } catch {
    return null;
  }
}

/**
 * Turns Mozilla's fixes on, as Settings' switch does, until `fixesOff`, and
 * waits for nsRFPService to hold them.
 */
async function fixesOn() {
  const set = TestUtils.topicObserved("fpp-test:set-overrides-finishes");
  await SpecialPowers.pushPrefEnv({ set: [[REMOTE_PREF, true]] });
  await within(set, 10000, "Mozilla's fixes reach nsRFPService");
}

async function fixesOff() {
  const set = TestUtils.topicObserved("fpp-test:set-overrides-finishes");
  await SpecialPowers.popPrefEnv();
  await within(set, 10000, "Mozilla's fixes leave nsRFPService");
}

/** @returns {number[]} The targets every site gets without an entry. */
function globalTargets() {
  return bitsOf(Services.rfp.enabledFingerprintingProtections);
}

/**
 * @param {object|null} rule As settings sync applies another device's.
 */
function arrives(rule) {
  if (rule) {
    Services.prefs.setStringPref(SITE_BRANCH + FIX_SITE, JSON.stringify(rule));
  } else {
    Services.prefs.clearUserPref(SITE_BRANCH + FIX_SITE);
  }
}

/** @returns {object|null} The site's synced choice. */
function storedRule() {
  const text = Services.prefs.getStringPref(SITE_BRANCH + FIX_SITE, "");
  return text ? JSON.parse(text) : null;
}

function reset() {
  clearPrefBranches(SITE_BRANCH);
  for (const name of GRANULAR_PREFS) {
    Services.prefs.clearUserPref(name);
  }
  Services.perms.removeAll();
}

function panelIn(win = window) {
  return win.document.getElementById("sval-protection-panel");
}

async function openPanel(win = window) {
  const panel = panelIn(win);
  const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
  win.document.getElementById("sval-protection-button").click();
  await within(shown, 5_000, "the protection panel's popupshown");
  return panel;
}

async function closePanel(win = window) {
  const panel = panelIn(win);
  if (panel.state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await within(hidden, 5_000, "the protection panel's popuphidden");
}

/**
 * @param {Element} panel
 * @returns {{on: boolean, disabled: boolean, reason: string, note: boolean}}
 *   The fingerprinting switch, and whether the fix's note shows.
 */
function fpSwitch(panel) {
  const fp = panel.querySelector("#sval-prot-fp");
  return {
    on: fp.getAttribute("aria-checked") === "true",
    disabled: fp.getAttribute("aria-disabled") === "true",
    reason: fp.dataset.reason,
    note: !!panel.querySelector(".sval-prot-compat"),
  };
}

/**
 * Clicks the fingerprinting switch, which the open panel redraws, and waits
 * for the reload it makes and for the redrawn switch.
 *
 * @param {Element} panel
 * @param {MozBrowser} browser
 */
async function flip(panel, browser) {
  const was = fpSwitch(panel).on;
  const reloaded = BrowserTestUtils.browserLoaded(browser);
  panel.querySelector("#sval-prot-fp").click();
  await within(reloaded, 15_000, "the page's reload after the switch");
  await TestUtils.waitForCondition(
    () => fpSwitch(panel).on !== was,
    "the panel redraws the switch"
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.fingerprintingProtection.remoteOverrides.testing", true]],
  });
  await setRemote(FIX_ENTRIES);
  registerCleanupFunction(async () => {
    reset();
    await setRemote([]);
  });
});

add_task(async function by_default_no_fix_applies() {
  reset();
  Assert.ok(
    !Services.prefs.getDefaultBranch("").getBoolPref(REMOTE_PREF),
    "Sval ships Mozilla's fixes off"
  );
  Assert.equal(siteTargets(), null, "the site has no entry");
  await BrowserTestUtils.withNewTab(FIX_PAGE, async browser => {
    Assert.greater(
      await asPage(browser, canvasProbe),
      0,
      "canvas readback is noised"
    );
    const panel = await openPanel();
    Assert.deepEqual(
      fpSwitch(panel),
      { on: true, disabled: false, reason: "", note: false },
      "the switch is on and no note shows"
    );
    await flip(panel, browser);
    await flip(panel, browser);
    Assert.equal(storedRule(), null, "turned back on, the site has no choice");
    await closePanel();
  });
  reset();
});

add_task(async function the_switch_shows_off_where_mozillas_fix_applies() {
  reset();
  await fixesOn();
  Assert.notDeepEqual(
    siteTargets(),
    globalTargets(),
    "Mozilla's entry relaxes the site"
  );
  await BrowserTestUtils.withNewTab(FIX_PAGE, async browser => {
    Assert.equal(await asPage(browser, canvasProbe), 0, "readback is real");
    const panel = await openPanel();
    Assert.deepEqual(
      fpSwitch(panel),
      { on: false, disabled: false, reason: "fix", note: true },
      "the switch is off, can be turned on, and the note says why"
    );
    await closePanel();
  });
  await fixesOff();
});

add_task(async function turning_it_on_keeps_the_fix_out() {
  reset();
  await fixesOn();
  await BrowserTestUtils.withNewTab(FIX_PAGE, async browser => {
    const panel = await openPanel();
    await flip(panel, browser);
    Assert.deepEqual(
      storedRule(),
      { protections: "full" },
      "the choice is stored where settings sync carries it"
    );
    Assert.deepEqual(
      siteTargets(),
      globalTargets(),
      "the site gets every target the global set has"
    );
    Assert.greater(
      await asPage(browser, canvasProbe),
      0,
      "canvas readback is noised again"
    );
    Assert.deepEqual(
      fpSwitch(panel),
      { on: true, disabled: false, reason: "", note: false },
      "the switch is on and no note shows"
    );
    await flip(panel, browser);
    Assert.deepEqual(
      storedRule(),
      { protections: "fingerprinting" },
      "turning it off is fingerprinting protection off"
    );
    Assert.equal(await asPage(browser, canvasProbe), 0, "readback is real");
    await flip(panel, browser);
    Assert.deepEqual(
      storedRule(),
      { protections: "full" },
      "turning it back on keeps the fix out again"
    );
    await closePanel();
  });
  await fixesOff();
  reset();
});

add_task(async function the_entry_follows_a_global_change() {
  reset();
  await fixesOn();
  SvalSiteProtections.setProtections(FIX_SITE, "full");
  const overrides = "privacy.fingerprintingProtection.overrides";
  await SpecialPowers.pushPrefEnv({
    set: [
      [overrides, `${Services.prefs.getStringPref(overrides)},+JSDateTimeUTC`],
    ],
  });
  try {
    await TestUtils.waitForCondition(
      () =>
        JSON.stringify(siteTargets()) === JSON.stringify(globalTargets()) &&
        // RFPTargets.inc: JSDateTimeUTC is 22.
        !!((siteTargets()[0] >>> 22) & 1),
      "the site's entry takes the changed set"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
  }
  await TestUtils.waitForCondition(
    () => JSON.stringify(siteTargets()) === JSON.stringify(globalTargets()),
    "and follows it back"
  );
  await fixesOff();
  reset();
});

add_task(async function a_choice_from_another_device_applies() {
  reset();
  await fixesOn();
  arrives({ protections: "full" });
  await BrowserTestUtils.withNewTab(FIX_PAGE, async browser => {
    Assert.greater(
      await asPage(browser, canvasProbe),
      0,
      "the synced choice keeps the fix out"
    );
    const panel = await openPanel();
    Assert.ok(fpSwitch(panel).on, "and the switch shows it on");
    await closePanel();
  });
  arrives(null);
  Assert.notDeepEqual(
    siteTargets(),
    globalTargets(),
    "its removal gives the site Mozilla's fix back"
  );
  await fixesOff();
  reset();
});

add_task(async function a_private_window_keeps_the_fix_and_says_so() {
  reset();
  await fixesOn();
  SvalSiteProtections.setProtections(FIX_SITE, "full");
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20000,
    "a private window opens"
  );
  try {
    SvalProtectionButton.startWindow(win);
    const browser = win.gBrowser.selectedBrowser;
    BrowserTestUtils.startLoadingURIString(browser, FIX_PAGE);
    await within(
      BrowserTestUtils.browserLoaded(browser),
      15_000,
      "the page loading in the private window"
    );
    Assert.equal(
      await asPage(browser, canvasProbe),
      0,
      "the fix applies in the private window"
    );
    const panel = await openPanel(win);
    Assert.deepEqual(
      fpSwitch(panel),
      { on: false, disabled: true, reason: "private-fix", note: true },
      "the switch is off, inert, and says why"
    );
    await closePanel(win);
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      20000,
      "the private window closes"
    );
    await fixesOff();
    reset();
  }
});
