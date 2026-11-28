/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Secure DNS: the network's DNS by default, the card's three
 * choices and the mode each writes, the resolver shown only for encrypted
 * DNS, the names that skip it saved through Firefox's dialog, ECH staying on,
 * and Privacy and protection without Firefox's DoH group.
 *
 * No resolver is ever reached: both resolvers' names resolve to 127.0.0.1,
 * TRR's confirmation lookup is off, and no page loads while encrypted DNS is
 * on.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalSecureDns, CHOICES, MODE_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecureDns.sys.mjs"
);
const { DoHConfigController } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/doh/DoHConfig.sys.mjs"
);

const QUAD9 = "https://dns.quad9.net/dns-query";
const CLOUDFLARE = "https://cloudflare-dns.com/dns-query";
const EXCLUDED_PREF = "network.trr.excluded-domains";
const URI_PREF = "network.trr.uri";

const gDNSOverride = Cc[
  "@mozilla.org/network/native-dns-override;1"
].getService(Ci.nsINativeDNSResolverOverride);

function clearAll() {
  for (const name of [MODE_PREF, URI_PREF, EXCLUDED_PREF]) {
    Services.prefs.clearUserPref(name);
  }
}

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
  for (const host of ["dns.quad9.net", "cloudflare-dns.com"]) {
    gDNSOverride.addIPOverride(host, "127.0.0.1");
  }
  await SpecialPowers.pushPrefEnv({
    set: [["network.trr.confirmationNS", "skip"]],
  });
  clearAll();
  registerCleanupFunction(() => {
    clearAll();
    for (const host of ["dns.quad9.net", "cloudflare-dns.com"]) {
      gDNSOverride.clearHostOverride(host);
    }
  });
});

/**
 * Opens settings on Privacy and protection, with the Secure DNS card drawn.
 *
 * @returns {Promise<object>} `{ page, tab, group, control }`.
 */
async function openCard() {
  let group;
  const control = id => group?.querySelector(`#setting-control-${id}`);
  const ui = await openPane(
    "privacy",
    ({ page }) => {
      group = page.document.querySelector(
        '[data-sval-pane="svalSecureDns"] setting-group[groupid="svalSecureDns"]'
      );
      return control("svalSecureDnsChoice")?.checkVisibility();
    },
    "the Secure DNS card is showing"
  );
  return { ...ui, group, control };
}

/**
 * @param {object} ui From `openCard`.
 * @param {string} value
 */
async function pick(ui, value) {
  const radio = [
    ...ui.control("svalSecureDnsChoice").querySelectorAll("moz-radio"),
  ].find(r => r.value === value);
  radio.click();
  const mode = SvalSecureDns.modeOf(value);
  await TestUtils.waitForCondition(
    () => Services.prefs.getIntPref(MODE_PREF) === mode,
    `${value} writes mode ${mode}`
  );
}

const resolverShown = ui =>
  ui.control("svalSecureDnsResolver").checkVisibility();

add_task(function the_default_is_the_networks_dns() {
  const defaults = Services.prefs.getDefaultBranch("");
  Assert.equal(defaults.getIntPref(MODE_PREF), 0, "mode 0 by default");
  Assert.ok(!Services.prefs.prefHasUserValue(MODE_PREF), "nothing set");
  Assert.equal(SvalSecureDns.current().value, "network");
  Assert.ok(
    !Services.prefs.getBoolPref("doh-rollout.enabled"),
    "Mozilla's rollout is off"
  );
  Assert.deepEqual(
    DoHConfigController.currentConfig.providerList.map(p => [p.UIName, p.uri]),
    [
      ["Quad9", QUAD9],
      ["Cloudflare", CLOUDFLARE],
    ],
    "the resolvers are Sval's, Quad9 first"
  );
  Assert.equal(DoHConfigController.currentConfig.fallbackProviderURI, QUAD9);
  Assert.equal(
    defaults.getStringPref("network.trr.default_provider_uri"),
    QUAD9,
    "an empty resolver URL means Quad9"
  );
});

add_task(async function each_choice_writes_its_mode_and_shows_the_resolver() {
  clearAll();
  const ui = await openCard();
  const radios = [
    ...ui.control("svalSecureDnsChoice").querySelectorAll("moz-radio"),
  ];
  Assert.deepEqual(
    radios.map(r => r.value),
    ["network", "fallback", "strict"],
    "the three choices, in order"
  );
  Assert.ok(
    radios.every(r => r.label),
    "each with its label"
  );
  Assert.equal(ui.control("svalSecureDnsChoice").value, "network");
  Assert.ok(!resolverShown(ui), "no resolver for the network's DNS");

  await pick(ui, "fallback");
  Assert.equal(Services.prefs.getIntPref(MODE_PREF), 2);
  await TestUtils.waitForCondition(
    () => resolverShown(ui),
    "the resolver shows for encrypted DNS"
  );
  const select = ui.group.querySelector("moz-select#dohProviderSelect");
  Assert.equal(select.value, QUAD9, "Quad9 is pre-selected");
  Assert.deepEqual(
    [...select.querySelectorAll("moz-option")].map(o => o.value),
    [QUAD9, CLOUDFLARE, "custom"],
    "Quad9, Cloudflare or a custom URL"
  );
  Assert.ok(
    ui.group.querySelector("moz-box-button#dohExceptionsButton"),
    "the internal names sit with the resolver"
  );

  await pick(ui, "strict");
  Assert.equal(Services.prefs.getIntPref(MODE_PREF), 3);
  Assert.ok(resolverShown(ui), "the resolver stays for encrypted only");

  await pick(ui, "network");
  Assert.equal(Services.prefs.getIntPref(MODE_PREF), 0);
  await TestUtils.waitForCondition(
    () => !resolverShown(ui),
    "the resolver hides again"
  );
  clearAll();
});

