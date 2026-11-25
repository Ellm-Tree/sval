/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Nimbus, Mozilla's experiment and rollout client, ships only its feature
 * defaults: no enrollment store, no recipe loader, no Firefox Labs, no
 * targeting, no settings or policy for studies and rollouts. A feature's
 * values are its manifest's fallback prefs.
 */

const { Policies } = ChromeUtils.importESModule(
  "resource:///modules/policies/Policies.sys.mjs"
);
const { Troubleshoot } = ChromeUtils.importESModule(
  "resource://gre/modules/Troubleshoot.sys.mjs"
);
const NimbusModule = ChromeUtils.importESModule(
  "resource://nimbus/ExperimentAPI.sys.mjs"
);
const { NimbusFeatures } = NimbusModule;

add_task(function enrollment_does_not_ship() {
  for (const spec of [
    "resource://nimbus/lib/ExperimentManager.sys.mjs",
    "resource://nimbus/lib/ExperimentStore.sys.mjs",
    "resource://nimbus/lib/RemoteSettingsExperimentLoader.sys.mjs",
    "resource://nimbus/lib/SharedDataMap.sys.mjs",
    "resource://nimbus/FirefoxLabs.sys.mjs",
    "resource://nimbus/schemas/NimbusExperiment.schema.json",
    "chrome://browser/content/preferences/config/firefoxLabs.mjs",
    "resource:///modules/asrouter/ASRouterTargeting.sys.mjs",
    "resource://messaging-system/targeting/Targeting.sys.mjs",
  ]) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
  Assert.deepEqual(
    Object.keys(NimbusModule),
    ["NimbusFeatures", "_ExperimentFeature"],
    "the module offers features alone"
  );
});

add_task(function study_and_rollout_switches_are_gone() {
  for (const pref of [
    "app.shield.optoutstudies.enabled",
    "nimbus.rollouts.enabled",
    "messaging-system.rsexperimentloader.collection_id",
  ]) {
    Assert.equal(
      Services.prefs.getPrefType(pref),
      Services.prefs.PREF_INVALID,
      `${pref} has no value`
    );
  }
  Assert.ok(
    !("DisableRemoteImprovements" in Policies),
    "no DisableRemoteImprovements policy"
  );
});

add_task(async function a_feature_reads_its_fallback_pref() {
  const feature = NimbusFeatures.mailto;
  const PREF = "browser.mailto.dualPrompt";
  await feature.ready();
  Assert.equal(
    feature.getVariable("dualPrompt"),
    Services.prefs.getBoolPref(PREF),
    "a variable is its fallback pref"
  );
  Assert.equal(
    NimbusFeatures.whatsNewPage.getVariable("overrideUrl"),
    undefined,
    "a variable with no fallback pref has no value"
  );

  let updated = Promise.withResolvers();
  const onUpdate = (event, reason) => updated.resolve(reason);
  feature.onUpdate(onUpdate);
  await SpecialPowers.pushPrefEnv({
    set: [[PREF, !Services.prefs.getBoolPref(PREF)]],
  });
  Assert.equal(
    await within(updated.promise, 5_000, "the feature's update"),
    "pref-updated",
    "a fallback pref's change reaches the feature's listeners"
  );
  Assert.equal(
    feature.getVariable("dualPrompt"),
    Services.prefs.getBoolPref(PREF),
    "the variable follows its pref"
  );
  feature.offUpdate(onUpdate);
  await SpecialPowers.popPrefEnv();
});

add_task(async function settings_and_about_support_offer_no_experiments() {
  const tab = await openPage("about:preferences");
  const doc = tab.linkedBrowser.contentDocument;
  Assert.ok(
    !doc.getElementById("category-experimental"),
    "Settings has no Labs pane"
  );
  BrowserTestUtils.removeTab(tab);

  const snapshot = await within(
    Troubleshoot.snapshot(),
    30_000,
    "about:support's data"
  );
  Assert.ok(!("normandy" in snapshot), "about:support lists no enrollments");
});
