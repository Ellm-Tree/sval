/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Privacy and protection (decision 1484): its cards and Firefox's groups in
 * their order, and its Fingerprinting card (protections spec §3.3): every
 * switch writing exactly its RFP target
 * token or its prefs and back, Strict's three states, Restore with Undo, and
 * a page reading the real core count once the user asks for it.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const OVERRIDES = "privacy.fingerprintingProtection.overrides";

const FP = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
);

/** The strict items' ids: off by default, and what Strict turns on. */
const STRICT = FP.STRICT_ITEMS.map(item => item.id);

/**
 * Every pref the card writes, cleared at the start and end of each task, and
 * the privacy signals' prefs, which the card's other switches write.
 */
const PREFS = [
  ...FP.PREFS,
  "media.peerconnection.enabled",
  "media.peerconnection.ice.proxy_only",
  "privacy.globalprivacycontrol.enabled",
  "privacy.donottrackheader.enabled",
];

function clearAll() {
  for (const name of PREFS) {
    Services.prefs.clearUserPref(name);
  }
}

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
  // Each task starts from Sval's defaults; the file ends with the prefs as it
  // found them, which the harness's profile sets some of.
  keepPrefs(...PREFS);
  clearAll();
});

const tokens = () =>
  new Set(Services.prefs.getStringPref(OVERRIDES).split(",").filter(Boolean));

const DEFAULT_TOKENS = new Set(
  Services.prefs
    .getDefaultBranch("")
    .getStringPref(OVERRIDES)
    .split(",")
    .filter(Boolean)
);

/**
 * @param {string} name
 * @returns {*} The pref's value, whatever its type.
 */
function prefValue(name) {
  switch (Services.prefs.getPrefType(name)) {
    case Ci.nsIPrefBranch.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    case Ci.nsIPrefBranch.PREF_INT:
      return Services.prefs.getIntPref(name);
    case Ci.nsIPrefBranch.PREF_STRING:
      return Services.prefs.getStringPref(name);
  }
  return undefined;
}

/**
 * Opens settings on Privacy and protection.
 *
 * @returns {Promise<object>} `{ page, byId, pane }`.
 */
async function openProtections() {
  const ui = await openPane(
    "privacy",
    ({ byId }) => byId("sval-fp-strict")?.checkVisibility(),
    "the Fingerprinting card is showing"
  );
  return { ...ui, pane: paneOf(ui.page, "privacy") };
}

/**
 * Opens the fingerprinting and signals cards' Advanced, and every group.
 *
 * @param {object} ui From `openProtections`.
 */
function showEverything(ui) {
  ui.byId("sval-fp-advanced").open = true;
  ui.byId("sval-signals-advanced").open = true;
  for (const toggle of ui.pane.querySelectorAll(".sval-fp-group-toggle")) {
    if (toggle.getAttribute("aria-expanded") !== "true") {
      toggle.click();
    }
  }
}

const itemSwitch = (ui, id) =>
  ui.pane.querySelector(`input[data-sval-item="${id}"]`);

/**
 * Privacy and protection is one category, in the order a person reads it:
 * Sval's cards and Firefox's groups together, then Advanced.
 */
