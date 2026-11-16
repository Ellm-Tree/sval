/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The Privacy and Security button and its panel (protections spec §2):
 * its state for each kind of page, the counts from the tab's content-blocking
 * log, each switch writing its store and reloading, and private windows'
 * choices staying apart. Media is the site controls'
 * (`browser_sval_site_controls.js`).
 */

const { SvalSiteProtections, SITE_BRANCH, GRANULAR_PREFS, OVERRIDE_PREFS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
const { SvalProtectionButton, compatFixApplies, stateOf } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
  );

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);

const { RemoteSettings } = ChromeUtils.importESModule(
  "resource://services-settings/remote-settings.sys.mjs"
);

/* import-globals-from sval_blocking_helpers.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);

const PROT_PAGE = "https://example.com/";
const SITE = "example.com";
const EMBEDS_PAGE =
  "https://example.com/browser/browser/components/sval/test/browser/sval_protection_embeds.html";

const PROTECTION_ENGINES =
  "privacy.trackingprotection.content.protection.engines";
const ANNOTATION_ENGINES =
  "privacy.trackingprotection.content.annotation.engines";

/**
 * Puts Gecko's test lists for its content classifier in front of the
 * profile's own engines until the task ends: `block`'s rules block requests
 * as trackers (`test_block`), and `annotate`'s mark a request as a tracker
 * when it loads (`test_annotate`). The prefs split their lists of addresses
 * on "|", so each list's own are escaped.
 *
 * @param {object} lists
 * @param {string[]} lists.block
 * @param {string[]} [lists.annotate]
 */
async function useTestLists({ block, annotate = [] }) {
  const listUrl = rules =>
    `data:text/plain,${encodeURIComponent(rules.join("\n"))}`;
  const inFront = (pref, feature) =>
    [feature, ...Services.prefs.getStringPref(pref, "").split(",")]
      .filter(Boolean)
      .join(",");
  const features = [
    "test_block",
    ...(annotate.length ? ["test_annotate"] : []),
  ];
  const installed = features.map(feature =>
    within(
      TestUtils.topicObserved(LISTS_LOADED, (subject, names) =>
        (names ?? "").split(",").includes(feature)
      ),
      30_000,
      `the ${feature} engine`
    )
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ...CONTENT_BLOCKING_TEST_PREFS,
      [
        "privacy.trackingprotection.content.protection.test_list_urls",
        listUrl(block),
      ],
      [PROTECTION_ENGINES, inFront(PROTECTION_ENGINES, "test_block")],
      ...(annotate.length
        ? [
            [
              "privacy.trackingprotection.content.annotation.test_list_urls",
              listUrl(annotate),
            ],
            [ANNOTATION_ENGINES, inFront(ANNOTATION_ENGINES, "test_annotate")],
          ]
        : []),
    ],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await Promise.all(installed);
}

/**
 * Requests each of `urls` from the page, as the page; a blocked one fails.
 *
 * @param {Element} browser
 * @param {string[]} urls
 */
function fetchAll(browser, urls) {
  return within(
    SpecialPowers.spawn(browser, [urls], async targets => {
      for (const url of targets) {
        await content.fetch(url, { mode: "no-cors" }).catch(() => {});
      }
    }),
    10_000,
    "the page's requests"
  );
}

/**
 * In the page, through `asPage`: reads back a canvas of the size
 * `nsRFPService::MaybeReportCanvasFingerprinter` reports as a fingerprinter
 * (650 by 12), then looks up more missing fonts in a moment than
 * `nsFontCache::kFingerprintingCacheMissThreshold`, which
 * `nsRFPService::MaybeReportFontFingerprinter` reports.
 *
 * @returns {number}
 */
function fingerprint() {
  const canvas = document.createElement("canvas");
  canvas.width = 650;
  canvas.height = 12;
  canvas.getContext("2d").fillText("sval", 2, 10);
  canvas.toDataURL();
  const span = document.createElement("span");
  span.textContent = "mmmmmmmmmmlli";
  document.body.append(span);
  let width = 0;
  for (let i = 0; i < 30; i++) {
    span.style.fontFamily = `sval-missing-font-${i}, monospace`;
    width += span.offsetWidth;
  }
  span.remove();
  return width;
}

/**
 * @param {string} origin
 * @param {number|null} [session] A private window's session, as its jar.
 * @returns {nsIPrincipal}
 */
function principalOf(origin, session = null) {
  return Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(origin),
    session === null ? {} : { privateBrowsingId: 1, userContextId: session }
  );
}

function buttonIn(win = window) {
  return win.document.getElementById("sval-protection-button");
}

