/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * navigator.hardwareConcurrency is a count drawn per first-party site and
 * browsing session from [max(2, ceil(real / 2)), real]
 * (RFPTarget::NavigatorHWConcurrencyRandomized, catalogue §3), from
 * the fingerprinting randomization key canvas and audio noise use. Dedicated,
 * shared and service workers read their document's count. A site with
 * fingerprinting protection off reads the real count.
 */

const { SvalSiteProtections } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

const at = host => PAGE2.replace("https://example.com", `https://${host}`);
const SITES = [
  "example.com",
  "example.org",
  "example.net",
  "xn--hxajbheg2az3al.xn--jxalpdlp",
];

/** The label SvalRFPService::RandomizedHardwareConcurrency keys its draw with. */
const LABEL = "NavigatorHWConcurrencyRandomized";

let real;
let lowest;

/**
 * Reads the core count a document and each kind of worker it starts see,
 * and the document's randomization key. Each call starts workers of its own,
 * under a fresh name, script URL and scope, so none started under other
 * settings answers. Evaluated in the page's own global, so it must stand
 * alone.
 *
 * @param {string} base The worker script's URL.
 */
async function coresProbe(base) {
  const unique = crypto.randomUUID();
  const script = `${base}?${unique}`;
  const answer = port =>
    new Promise((resolve, reject) => {
      port.onmessage = e => resolve(e.data);
      port.onmessageerror = reject;
    });
  const dedicated = new Worker(script);
  const fromDedicated = answer(dedicated);
  dedicated.postMessage("cores");
  const shared = new SharedWorker(script, unique);
  const fromShared = answer(shared.port);

  let service = null;
  if (navigator.serviceWorker) {
    const registration = await navigator.serviceWorker.register(script, {
      scope: `sval_fp_cores_scope/${unique}/`,
    });
    const worker =
      registration.installing || registration.waiting || registration.active;
    const fromService = answer(navigator.serviceWorker);
    worker.postMessage("cores");
    service = await fromService;
    await registration.unregister();
  }
  const read = {
    document: navigator.hardwareConcurrency,
    dedicated: await fromDedicated,
    shared: await fromShared,
    service,
  };
  dedicated.terminate();
  return JSON.stringify(read);
}

/**
 * @param {string} host
 * @param {Window} [win]
 * @returns {Promise<object>} What a fresh page on `host` reads, and its key.
 */
async function readAt(host, win = window) {
  const url = at(host);
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    10_000,
    "a new tab's load"
  );
  try {
    return await within(
      SpecialPowers.spawn(
        tab.linkedBrowser,
        [coresProbe.toString(), new URL("sval_fp_cores_worker.js", url).href],
        async (src, script) => {
          const read = JSON.parse(
            await content.wrappedJSObject.eval(`(${src})("${script}")`)
          );
          try {
            read.key =
              content.document.cookieJarSettings.fingerprintingRandomizationKey;
          } catch {
            read.key = null;
          }
          return read;
        }
      ),
      20_000,
      "the page's and its workers' counts"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

/**
 * The count SvalRFPService::RandomizedHardwareConcurrency draws from `key`.
 *
 * @param {number[]} key
 * @returns {Promise<number>}
 */
async function drawnFrom(key) {
  const hmac = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = new DataView(
    await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(LABEL))
  );
  return lowest + (digest.getUint32(0) % (real - lowest + 1));
}

/**
 * @param {object} read
 * @param {number} count
 * @param {string} what
 */
function assertEveryRealm(read, count, what) {
  for (const realm of ["document", "dedicated", "shared", "service"]) {
    if (realm === "service" && read.service === null) {
      continue;
    }
    Assert.equal(read[realm], count, `${what}: the ${realm} reads ${count}`);
  }
}

add_setup(async function () {
  // Chrome reads the count through the same RuntimeService::
  // ClampedHardwareConcurrency pages do, with RFP never applying to it. It is
  // the processor count Services.sysinfo reports, except on Intel Macs,
  // where it is the physical core count (nsMacUtilsImpl::IsTCSMAvailable).
  real = window.navigator.hardwareConcurrency;
  const intelMac =
    AppConstants.platform === "macosx" &&
    Services.sysinfo.getProperty("arch") === "x86-64";
  if (!intelMac) {
    Assert.equal(
      real,
      Math.min(
        (await Services.sysinfo.processInfo).count,
        Services.prefs.getIntPref("dom.maxHardwareConcurrency")
      ),
      "chrome reads the processor count Services.sysinfo reports"
    );
  }
  lowest = Math.min(real, Math.max(2, Math.ceil(real / 2)));
  info(`This machine reports ${real} cores; sites read ${lowest} to ${real}.`);
  registerCleanupFunction(async () => {
    SvalSiteProtections.setProtections("example.com", "on");
    // The service workers this file registers leave quota usage on each
    // site after they are unregistered.
    for (const site of SITES) {
      await within(
        new Promise(resolve =>
          Services.clearData.deleteDataFromSite(
            site,
            {},
            true,
            Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA,
            resolve
          )
        ),
        30_000,
        `${site}'s data clearing`
      );
    }
  });
});

add_task(async function a_site_reads_its_drawn_count_in_every_realm() {
  const read = await readAt("example.com");
  Assert.ok(read.key, "the site has a randomization key");
  Assert.notEqual(read.service, null, "the probe reached a service worker");
  Assert.greaterOrEqual(read.document, lowest, "at least half the real count");
  Assert.lessOrEqual(read.document, real, "at most the real count");
  assertEveryRealm(read, await drawnFrom(read.key), "drawn from the key");
});

add_task(async function a_site_reads_the_same_count_all_session() {
  const first = await readAt("example.com");
  const second = await readAt("example.com");
  Assert.deepEqual(second, first, "the site reads the same count and key");
});

add_task(async function each_site_draws_its_own_count() {
  const reads = [];
  for (const host of SITES) {
    const read = await readAt(host);
    assertEveryRealm(read, await drawnFrom(read.key), host);
    reads.push(read);
  }
  Assert.equal(
    new Set(reads.map(r => r.key.join())).size,
    SITES.length,
    "each site has its own key"
  );
});

add_task(async function fingerprinting_protection_off_reads_the_real_count() {
  SvalSiteProtections.setProtections("example.com", "fingerprinting");
  try {
    assertEveryRealm(await readAt("example.com"), real, "protection off");
    const other = await readAt("example.org");
    assertEveryRealm(other, await drawnFrom(other.key), "another site");
  } finally {
    SvalSiteProtections.setProtections("example.com", "on");
  }
});

add_task(async function a_private_window_draws_its_own_count() {
  const normal = await readAt("example.com");
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a new window opening"
  );
  try {
    const first = await readAt("example.com", win);
    const second = await readAt("example.com", win);
    Assert.deepEqual(second, first, "stable within the private session");
    Assert.notDeepEqual(
      first.key,
      normal.key,
      "the private session has its own key"
    );
    assertEveryRealm(first, await drawnFrom(first.key), "private");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});