add_task(async function privacy_and_protection_holds_its_topics_in_order() {
  const ui = await openProtections();
  Assert.ok(
    !ui.byId("category-svalProtections"),
    "Protections is no category of its own"
  );
  await TestUtils.waitForCondition(
    () =>
      ui.pane.querySelector('setting-group[groupid="history2"]') &&
      ui.byId("sval-privacy-advanced")?.checkVisibility(),
    "the category's groups are drawn"
  );
  // The topics a person sees, outside Advanced: each card, and each group of
  // Firefox's or Sval's.
  const topics = [
    ...ui.pane.querySelectorAll(
      'setting-group[groupid], .sval-card, details[id="sval-privacy-advanced"]'
    ),
  ]
    .filter(
      el =>
        el.checkVisibility() &&
        !el.parentElement.closest(".sval-card, details, setting-group")
    )
    .map(
      el =>
        el.getAttribute("groupid") ||
        el.id ||
        el.getAttribute("aria-labelledby")
    );
  // Firefox's warnings head the category whenever it finds a problem.
  if (topics[0] === "securityPrivacyWarnings") {
    topics.shift();
  }
  Assert.deepEqual(
    topics,
    [
      "sval-blocking",
      "svalCookies",
      "sval-fp",
      "sval-signals",
      "httpsOnly",
      "svalSecureDns",
      "sval-breaches",
      "browsingProtection",
      "sval-password-manager-heading",
      ...(ui.byId("sval-security-keys").hidden ? [] : ["sval-security-keys"]),
      "history2",
      "sval-private-windows",
      "sval-privacy-advanced",
    ],
    "blocking, cookies, fingerprinting, signals, HTTPS-Only and Secure DNS, breach warnings and browsing protection, passwords, history, private windows, then Advanced"
  );
  const advanced = ui.byId("sval-privacy-advanced");
  Assert.deepEqual(
    [...advanced.querySelectorAll(".sval-card, setting-group")].map(
      el => el.id || el.getAttribute("groupid")
    ),
    [
      "sval-tracking-more",
      "sval-bookmarklets-card",
      "certificates",
      "networkProxy",
    ],
    "Advanced holds more tracking protection, bookmarklets, certificates and the proxy"
  );
});

add_task(async function every_switch_writes_its_tokens_or_prefs_and_back() {
  clearAll();
  const ui = await openProtections();
  showEverything(ui);
  const ids = [...ui.pane.querySelectorAll("input[data-sval-item]")].map(
    el => el.dataset.svalItem
  );
  Assert.deepEqual(
    ids.toSorted(),
    FP.ITEMS.map(item => item.id).toSorted(),
    "the card has a switch for every advanced setting"
  );

  for (const id of ids) {
    const item = FP.ITEMS.find(candidate => candidate.id === id);
    // Strict items and the compatibility fixes start off (decision 1685).
    const strict = !FP.isOnByDefault(item);
    Assert.equal(
      strict,
      STRICT.includes(id) || id === "moz-compat",
      `${id} ships ${strict ? "off" : "on"}`
    );
    Assert.equal(
      itemSwitch(ui, id).checked,
      !strict,
      `${id} starts ${strict ? "off" : "on"}`
    );
    itemSwitch(ui, id).click();
    Assert.equal(itemSwitch(ui, id).checked, strict, `${id} moved`);

    // Moved off Sval's default: a default-on switch goes off, a default-off
    // one on.
    const want = new Set(DEFAULT_TOKENS);
    for (const t of (strict ? item.off : item.on) ?? []) {
      want.delete(t);
    }
    for (const t of (strict ? item.on : item.off) ?? []) {
      want.add(t);
    }
    Assert.deepEqual(
      [...tokens()].toSorted(),
      [...want].toSorted(),
      `${id} writes exactly its tokens`
    );
    for (const [name, [onValue, offValue]] of Object.entries(
      item.prefs ?? {}
    )) {
      const value = strict ? onValue : offValue;
      if (value === undefined) {
        Assert.ok(
          !Services.prefs.prefHasUserValue(name),
          `${id} clears ${name}`
        );
      } else {
        Assert.equal(prefValue(name), value, `${id} sets ${name}`);
      }
    }

    itemSwitch(ui, id).click();
    for (const name of PREFS) {
      Assert.ok(
        !Services.prefs.prefHasUserValue(name),
        `${id} back: ${name} is at its default`
      );
    }
  }
});