async function openPanel(win = window) {
  const panel = panelIn(win);
  const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
  buttonIn(win).click();
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
 * Sets a site's pref as settings sync applies another device's choice for
 * it, or its removal with none.
 *
 * @param {string} site
 * @param {object|null} rule
 */
function arrives(site, rule) {
  if (rule) {
    Services.prefs.setStringPref(SITE_BRANCH + site, JSON.stringify(rule));
  } else {
    Services.prefs.clearUserPref(SITE_BRANCH + site);
  }
}

/** @returns {string[]} The sites this profile holds a synced choice for. */
function syncedSites() {
  return Services.prefs
    .getChildList(SITE_BRANCH)
    .map(name => name.slice(SITE_BRANCH.length));
}

function reset() {
  for (const site of syncedSites()) {
    arrives(site, null);
  }
  for (const name of GRANULAR_PREFS) {
    Services.prefs.clearUserPref(name);
  }
  Services.perms.removeAll();
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Sval's default, Gecko's own; the harness allows autoplay.
      ["media.autoplay.default", Ci.nsIAutoplay.BLOCKED],
    ],
  });
  registerCleanupFunction(() => {
    reset();
  });
});

add_task(function the_media_gate_is_on_by_default() {
  Assert.ok(
    Services.prefs
      .getDefaultBranch("")
      .getBoolPref("media.autoplay.site-permission-only"),
    "sval ships the media gate on"
  );
});

add_task(async function svals_button_shows() {
  await BrowserTestUtils.withNewTab(PROT_PAGE, async () => {
    Assert.ok(buttonIn().checkVisibility(), "sval's button shows");
  });
});

/**
 * Firefox's site button, a badge on its own pages and extension pages naming
 * the browser or the extension, is gone from the address bar. Sval's button
 * stands in for it there too, and its name says what the page is.
 */
add_task(async function no_firefox_badge_on_an_internal_page() {
  const badgeHidden = page => {
    Assert.ok(
      !document.getElementById("identity-icon-box"),
      `no Firefox badge on ${page}`
    );
    Assert.ok(BrowserTestUtils.isVisible(buttonIn()), `sval's button shows`);
  };
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    Assert.ok(
      document.getElementById("identity-box").classList.contains("chromeUI"),
      "Firefox reads about:preferences as its own page"
    );
    badgeHidden("about:preferences");
  });

  const extension = ExtensionTestUtils.loadExtension({
    manifest: { name: "Badge Test" },
    files: { "page.html": "<!DOCTYPE html><title>page</title>page" },
  });
  await extension.startup();
  try {
    await BrowserTestUtils.withNewTab(
      `moz-extension://${extension.uuid}/page.html`,
      async () => {
        Assert.ok(
          document
            .getElementById("identity-box")
            .classList.contains("extensionPage"),
          "Firefox reads it as an extension's page"
        );
        badgeHidden("an extension's page");
        Assert.equal(buttonIn().dataset.page, "extension", "as an extension's");
        Assert.ok(
          buttonIn().getAttribute("aria-label").includes("Badge Test"),
          "the button's name carries the extension's name"
        );
        await openPanel();
        try {
          Assert.equal(
            panelIn().querySelector(".sval-prot-domain").textContent,
            "Badge Test",
            "the panel names the extension"
          );
          Assert.equal(
            panelIn().querySelector(".sval-prot-body").dataset.page,
            "extension",
            "the panel describes an extension's page"
          );
          Assert.equal(
            document.getElementById("sval-prot-conn").localName,
            "div",
            "its connection line opens no certificate view"
          );
          Assert.ok(
            panelIn().querySelector(".sval-prot-internal"),
            "and says protections don't apply to extensions' pages"
          );
        } finally {
          await closePanel();
        }
      }
    );
  } finally {
    await extension.unload();
  }
});

add_task(async function the_button_follows_the_page() {
  reset();
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    Assert.ok(buttonIn().checkVisibility(), "an internal page keeps it");
    Assert.equal(buttonIn().dataset.look, "internal", "as a plain shield");
    Assert.equal(buttonIn().dataset.page, "sval", "named as Sval's own page");
  });
  await BrowserTestUtils.withNewTab(PROT_PAGE, async () => {
    Assert.equal(buttonIn().dataset.look, "on", "protected");
    const on = buttonIn().getAttribute("aria-label");
    SvalSiteProtections.setProtections(SITE, "off");
    Assert.equal(buttonIn().dataset.look, "off", "off for an exempt site");
    Assert.notEqual(
      buttonIn().getAttribute("aria-label"),
      on,
      "and its name changes with it"
    );
  });
  reset();
});

add_task(async function a_synced_choice_redraws_the_button() {
  reset();
  await BrowserTestUtils.withNewTab(PROT_PAGE, async () => {
    arrives(SITE, { protections: "off" });
    Assert.equal(buttonIn().dataset.look, "off", "off as the choice arrives");
    arrives(SITE, null);
    Assert.equal(
      buttonIn().dataset.look,
      "on",
      "and on again as its removal arrives, without a reload"
    );
  });
  reset();
});

