/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * WebGPU adapters report timestamp-query as unsupported
 * (RFPTarget::WebGPUTimestampQueryHidden), so a page cannot time GPU work
 * precisely, and requestDevice refuses it as an adapter that lacks it would.
 * A site can be given it back.
 *
 * Linux CI's image carries Mesa's software Vulkan driver, lavapipe, whose
 * adapter offers timestamp-query, so on Linux a missing adapter or feature is
 * a broken environment and fails. Elsewhere the task is skipped, and the
 * harness logs the skip, when there is no adapter or it lacks the feature:
 * a headless run has no GPU process (gfxPlatform::InitGPUProcessPrefs), and
 * on macOS and Windows WebGPU runs only there (dom.webgpu.allow-in-parent),
 * and a runner VM may have no GPU WebGPU can use.
 */

/** Evaluated in the page's own global, so it must stand alone. */
async function timestampProbe() {
  if (!navigator.gpu) {
    return JSON.stringify({ adapter: false });
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    return JSON.stringify({ adapter: false });
  }
  const listed = adapter.features.has("timestamp-query");
  let device;
  try {
    await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
    device = "created";
  } catch (e) {
    device = e.name;
  }
  return JSON.stringify({ adapter: true, listed, device });
}

async function readTimestamps(browser) {
  return within(
    SpecialPowers.spawn(browser, [timestampProbe.toString()], async src =>
      JSON.parse(await content.wrappedJSObject.eval(`(${src})()`))
    ),
    10_000,
    "the page's timestamps"
  );
}

const ADAPTER_EXPECTED = AppConstants.platform == "linux";

/** What the site reads with the feature given back, read once in setup. */
let lifted;

add_setup(async function read_the_lifted_site() {
  lifted = await withException("gpu-timing", () =>
    BrowserTestUtils.withNewTab(PAGE2, readTimestamps)
  );
  info(`Lifted site reads ${JSON.stringify(lifted)}`);
  Assert.equal(typeof lifted.adapter, "boolean", "the page answered the probe");
});

add_task(
  { skip_if: () => !ADAPTER_EXPECTED && !(lifted.adapter && lifted.listed) },
  async function timestamp_query_is_hidden_and_a_site_can_lift_it() {
    Assert.ok(lifted.adapter, "the page gets a WebGPU adapter");
    Assert.ok(lifted.listed, "the lifted site's adapter lists timestamp-query");
    Assert.equal(lifted.device, "created", "the lifted site can use it");

    const hidden = await BrowserTestUtils.withNewTab(PAGE2, readTimestamps);
    Assert.ok(!hidden.listed, "adapter.features lacks timestamp-query");
    Assert.equal(
      hidden.device,
      "TypeError",
      "requestDevice refuses timestamp-query"
    );
  }
);