add_task(async function shown_settings_write_their_prefs() {
  clearAll();
  const ui = await openProtections();
  const setting = id => ui.pane.querySelector(`[data-sval-setting="${id}"]`);
  const pick = (select, value) => {
    select.value = value;
    select.dispatchEvent(new ui.page.Event("change", { bubbles: true }));
  };

  Assert.ok(
    !setting("appearance"),
    "Theme is not here: its home is Appearance"
  );

  const webrtc = setting("webrtc");
  Assert.equal(webrtc.value, "on", "WebRTC allows calls");
  pick(webrtc, "proxy");
  Assert.ok(
    Services.prefs.getBoolPref("media.peerconnection.ice.proxy_only"),
    "proxy only"
  );
  pick(setting("webrtc"), "off");
  Assert.ok(
    !Services.prefs.getBoolPref("media.peerconnection.enabled"),
    "Block turns WebRTC off"
  );
  Assert.ok(
    !Services.prefs.prefHasUserValue("media.peerconnection.ice.proxy_only"),
    "and leaves proxy-only at its default"
  );
  pick(setting("webrtc"), "on");
  Assert.ok(
    !Services.prefs.prefHasUserValue("media.peerconnection.enabled") &&
      Services.prefs.getBoolPref(
        "media.peerconnection.ice.proxy_only_if_behind_proxy"
      ),
    "Allow calls is Sval's default, never bypassing a proxy"
  );

  const gpc = setting("gpc");
  Assert.ok(
    ui.byId("sval-signals").contains(gpc),
    "GPC is in the Privacy signals card"
  );
  Assert.ok(gpc.checked, "GPC starts on");
  gpc.click();
  Assert.ok(
    !Services.prefs.getBoolPref("privacy.globalprivacycontrol.enabled"),
    "GPC off"
  );
  setting("gpc").click();
  Assert.ok(
    !Services.prefs.prefHasUserValue("privacy.globalprivacycontrol.enabled"),
    "GPC back at Sval's default"
  );

  const cores = setting("real-cores");
  Assert.ok(!cores.checked, "real core count starts off");
  cores.click();
  Assert.ok(
    tokens().has("-NavigatorHWConcurrencyTiered") &&
      !tokens().has("+NavigatorHWConcurrencyRandomized"),
    "real core count takes the per-site count and the tiering away"
  );
  setting("real-cores").click();
  Assert.ok(!Services.prefs.prefHasUserValue(OVERRIDES), "and back");

  const languages = setting("all-languages");
  Assert.ok(!languages.checked, "all languages starts off");
  languages.click();
  Assert.ok(
    tokens().has("-LanguagesPrimaryOnly") &&
      !tokens().has("+LanguagesPrimaryOnly"),
    "all languages takes the primary-language target away"
  );
  setting("all-languages").click();
  Assert.ok(!Services.prefs.prefHasUserValue(OVERRIDES), "and back");
});

add_task(async function strict_reads_off_on_and_partly_on() {
  clearAll();
  const ui = await openProtections();
  const strict = ui.byId("sval-fp-strict");
  const line = ui.byId("sval-fp-strict-status");
  const status = () => line.textContent;
  const n = STRICT.length;
  const labelOf = id => FP.ITEMS.find(item => item.id === id).label;
  const numbers = () => (status().match(/\d+/g) ?? []).map(Number);

  Assert.equal(strict.getAttribute("role"), "checkbox");
  Assert.equal(strict.getAttribute("aria-checked"), "false");
  Assert.equal(line.dataset.state, "false", "the line says Strict is off");
  Assert.deepEqual(numbers(), [n], "of every strict item");

  strict.click();
  Assert.equal(strict.getAttribute("aria-checked"), "true");
  Assert.equal(line.dataset.state, "true", "the line says Strict is on");
  Assert.deepEqual(numbers(), [n], "every strict item");
  showEverything(ui);
  for (const id of STRICT) {
    Assert.ok(itemSwitch(ui, id).checked, `${id} is on`);
  }

  itemSwitch(ui, "tz").click();
  Assert.equal(strict.getAttribute("aria-checked"), "mixed");
  Assert.equal(
    line.dataset.state,
    "mixed",
    "the line says Strict is partly on"
  );
  Assert.deepEqual(numbers(), [n - 1, n], "how many of how many");
  Assert.stringContains(status(), labelOf("tz"), "naming the one off");

  strict.click();
  Assert.equal(
    strict.getAttribute("aria-checked"),
    "true",
    "clicking while mixed turns every strict item on"
  );
  Assert.ok(itemSwitch(ui, "tz").checked, "the one that was off too");

  strict.click();
  Assert.equal(strict.getAttribute("aria-checked"), "false");
  Assert.ok(!Services.prefs.prefHasUserValue(OVERRIDES), "all strict off");
  for (const name of PREFS) {
    Assert.ok(!Services.prefs.prefHasUserValue(name), `${name} at default`);
  }

  itemSwitch(ui, "fps").click();
  Assert.equal(strict.getAttribute("aria-checked"), "mixed");
  Assert.deepEqual(numbers().slice(0, 2), [1, n], "how many of how many");
  Assert.stringContains(status(), labelOf("fps"), "naming the one on");
  itemSwitch(ui, "fps").click();
});