add_task(async function the_panel_counts_what_the_log_records() {
  reset();
  await useTestLists({
    block: ["||example.org^"],
    annotate: ["||example.org^"],
  });
  const reload = async browser => {
    const reloaded = BrowserTestUtils.browserLoaded(browser, false, PROT_PAGE);
    browser.reload();
    await within(reloaded, 15_000, "the page's reload");
  };
  const count = row => row.querySelector(".sval-prot-count").textContent;
  const muted = row =>
    row.querySelector(".sval-prot-count").classList.contains("sval-prot-muted");
  await BrowserTestUtils.withNewTab(PROT_PAGE, async browser => {
    await fetchAll(browser, [
      "https://example.org/",
      "https://www.example.org/",
    ]);
    await asPage(browser, fingerprint);
    // Firefox's fingerprinters blocker also blocks the probing page, which
    // is counted once, as a fingerprinter.
    const { STATE_BLOCKED_SUSPICIOUS_FINGERPRINTING } =
      Ci.nsIWebProgressListener;
    const probedBlocked = () =>
      JSON.parse(browser.getContentBlockingLog() || "{}")[
        `https://${SITE}`
      ]?.some(([state]) => state & STATE_BLOCKED_SUSPICIOUS_FINGERPRINTING);
    await TestUtils.waitForCondition(() => {
      const log = stateOf(window).log;
      return log.blocked === 2 && log.canvas && log.fonts && probedBlocked();
    }, "the two trackers and the probing page blocked, and both probes recorded");
    Assert.equal(buttonIn().dataset.look, "active", "filled");
    Assert.deepEqual(
      buttonIn().getAttribute("aria-label").match(/\d+/g),
      ["2", "1"],
      "the button's name counts the trackers and the fingerprinter"
    );
    Assert.ok(
      buttonIn().hasAttribute("sval-count"),
      "the shield wears a count"
    );
    Assert.equal(
      buttonIn().querySelector(".sval-prot-count").textContent,
      "3",
      "of every row in the panel"
    );
    const panel = await openPanel();
    Assert.equal(panel.querySelector(".sval-prot-body").dataset.look, "active");
    const trackers = panel.querySelector('[data-row="pr-tracker"]');
    Assert.equal(count(trackers), "2");
    Assert.ok(!muted(trackers), "counted as blocked");
    const fp = panel.querySelector('[data-row="pr-fingerprint"]');
    Assert.equal(count(fp), "1", "the page's own origin probed");
    Assert.ok(
      fp.querySelector(".sval-prot-sub"),
      "the sub-line names the heuristics"
    );
    Assert.equal(
      count(panel.querySelector('[data-row="pr-ads"]')),
      "0",
      "a row with nothing to count shows zero"
    );
    await closePanel();

    SvalSiteProtections.setProtections(SITE, "off");
    await reload(browser);
    await fetchAll(browser, ["https://example.org/"]);
    await TestUtils.waitForCondition(
      () => stateOf(window).log.allowed === 1,
      "the tracker that loaded is counted"
    );
    Assert.equal(stateOf(window).log.blocked, 0, "and nothing was blocked");
    const off = await openPanel();
    Assert.equal(
      off.querySelector(".sval-prot-body").dataset.look,
      "off",
      "the rows count what was allowed"
    );
    const loaded = off.querySelector('[data-row="pr-tracker"]');
    Assert.equal(count(loaded), "1");
    Assert.ok(muted(loaded), "counted as loaded");
    await closePanel();

    SvalSiteProtections.setProtections(SITE, "on");
    await reload(browser);
    const none = await openPanel();
    Assert.deepEqual(
      [...none.querySelectorAll(".sval-prot-row")].map(count),
      ["0", "0", "0"],
      "every row shows that nothing was blocked"
    );
    await closePanel();
  });
  reset();
});

/**
 * The button's name counts blocked ads beside trackers, as its filled shield
 * and the panel's Ads row do. My filters block as ads: they are one more of
 * the ads engine's lists (`SvalBlocking.apply`).
 */