add_task(async function a_resolver_choice_writes_its_url() {
  clearAll();
  const ui = await openCard();
  await pick(ui, "fallback");
  await TestUtils.waitForCondition(() => resolverShown(ui), "resolver shown");
  const select = ui.group.querySelector("moz-select#dohProviderSelect");
  select.value = CLOUDFLARE;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await TestUtils.waitForCondition(
    () => Services.prefs.getStringPref(URI_PREF) === CLOUDFLARE,
    "Cloudflare's URL is saved"
  );
  await pick(ui, "network");
  clearAll();
});

add_task(async function mozillas_cloudflare_url_shows_as_cloudflare() {
  clearAll();
  Services.prefs.setStringPref(
    URI_PREF,
    "https://mozilla.cloudflare-dns.com/dns-query"
  );
  const ui = await openCard();
  await pick(ui, "fallback");
  await TestUtils.waitForCondition(() => resolverShown(ui), "resolver shown");
  const select = ui.group.querySelector("moz-select#dohProviderSelect");
  await TestUtils.waitForCondition(
    () => select.value === CLOUDFLARE,
    "the select names Cloudflare"
  );
  Assert.ok(
    !ui.control("dohCustomProvider").checkVisibility(),
    "and shows no custom URL field"
  );
  await pick(ui, "network");
  clearAll();
});

add_task(async function internal_names_are_saved() {
  clearAll();
  const ui = await openCard();
  await pick(ui, "fallback");
  await TestUtils.waitForCondition(() => resolverShown(ui), "resolver shown");
  ui.group.querySelector("moz-box-button#dohExceptionsButton").click();
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = ui.page.gSubDialog._topDialog?._frame?.contentWindow;
    return (
      dialog?.document.readyState === "complete" &&
      dialog.document.getElementById("btnAddException")
    );
  }, "Firefox's exceptions dialog opens");
  const url = dialog.document.getElementById("url");
  url.focus();
  EventUtils.sendString("intranet.example", dialog);
  dialog.document.getElementById("btnAddException").click();
  dialog.document.querySelector("dialog").getButton("accept").doCommand();
  await TestUtils.waitForCondition(
    () => Services.prefs.getStringPref(EXCLUDED_PREF) === "intranet.example",
    "the name is saved to network.trr.excluded-domains"
  );
  await pick(ui, "network");
  clearAll();
});

add_task(function ech_follows_encrypted_dns() {
  clearAll();
  const defaults = Services.prefs.getDefaultBranch("");
  for (const name of [
    "network.dns.echconfig.enabled",
    "network.dns.http3_echconfig.enabled",
  ]) {
    Assert.ok(defaults.getBoolPref(name), `${name} is on by default`);
  }
  for (const choice of CHOICES) {
    SvalSecureDns.choose(choice.value);
    Assert.equal(Services.prefs.getIntPref(MODE_PREF), choice.mode);
    Assert.ok(
      Services.prefs.getBoolPref("network.dns.echconfig.enabled") &&
        Services.prefs.getBoolPref("network.dns.http3_echconfig.enabled"),
      `ECH stays on with ${choice.value}`
    );
  }
  clearAll();
});

add_task(async function privacy_and_protection_has_no_doh_group() {
  clearAll();
  const ui = await openCard();
  await showPane(ui.page, "privacy");
  await TestUtils.waitForCondition(
    () =>
      ui.page.document.querySelector(
        '[data-category="panePrivacy"] setting-group[groupid="httpsOnly"]'
      ),
    "Privacy and protection drew its groups"
  );
  Assert.ok(
    !ui.page.document.querySelector('setting-group[groupid="dnsOverHttps"]'),
    "Firefox's DoH group is not in Privacy and protection"
  );
  Assert.ok(
    !ui.page.document.querySelector(
      'setting-group[groupid="dnsOverHttpsAdvanced"]'
    ),
    "nor its advanced group"
  );

  await showPane(ui.page, "privacy-doh");
  await TestUtils.waitForCondition(
    () => ui.group.checkVisibility(),
    "Firefox's DoH address lands on the Secure DNS card"
  );
});