add_task(async function restore_resets_and_undo_puts_it_back() {
  clearAll();
  const ui = await openProtections();
  const restore = ui.byId("sval-fp-restore");
  Assert.ok(restore.disabled, "Restore is disabled at Sval's defaults");

  showEverything(ui);
  itemSwitch(ui, "canvas-noise").click();
  itemSwitch(ui, "kb").click();
  ui.pane.querySelector('[data-sval-setting="gpc"]').click();
  Assert.ok(!restore.disabled, "Restore is offered once something changed");
  const before = new Map(PREFS.map(name => [name, prefValue(name)]));

  restore.click();
  for (const name of PREFS) {
    Assert.ok(!Services.prefs.prefHasUserValue(name), `${name} restored`);
  }
  Assert.ok(restore.disabled, "Restore is disabled again");
  const message = ui.byId("sval-fp-message");
  const undo = message.querySelector("button");
  Assert.equal(undo.dataset.svalKey, "fp-undo", "with its Undo");

  undo.click();
  for (const name of PREFS) {
    Assert.equal(prefValue(name), before.get(name), `${name} is back`);
  }
  Assert.ok(!itemSwitch(ui, "canvas-noise").checked, "the switch shows it");
  Assert.equal(message.textContent, "", "the status line clears");

  ui.byId("sval-fp-restore").click();
  Assert.ok(message.querySelector("button"), "Undo is offered again");
  Services.prefs.setBoolPref("privacy.globalprivacycontrol.enabled", false);
  Assert.equal(
    message.textContent,
    "",
    "a change from elsewhere takes the stale Undo away"
  );
  clearAll();
});

add_task(async function fingerprinting_advanced_is_the_cards_own_disclosure() {
  clearAll();
  const ui = await openProtections();
  const details = ui.byId("sval-fp-advanced");
  Assert.equal(
    details.parentElement,
    ui.byId("sval-fp"),
    "the card holds its Advanced"
  );
  Assert.equal(details, ui.byId("sval-fp").lastElementChild, "at its foot");
  Assert.ok(!details.open, "closed at first");
  const graphics = ui.pane.querySelector(
    '#sval-fp-items [data-sval-key="group:graphics"]'
  );
  Assert.ok(graphics, "an advanced-only group is in it");
  Assert.ok(!graphics.checkVisibility(), "out of sight while it is closed");
  Assert.equal(
    ui.byId("sval-fp-advanced-changed").textContent,
    "",
    "nothing in it is changed"
  );

  Services.prefs.setStringPref(
    OVERRIDES,
    Services.prefs.getStringPref(OVERRIDES) + ",-JSMathFdlibm"
  );
  await TestUtils.waitForCondition(
    () => ui.byId("sval-fp-advanced-changed").textContent,
    "a pref change from elsewhere shows on the closed Advanced"
  );
  Assert.ok(!ui.byId("sval-fp-restore").disabled, "and Restore is offered");

  details.querySelector("summary").click();
  Assert.ok(
    ui.pane
      .querySelector('#sval-fp-items [data-sval-key="group:graphics"]')
      .checkVisibility(),
    "opening it shows the groups"
  );
  clearAll();
});