add_task(async function the_name_counts_blocked_ads() {
  reset();
  const filters = SvalBlocking.myFilters;
  await SpecialPowers.pushPrefEnv({ set: [...CONTENT_BLOCKING_TEST_PREFS] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  atTaskEnd(() => SvalBlocking.setMyFilters(filters));
  SvalBlocking.setMyFilters(
    [filters, "||test1.example.net^", "||test2.example.net^"].join("\n")
  );
  await BrowserTestUtils.withNewTab(REQUEST_PAGE, browser =>
    untilBlocked(
      browser,
      "https://test1.example.net/browser/browser/components/sval/test/browser/sval_agent_page.html",
      "my filters in force"
    )
  );
  await useTestLists({ block: ["||example.org^"] });
  const counted = () => {
    const counts = stateOf(window).log;
    const name = buttonIn().getAttribute("aria-label");
    return {
      blocked: counts.blocked,
      ads: counts.ads,
      digits: name.match(/\d+/g)?.map(Number),
    };
  };
  await BrowserTestUtils.withNewTab(PROT_PAGE, async browser => {
    await fetchAll(browser, ["https://test1.example.net/"]);
    await TestUtils.waitForCondition(
      () => stateOf(window).log.ads === 1,
      "the ad is counted"
    );
    Assert.equal(buttonIn().dataset.look, "active", "filled");
    Assert.deepEqual(
      counted(),
      { blocked: 0, ads: 1, digits: [1] },
      "the name counts the ad alone"
    );
    await fetchAll(browser, [
      "https://test2.example.net/",
      "https://example.org/",
    ]);
    await TestUtils.waitForCondition(() => {
      const { ads, blocked } = stateOf(window).log;
      return ads === 2 && blocked === 1;
    }, "the second ad and the tracker are counted");
    Assert.deepEqual(
      counted(),
      { blocked: 1, ads: 2, digits: [1, 2] },
      "the name counts the tracker and both ads"
    );
  });
  reset();
});

/**
 * A loaded page that goes on to load trackers: the button names every one
 * Gecko blocked, and the open panel counts them as they are blocked,
 * leaving the user on the control they were on.
 */
add_task(async function the_count_follows_each_tracker_blocked() {
  reset();
  await useTestLists({ block: ["||example.org^"] });
  const digits = attr => buttonIn().getAttribute(attr).match(/\d+/g)?.[0];
  await BrowserTestUtils.withNewTab(PROT_PAGE, async browser => {
    Assert.equal(buttonIn().dataset.look, "on", "nothing blocked yet");
    await fetchAll(browser, ["https://example.org/"]);
    await TestUtils.waitForCondition(
      () => digits("aria-label") === "1",
      "the first tracker is counted"
    );
    await fetchAll(browser, [
      "https://www.example.org/",
      "https://test1.example.org/",
    ]);
    await TestUtils.waitForCondition(
      () => digits("title") === "3",
      "every tracker after it is counted"
    );
    Assert.equal(stateOf(window).log.blocked, 3, "as trackers blocked");

    const panel = await openPanel();
    const count = () =>
      panel.querySelector('[data-row="pr-tracker"] .sval-prot-count')
        .textContent;
    Assert.equal(count(), "3", "the panel opens on the count");
    const toggle = panel.querySelector(".sval-prot-switch");
    toggle.focus();
    await fetchAll(browser, ["https://test2.example.org/"]);
    await TestUtils.waitForCondition(
      () => count() === "4",
      "the open panel counts the next one"
    );
    Assert.equal(
      document.activeElement,
      toggle,
      "the switch the user is on keeps its focus"
    );
    await closePanel();
  });
  reset();
});

add_task(async function the_main_switch_writes_the_allow_list_and_reloads() {
  reset();
  await BrowserTestUtils.withNewTab(PROT_PAGE, async browser => {
    const panel = await openPanel();
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    panel.querySelector("#sval-prot-main").click();
    await within(
      reloaded,
      15_000,
      "the page's reload after turning protection off"
    );
    Assert.equal(
      Services.perms.testPermissionFromPrincipal(
        principalOf("https://www.example.com"),
        "trackingprotection"
      ),
      Services.perms.ALLOW_ACTION,
      "the site and its subdomains are on Firefox's allow list"
    );
    Assert.deepEqual(SvalSiteProtections.ruleFor(SITE), { protections: "off" });
    Assert.equal(panel.state, "open", "the panel stays open over the reload");
    await TestUtils.waitForCondition(
      () =>
        panel.querySelector("#sval-prot-main")?.getAttribute("aria-checked") ===
        "false",
      "the panel shows the new state"
    );
    Assert.equal(
      panel.querySelector("#sval-prot-fp").getAttribute("aria-disabled"),
      "true",
      "fingerprinting is inert while protections are off"
    );
    Assert.equal(
      panel.querySelector(".sval-prot-body").dataset.look,
      "off",
      "the rows count what was allowed"
    );
    const back = BrowserTestUtils.browserLoaded(browser);
    panel.querySelector("#sval-prot-main").click();
    await within(
      back,
      15_000,
      "the page's reload after turning protection back on"
    );
    Assert.equal(
      Services.perms.testExactPermissionFromPrincipal(
        principalOf(PROT_PAGE),
        "trackingprotection"
      ),
      Services.perms.UNKNOWN_ACTION,
      "turning it back on removes the exception"
    );
    await closePanel();
  });
  reset();
});

add_task(async function the_fingerprinting_switch_unnoises_the_site() {
  reset();
  Services.prefs.setStringPref(
    GRANULAR_PREFS[0],
    JSON.stringify([{ firstPartyDomain: "other.test", overrides: "+Gamepad" }])
  );
  await BrowserTestUtils.withNewTab(PROT_PAGE, async browser => {
    Assert.greater(await asPage(browser, canvasProbe), 0, "noised at first");
    const panel = await openPanel();
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    panel.querySelector("#sval-prot-fp").click();
    await within(
      reloaded,
      15_000,
      "the page's reload after turning fingerprinting protection off"
    );
    for (const name of OVERRIDE_PREFS) {
      const entries = JSON.parse(Services.prefs.getStringPref(name));
      Assert.ok(
        entries.some(
          e => e.firstPartyDomain === SITE && e.overrides === "-AllTargets"
        ),
        `${name} holds the site's entry`
      );
    }
    Assert.ok(
      JSON.parse(Services.prefs.getStringPref(GRANULAR_PREFS[0])).some(
        e => e.firstPartyDomain === "other.test"
      ),
      "a person's own entry is kept"
    );
    Assert.equal(await asPage(browser, canvasProbe), 0, "readback is real");
    const back = BrowserTestUtils.browserLoaded(browser);
    panel.querySelector("#sval-prot-fp").click();
    await within(
      back,
      15_000,
      "the page's reload after turning fingerprinting protection back on"
    );
    Assert.equal(
      Services.prefs.getStringPref(OVERRIDE_PREFS[1], ""),
      "",
      "the entry goes when the switch is back on"
    );
    await closePanel();
  });
  reset();
});

add_task(async function a_synced_canvas_exception_unnoises_the_site() {
  reset();
  const { SITE_EXCEPTIONS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
  );
  const canvas = SITE_EXCEPTIONS.find(e => e.id === "canvas").tokens.join(",");
  const own = () =>
    OVERRIDE_PREFS.map(name =>
      JSON.parse(Services.prefs.getStringPref(name, "") || "[]")
        .filter(e => e.firstPartyDomain === SITE)
        .map(e => e.overrides)
    );
  await BrowserTestUtils.withNewTab(PROT_PAGE, async browser => {
    Assert.greater(await asPage(browser, canvasProbe), 0, "noised at first");
    // What settings sync applies from a device where the user lifted it.
    arrives(SITE, { exceptions: ["canvas"] });
    Assert.deepEqual(own(), [[canvas], [canvas]], "both prefs lift canvas");
    Assert.ok(
      canvas.includes("-CanvasRandomization") && !canvas.includes("AllTargets"),
      "and only the canvas targets"
    );
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await within(reloaded, 15_000, "the page's reload");
    Assert.equal(await asPage(browser, canvasProbe), 0, "readback is real");

    SvalSiteProtections.setProtections(SITE, "fingerprinting");
    Assert.deepEqual(
      own(),
      [["-AllTargets"], ["-AllTargets"]],
      "fingerprinting protection off takes the entry's place"
    );
    SvalSiteProtections.setProtections(SITE, "on");
    Assert.deepEqual(own(), [[canvas], [canvas]], "and gives it back");
    SvalSiteProtections.setExceptions(SITE, []);
    Assert.deepEqual(own(), [[], []], "no exceptions, no entry");
    Assert.deepEqual(SvalSiteProtections.ruleFor(SITE), {}, "nor a rule");
  });
  reset();
});

add_task(async function an_exception_site_follows_a_global_change() {
  reset();
  // RFPTargets.inc: JSDateTimeUTC is 22, outside Sval's default set.
  const utc = () => {
    const set = Services.rfp.getFingerprintingOverrides(`${SITE},0`);
    return !!((set.getNth32BitSet(0) >>> 22) & 1);
  };
  SvalSiteProtections.setExceptions(SITE, ["canvas"]);
  Assert.ok(!utc(), "the site starts without the strict timezone");
  const overrides = "privacy.fingerprintingProtection.overrides";
  await SpecialPowers.pushPrefEnv({
    set: [
      [overrides, `${Services.prefs.getStringPref(overrides)},+JSDateTimeUTC`],
    ],
  });
  try {
    await TestUtils.waitForCondition(utc, "the site's entry follows the set");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
  await TestUtils.waitForCondition(() => !utc(), "and follows it back");
  reset();
});

add_task(async function an_exception_carries_mozillas_fix_along() {
  reset();
  // Mozilla's fixes are off by default (decision 1685).
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.fingerprintingProtection.remoteOverrides.enabled", true]],
  });
  // Mozilla's fixes as a Remote Settings sync brings them to this device.
  const client = RemoteSettings("fingerprinting-protection-overrides");
  // A copy never synced has no timestamp, and is put back with none.
  const keptAt = await client.db.getLastModified();
  const keptMetadata = await client.db.getMetadata();
  const kept = keptAt === null ? [] : await client.db.list();
  const synced = async (records, at, metadata = {}) => {
    await client.db.importChanges(metadata, at, records, { clear: true });
    await client.emit("sync", {
      data: { current: records, created: records, updated: [], deleted: [] },
    });
  };
  await synced(
    [
      { firstPartyDomain: SITE, thirdPartyDomain: "*", overrides: "-Gamepad" },
      { firstPartyDomain: SITE, overrides: "-ScreenPixelDepth" },
      { firstPartyDomain: "other.test", overrides: "-WebVTT" },
    ].map(record => ({ id: crypto.randomUUID(), ...record })),
    Date.now()
  );
  try {
    SvalSiteProtections.setExceptions(SITE, ["fonts"]);
    const entry = JSON.parse(
      Services.prefs.getStringPref(OVERRIDE_PREFS[0])
    ).find(e => e.firstPartyDomain === SITE);
    Assert.equal(
      entry.overrides,
      "-Gamepad,-ScreenPixelDepth,-FontVisibilityLangPack",
      "Mozilla's tokens, narrower scope last, then the exception's"
    );
    Assert.ok(
      compatFixApplies(SITE, false),
      "the panel still says a compatibility fix applies"
    );
    Assert.ok(
      !JSON.parse(Services.prefs.getStringPref(OVERRIDE_PREFS[1]))
        .find(e => e.firstPartyDomain === SITE)
        .overrides.includes("Gamepad"),
      "the baseline entry takes only baseline fixes"
    );
  } finally {
    await synced(kept, keptAt, keptMetadata);
    reset();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(function an_address_gecko_would_not_read_gets_no_entry() {
  reset();
  for (const site of ["127.0.0.1", "::1", "localhost", "intranet"]) {
    Assert.ok(!SvalSiteProtections.canWriteFor(site), `${site} is refused`);
    SvalSiteProtections.setExceptions(site, ["canvas"]);
  }
  for (const site of [
    "example.co.uk",
    "example.photography",
    "xn--p1ai.xn--p1ai",
  ]) {
    Assert.ok(SvalSiteProtections.canWriteFor(site), `${site} can have one`);
  }
  Assert.equal(
    Services.prefs.getStringPref(OVERRIDE_PREFS[0], ""),
    "",
    "no entry Gecko would drop is written"
  );
  reset();
});

add_task(function a_synced_name_that_is_not_a_site_is_dropped() {
  reset();
  arrives("www.example.com", { media: "allow" });
  arrives("example.com", { media: "block" });
  arrives("not a site", { media: "allow" });
  Assert.deepEqual(
    [...SvalSiteProtections.rules().keys()],
    ["example.com"],
    "only names siteOf gives back unchanged are kept"
  );
  reset();
});

add_task(async function a_private_windows_choices_stay_apart() {
  reset();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a new private window opening"
  );
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, PROT_PAGE);
  await pageReady(browser, PROT_PAGE);
  await TestUtils.waitForCondition(
    () => SvalProtectionButton.forWindow(win),
    "the private window's button"
  );
  const panel = await openPanel(win);
  Assert.ok(
    panel.querySelector(".sval-prot-footer"),
    "the private footer, which syncs nothing"
  );
  Assert.ok(!panel.querySelector(".sval-prot-manage"), "no Manage sites");
  const reloaded = BrowserTestUtils.browserLoaded(browser);
  panel.querySelector("#sval-prot-main").click();
  await within(
    reloaded,
    15_000,
    "the private page's reload after turning protection off"
  );
  const session = win.gBrowser.defaultUserContextId;
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(
      principalOf(PROT_PAGE, session),
      "trackingprotection-pb"
    ),
    Services.perms.ALLOW_ACTION,
    "the private exception is Firefox's private one, the window's own"
  );
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(
      principalOf(PROT_PAGE),
      "trackingprotection"
    ),
    Services.perms.UNKNOWN_ACTION,
    "the normal window is untouched"
  );
  Assert.deepEqual(syncedSites(), [], "nothing synced");
  Assert.equal(SvalSiteProtections.protectionsFor(SITE), "on");
  Assert.equal(SvalSiteProtections.protectionsFor(SITE, session), "off");
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
  await TestUtils.waitForCondition(
    () => SvalSiteProtections.protectionsFor(SITE, session) === "on",
    "private choices go with their window"
  );
  reset();
});