add_task(async function report_my_real_core_count_reaches_the_page() {
  clearAll();
  // Chrome reads the count through the same RuntimeService::
  // ClampedHardwareConcurrency pages do, with RFP never applying to it.
  const real = window.navigator.hardwareConcurrency;
  const lowest = Math.min(real, Math.max(2, Math.ceil(real / 2)));
  const pageCores = browser =>
    SpecialPowers.spawn(browser, [], () =>
      content.wrappedJSObject.eval("navigator.hardwareConcurrency")
    );

  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    const count = await pageCores(browser);
    Assert.ok(
      count >= lowest && count <= real,
      `the page sees a per-site count between ${lowest} and ${real}`
    );
  });

  const ui = await openProtections();
  ui.pane.querySelector('[data-sval-setting="real-cores"]').click();
  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    Assert.equal(
      await pageCores(browser),
      real,
      "the page sees the real count"
    );
  });
  clearAll();
});

const byId = id => FP.ITEMS.find(i => i.id === id);

add_task(function webgl_noise_alone_takes_efficient_randomization_away() {
  clearAll();
  FP.setSwitches(
    new Map([
      [byId("canvas-noise"), false],
      [byId("gl-noise"), true],
    ])
  );
  Assert.ok(
    tokens().has("-EfficientCanvasRandomization"),
    "WebGL noise is not shadowed by efficient randomization"
  );
  Assert.ok(tokens().has("+WebGLRandomization"), "WebGL noise is on");
  Assert.ok(
    tokens().has("-CanvasRandomization"),
    "and 2D canvas noise stays off"
  );
  Assert.ok(!FP.isOn(byId("canvas-noise")), "Canvas noise reads off");
  Assert.ok(FP.isOn(byId("gl-noise")), "WebGL noise reads on");
  clearAll();
});

add_task(function the_last_token_for_a_target_wins() {
  clearAll();
  Services.prefs.setStringPref(OVERRIDES, "+KeyboardEvents,-KeyboardEvents");
  Assert.ok(!FP.isOn(byId("kb")), "+X,-X reads off");
  Services.prefs.setStringPref(OVERRIDES, "-KeyboardEvents,+KeyboardEvents");
  Assert.ok(FP.isOn(byId("kb")), "-X,+X reads on");
  clearAll();
});

add_task(function all_targets_turns_every_target_on() {
  clearAll();
  Services.prefs.setStringPref(OVERRIDES, "+AllTargets");
  for (const item of FP.ITEMS.filter(i => i.on)) {
    const plus = [...item.on, ...item.off].every(t => t.startsWith("+"));
    if (plus || !item.on.length) {
      Assert.ok(FP.isOn(item), `${item.id} reads on under +AllTargets`);
    }
  }
  Services.prefs.setStringPref(OVERRIDES, "-AllTargets,+Gamepad");
  Assert.ok(FP.isOn(byId("gp-block")), "a target after -AllTargets is on");
  Assert.ok(!FP.isOn(byId("lang-fonts")), "and every other is off");
  clearAll();
});

add_task(function a_switch_turns_off_under_a_hand_set_all_targets() {
  clearAll();
  Services.prefs.setStringPref(OVERRIDES, "+AllTargets");
  FP.setSwitches(new Map([[byId("kb"), false]]));
  Assert.ok(!FP.isOn(byId("kb")), "the switch turns off under +AllTargets");
  Assert.ok(tokens().has("-KeyboardEvents"), "by writing -KeyboardEvents");
  Assert.ok(tokens().has("+AllTargets"), "and +AllTargets stays");
  Assert.ok(FP.isOn(byId("gp-block")), "every other target stays on");
  FP.setSwitches(new Map([[byId("kb"), true]]));
  Assert.ok(FP.isOn(byId("kb")), "and turns back on");
  Assert.ok(!tokens().has("-KeyboardEvents"), "dropping -KeyboardEvents");
  clearAll();
});

/**
 * Privacy signals has the one Global Privacy Control, and Do Not Track in
 * the card's Advanced.
 */
add_task(async function privacy_signals_hold_gpc_and_dnt() {
  clearAll();
  const ui = await openProtections();
  const doc = ui.page.document;
  Assert.equal(
    doc.querySelectorAll('[data-sval-setting="gpc"]').length,
    1,
    "one Global Privacy Control"
  );
  await TestUtils.waitForCondition(
    () => doc.querySelector('setting-group[groupid="history2"]'),
    "Firefox's groups are drawn"
  );
  Assert.ok(!doc.getElementById("gpcEnabled"), "and none of Firefox's");

  const dnt = () => ui.pane.querySelector('[data-sval-setting="dnt"]');
  await TestUtils.waitForCondition(
    () => ui.byId("sval-signals").checkVisibility() && dnt(),
    "Privacy signals is showing"
  );
  Assert.ok(!dnt().checkVisibility(), "Do Not Track is advanced");
  showEverything(ui);
  Assert.ok(dnt().checkVisibility(), "and shows once Advanced opens");
  Assert.ok(!dnt().checked, "off by default");
  dnt().click();
  Assert.ok(
    Services.prefs.getBoolPref("privacy.donottrackheader.enabled"),
    "it is the pref"
  );
  dnt().click();
  Assert.ok(
    !Services.prefs.prefHasUserValue("privacy.donottrackheader.enabled")
  );
  clearAll();
});

add_task(async function each_strict_says_what_it_is_strict_about() {
  const ui = await openProtections();
  const fingerprinting = ui.pane
    .querySelector(".sval-fp-strict-title")
    .textContent.trim();
  const blocking = ui.byId("sval-blocking-heading").textContent.trim();
  Assert.ok(
    fingerprinting && blocking && fingerprinting != blocking,
    "the two cards' titles each name their own Strict"
  );
  Assert.ok(
    !ui.page.document.querySelector('setting-group[groupid="etpStatus"]'),
    "and tracking protection has no Strict of its own"
  );
});

/**
 * @param {string} css A computed colour, `rgb()` or `rgba()`.
 * @returns {number[]} Its red, green, blue and alpha.
 */
function rgba(css) {
  const [r, g, b, a = 1] = css.match(/[\d.]+/g).map(Number);
  return [r, g, b, a];
}

/**
 * @param {number[]} top
 * @param {number[]} bottom Opaque.
 * @returns {number[]} `top` painted over `bottom`.
 */
function over(top, bottom) {
  return [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3]));
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Their WCAG contrast ratio.
 */
function contrast(a, b) {
  const lum = rgb => {
    const [R, G, B] = rgb.slice(0, 3).map(c => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * @param {Window} page
 * @param {string} value A colour, or a `var()` of one.
 * @returns {number[]} It as the page computes it.
 */
function resolved(page, value) {
  const probe = page.document.createElement("div");
  probe.style.backgroundColor = value;
  page.document.querySelector(".sval-pane").append(probe);
  const color = rgba(page.getComputedStyle(probe).backgroundColor);
  probe.remove();
  return color;
}

/**
 * An off switch can be found and read by low-vision users: its track is 3:1
 * against the card, and its knob 3:1 against the track, in light and dark
 * (WCAG 1.4.11).
 */
add_task(async function an_off_switch_has_3_to_1_contrast() {
  const ui = await openProtections();
  const bc = ui.tab.linkedBrowser.browsingContext;
  const before = bc.prefersColorSchemeOverride;
  try {
    for (const scheme of ["light", "dark"]) {
      bc.prefersColorSchemeOverride = scheme;
      await TestUtils.waitForCondition(
        () => ui.page.matchMedia(`(prefers-color-scheme: ${scheme})`).matches,
        `the page is ${scheme}`
      );
      const off = ui.byId("sval-fp-strict");
      Assert.equal(off.getAttribute("aria-checked"), "false", "Strict is off");
      // The track eases into the scheme's colour.
      await Promise.all(off.getAnimations().map(a => a.finished));
      const track = rgba(ui.page.getComputedStyle(off).backgroundColor);
      const card = over(
        rgba(
          ui.page.getComputedStyle(off.closest(".sval-card")).backgroundColor
        ),
        resolved(ui.page, "var(--sval-page)")
      );
      const knob = resolved(ui.page, "var(--sval-switch-knob-off)");
      Assert.greaterOrEqual(
        contrast(over(track, card), card),
        3,
        `${scheme}: the off track stands out from the card`
      );
      Assert.greaterOrEqual(
        contrast(knob, over(track, card)),
        3,
        `${scheme}: the knob stands out from the track`
      );
    }
  } finally {
    bc.prefersColorSchemeOverride = before;
  }
});