add_task(function choices_arriving_through_sync_apply() {
  reset();
  const { SvalSettingsRegistry } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
  );
  Assert.ok(
    SvalSettingsRegistry.SYNCED_PREFS.includes(
      SvalSiteProtections.MEDIA_DEFAULT_PREF
    ),
    "the media default for sites with no choice syncs"
  );
  Assert.ok(
    SvalSettingsRegistry.SYNCED_BRANCHES.includes(SITE_BRANCH),
    "and so does each site's choice"
  );
  arrives("example.net", { protections: "off", media: "block" });
  arrives("example.org", { protections: "fingerprinting" });
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(
      principalOf("https://example.net"),
      "trackingprotection"
    ),
    Services.perms.ALLOW_ACTION
  );
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(
      principalOf("https://example.net"),
      "autoplay-media"
    ),
    Services.perms.DENY_ACTION
  );
  Assert.ok(
    Services.prefs
      .getStringPref(OVERRIDE_PREFS[0])
      .includes('"firstPartyDomain":"example.org"')
  );
  arrives("example.net", null);
  arrives("example.org", null);
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(
      principalOf("https://example.net"),
      "autoplay-media"
    ),
    Services.perms.UNKNOWN_ACTION,
    "a removal arriving through sync applies too"
  );
  Assert.equal(Services.prefs.getStringPref(OVERRIDE_PREFS[0], ""), "");
  reset();
});

add_task(async function a_private_window_cannot_turn_fingerprinting_off() {
  reset();
  SvalSiteProtections.setProtections(SITE, "fingerprinting", 0);
  Assert.equal(
    SvalSiteProtections.protectionsFor(SITE, 0),
    "on",
    "the store refuses a private fingerprinting choice"
  );
  for (const name of OVERRIDE_PREFS) {
    Assert.equal(Services.prefs.getStringPref(name, ""), "", `${name} empty`);
  }
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a new private window opening"
  );
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, PROT_PAGE);
  await pageReady(browser, PROT_PAGE);
  await TestUtils.waitForCondition(
    () => SvalProtectionButton.forWindow(win),
    "the private window's button"
  );
  const panel = await openPanel(win);
  const fp = panel.querySelector("#sval-prot-fp");
  Assert.equal(
    fp.getAttribute("aria-disabled"),
    "true",
    "the switch is inert in a private window"
  );
  Assert.equal(fp.dataset.reason, "private", "and says why");
  Assert.ok(
    fp.ariaDescribedByElements[0]?.checkVisibility(),
    "under it, as its description"
  );
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
  reset();
});

add_task(async function an_address_says_why_fingerprinting_stays_on() {
  reset();
  await BrowserTestUtils.withNewTab(
    "http://127.0.0.1:8888/browser/browser/components/sval/test/browser/sval_agent_page.html",
    async () => {
      const panel = await openPanel();
      const fp = panel.querySelector("#sval-prot-fp");
      Assert.equal(
        fp.getAttribute("aria-disabled"),
        "true",
        "the switch is inert on an address"
      );
      Assert.equal(fp.dataset.reason, "unwritable", "for an address");
      Assert.ok(
        fp.ariaDescribedByElements[0]?.checkVisibility(),
        "and says why under it"
      );
      Assert.ok(
        !panel.querySelector("#sval-prot-main").hasAttribute("aria-disabled"),
        "turning every protection off still works"
      );
      await closePanel();
    }
  );
  for (const name of OVERRIDE_PREFS) {
    Assert.equal(Services.prefs.getStringPref(name, ""), "", `${name} empty`);
  }
  reset();
});

/**
 * A site's choices reach Gecko without being saved a second time, so none
 * can outlive the pref that holds it, through a restart included.
 */
add_task(function a_choice_is_saved_only_in_its_pref() {
  reset();
  arrives("example.net", { protections: "off", media: "allow" });
  arrives("example.org", { protections: "fingerprinting", media: "block" });
  arrives("example.com", { exceptions: ["canvas"] });
  const perms = Services.perms.getAllByTypes([
    "trackingprotection",
    "autoplay-media",
  ]);
  Assert.ok(perms.length, "the choices reach the permission manager");
  Assert.ok(
    perms.every(p => p.expireType === Services.perms.EXPIRE_SESSION),
    "as permissions the profile does not save"
  );
  for (const name of OVERRIDE_PREFS) {
    Assert.ok(
      Services.prefs.getStringPref(name, ""),
      `${name} holds the fingerprinting choices`
    );
    Assert.ok(!Services.prefs.prefHasUserValue(name), "and is not saved");
  }
  reset();
});

/**
 * Clicks the first of the page's shim placeholders once there are `count`,
 * as a person would, and resolves with the prompt it opens on Sval's button.
 * Each placeholder sits in a closed shadow root in place of its embed
 * (`createShimPlaceholders` in the webcompat add-on).
 *
 * @param {Element} browser
 * @param {number} count
 * @returns {Promise<Element>} the prompt.
 */
async function promptFromPlaceholder(browser, count) {
  Assert.equal(gBrowser.selectedBrowser, browser, "the page's tab is in front");
  const { panel } = PopupNotifications;
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  await within(
    SpecialPowers.spawn(browser, [count], async expected => {
      const buttons = () =>
        [...content.document.querySelectorAll("div")]
          .map(div =>
            div.openOrClosedShadowRoot?.getElementById(
              "smartblock-placeholder-button"
            )
          )
          .filter(Boolean);
      await ContentTaskUtils.waitForCondition(
        () => buttons().length === expected,
        "each blocked embed has its placeholder"
      );
      const [button] = buttons();
      Assert.ok(button.checkVisibility(), "the placeholder's button shows");
      const { left, top, width, height } = button.getBoundingClientRect();
      Assert.equal(
        content.document.elementFromPoint(left + width / 2, top + height / 2),
        button.getRootNode().host,
        "and nothing covers it"
      );
      EventUtils.synthesizeMouseAtCenter(button, {}, content);
    }),
    15_000,
    "the placeholder's button clicked"
  );
  await within(shown, 10_000, "the prompt");
  const prompt = panel.firstElementChild;
  Assert.equal(
    PopupNotifications.getNotification("sval-smartblock-embed", browser)
      .anchorElement.parentElement,
    buttonIn(),
    "the prompt is on the protection button"
  );
  return prompt;
}

/**
 * Answers the prompt with Allow, waits for the page's embeds to stand in
 * place of their placeholders, and resolves with the embeds it unblocked,
 * each as `[tab, shimId]`. The webcompat add-on records the site's opt-in
 * before it puts an embed back (`onSmartBlockEmbedUnblock` in its
 * `lib/shims.js`), and a page loaded before then is shimmed again.
 *
 * @param {Element} browser
 * @param {Element} prompt
 * @returns {Promise<Array>}
 */
async function allowEmbeds(browser, prompt) {
  const { panel } = PopupNotifications;
  const unblocked = [];
  const observe = (subject, _topic, shimId) =>
    unblocked.push([subject, shimId]);
  Services.obs.addObserver(observe, "smartblock:unblock-embed");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  try {
    Assert.ok(prompt.button.checkVisibility(), "the Allow button shows");
    prompt.button.click();
    await within(hidden, 10_000, "the prompt closing");
  } finally {
    Services.obs.removeObserver(observe, "smartblock:unblock-embed");
  }
  await within(
    SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(
        () =>
          ![...content.document.querySelectorAll("div")].some(div =>
            div.openOrClosedShadowRoot?.getElementById(
              "smartblock-placeholder-button"
            )
          ),
        "no placeholder left"
      )
    ),
    10_000,
    "the embeds back in place of their placeholders"
  );
  return unblocked.sort(([, a], [, b]) => (a < b ? -1 : 1));
}

/**
 * A blocked embed's placeholder button asks on Sval's button whether to let
 * the page's embeds load, and only the answer there sends Firefox's unblock,
 * for the embeds still blocked. Gecko's test list blocks the embeds' scripts
 * as trackers, and the webcompat add-on's shims put their placeholders in.
 */
add_task(async function a_blocked_embeds_button_asks_before_it_loads() {
  await useTestLists({
    block: ["||www.instagram.com^", "||www.tiktok.com^", "||twitter.com^"],
  });
  // An allowed embed's shim loads the embed's own script. The harness ends
  // the run on any connection past its proxy, so these hosts resolve to this
  // machine, where the request fails.
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "network.dns.localDomains",
        "www.instagram.com,www.tiktok.com,platform.twitter.com",
      ],
    ],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const optedIn = new Set();
  await BrowserTestUtils.withNewTab(`${EMBEDS_PAGE}?twitter`, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    const first = await promptFromPlaceholder(browser, 1);
    Assert.deepEqual(
      await allowEmbeds(browser, first),
      [[tab, "TwitterEmbed"]],
      "allowing unblocks the page's one embed"
    );
    optedIn.add("TwitterEmbed");

    const all = `${EMBEDS_PAGE}?instagram,tiktok,twitter`;
    BrowserTestUtils.startLoadingURIString(browser, all);
    await pageReady(browser, all);
    const prompt = await promptFromPlaceholder(browser, 2);
    const { STATE_ALLOWED_TRACKING_CONTENT } = Ci.nsIWebProgressListener;
    await within(
      TestUtils.waitForCondition(() =>
        JSON.parse(browser.getContentBlockingLog() || "{}")[
          "https://platform.twitter.com"
        ]?.some(([state]) => state & STATE_ALLOWED_TRACKING_CONTENT)
      ),
      10_000,
      "the embed allowed before loading as allowed"
    );
    const unblocked = await allowEmbeds(browser, prompt);
    for (const [, shimId] of unblocked) {
      optedIn.add(shimId);
    }
    Assert.deepEqual(
      unblocked,
      [
        [tab, "InstagramEmbed"],
        [tab, "TikTokEmbed"],
      ],
      "it unblocks only the embeds still blocked, for this tab"
    );
    // The opt-ins last the session; this puts the embeds back to blocked.
    for (const shimId of optedIn) {
      const reloaded = BrowserTestUtils.browserLoaded(browser, false, all);
      Services.obs.notifyObservers(tab, "smartblock:reblock-embed", shimId);
      await within(reloaded, 10_000, "the page reloading blocked");
    }
    optedIn.clear();
  });
});

add_task(async function an_earlier_exception_reads_as_off_and_clears() {
  reset();
  const www = "https://www.example.com/";
  Services.perms.addFromPrincipal(
    principalOf(www),
    "trackingprotection",
    Services.perms.ALLOW_ACTION
  );
  await BrowserTestUtils.withNewTab(www, async browser => {
    await TestUtils.waitForCondition(
      () => buttonIn().dataset.look === "off",
      "Firefox's own exception reads as off"
    );
    const panel = await openPanel();
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    panel.querySelector("#sval-prot-main").click();
    await within(
      reloaded,
      15_000,
      "the page's reload after turning protection on"
    );
    Assert.equal(
      Services.perms.testExactPermissionFromPrincipal(
        principalOf(www),
        "trackingprotection"
      ),
      Services.perms.UNKNOWN_ACTION,
      "turning protections on clears the subdomain's exception"
    );
    await TestUtils.waitForCondition(
      () => buttonIn().dataset.look !== "off",
      "the button follows"
    );
    await closePanel();
  });
  reset();
});

/**
 * Each site's choices are the one setting settings sync carries for that
 * site, so a change here is that site's alone.
 */
add_task(function a_choice_is_its_sites_own_synced_setting() {
  reset();
  SvalSiteProtections.setMedia("example.net", "allow");
  SvalSiteProtections.setProtections("example.org", "off");
  Assert.deepEqual(
    JSON.parse(Services.prefs.getStringPref(SITE_BRANCH + "example.net")),
    { media: "allow" },
    "one site's choice is in its own pref"
  );
  SvalSiteProtections.setRule("example.net", null);
  Assert.deepEqual(
    syncedSites(),
    ["example.org"],
    "and removing it leaves every other site's as it was"
  );
  reset();
});
