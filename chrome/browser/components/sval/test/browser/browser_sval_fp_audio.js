/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * AudioContext's sample rate, output latency and channel count are real by
 * default, and one site can be given standard values (catalogue §2):
 * RFPTarget::AudioSampleRate and RFPTarget::AudioContext, written as that
 * site's granular entry. The choice syncs with the other per-site choices.
 */

const { SvalSiteProtections, SITE_BRANCH, OVERRIDE_PREFS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
const { SITE_EXCEPTIONS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
);

const SITE = "example.com";
const OTHER_PAGE = PAGE2.replace("https://example.com", "https://example.org");

/**
 * The fixed latency `AudioContext::OutputLatency` gives a context that
 * resists fingerprinting, at 44100 Hz.
 */
const STANDARD_LATENCY = {
  macosx: 512 / 44100,
  win: 0.04,
  linux: 0.025,
}[AppConstants.platform];

/** Evaluated in the page's own global, so it must stand alone. */
async function audioProbe() {
  const context = new AudioContext();
  const read = {
    sampleRate: context.sampleRate,
    baseLatency: context.baseLatency,
    outputLatency: context.outputLatency,
    maxChannelCount: context.destination.maxChannelCount,
  };
  await context.close();
  return JSON.stringify(read);
}

async function readAudio(browser) {
  return within(
    SpecialPowers.spawn(browser, [audioProbe.toString()], async src => {
      return JSON.parse(await content.wrappedJSObject.eval(`(${src})()`));
    }),
    10_000,
    "the page's audio values"
  );
}

/**
 * @param {string} url
 * @param {Window} [win]
 * @returns {Promise<object>} What a fresh page at `url` reads.
 */
async function readAt(url, win = window) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    10_000,
    "a new tab's load"
  );
  try {
    return await readAudio(tab.linkedBrowser);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

function checkStandard(audio, where) {
  Assert.deepEqual(
    audio,
    {
      sampleRate: 44100,
      baseLatency: 0,
      outputLatency: STANDARD_LATENCY,
      maxChannelCount: 2,
    },
    `${where}: the page reads standard audio values`
  );
}

/**
 * The values a page reads that the device fixes. A real context's output
 * latency is left out: `MediaTrackGraphImpl::AudioOutputLatency` reads 0
 * until an audio driver runs, so it varies between reads.
 *
 * @param {object} audio From `readAudio`.
 * @returns {object}
 */
function device(audio) {
  const { sampleRate, baseLatency, maxChannelCount } = audio;
  return { sampleRate, baseLatency, maxChannelCount };
}

/** @returns {string[][]} Each override pref's overrides for the site. */
function ownEntries() {
  return OVERRIDE_PREFS.map(name =>
    JSON.parse(Services.prefs.getStringPref(name, "") || "[]")
      .filter(e => e.firstPartyDomain === SITE)
      .map(e => e.overrides)
  );
}

function reset() {
  clearPrefBranches(SITE_BRANCH);
}

let real;

add_setup(async function () {
  reset();
  real = device(await readAt(PAGE2));
  Assert.deepEqual(
    device(await readAt(OTHER_PAGE)),
    real,
    "both sites read the device's values"
  );
  registerCleanupFunction(reset);
});

add_task(async function the_choice_adds_only_the_audio_targets() {
  const audio = SITE_EXCEPTIONS.find(e => e.id === "audio");
  Assert.deepEqual(
    [...audio.tokens],
    ["+AudioSampleRate", "+AudioContext"],
    "the choice turns both audio targets on"
  );
  Assert.ok(audio.adds, "and says it adds protection");
});

add_task(async function one_site_reads_standard_values() {
  SvalSiteProtections.setExceptions(SITE, ["audio"]);
  try {
    Assert.deepEqual(
      ownEntries(),
      [["+AudioSampleRate,+AudioContext"], ["+AudioSampleRate,+AudioContext"]],
      "both granular prefs carry the site's entry"
    );
    checkStandard(await readAt(PAGE2), "the chosen site");
    Assert.deepEqual(
      device(await readAt(OTHER_PAGE)),
      real,
      "another site still reads the device's values"
    );

    SvalSiteProtections.setProtections(SITE, "fingerprinting");
    Assert.deepEqual(
      device(await readAt(PAGE2)),
      real,
      "fingerprinting protection off supersedes the choice"
    );
    SvalSiteProtections.setProtections(SITE, "on");
  } finally {
    SvalSiteProtections.setExceptions(SITE, []);
  }
  Assert.deepEqual(ownEntries(), [[], []], "no choice, no entry");
  Assert.deepEqual(
    device(await readAt(PAGE2)),
    real,
    "and the site reads real values"
  );
});

add_task(async function a_synced_choice_applies() {
  // What settings sync applies from a device where the user chose it.
  Services.prefs.setStringPref(
    SITE_BRANCH + SITE,
    JSON.stringify({ exceptions: ["audio", "fonts"] })
  );
  try {
    const fonts = SITE_EXCEPTIONS.find(e => e.id === "fonts").tokens;
    Assert.deepEqual(
      ownEntries()[0],
      [[...fonts, "+AudioSampleRate", "+AudioContext"].join(",")],
      "the entry carries both choices"
    );
    checkStandard(await readAt(PAGE2), "the synced site");
  } finally {
    reset();
  }
});

add_task(async function a_hosts_choice_beats_its_sites() {
  const atHost = host =>
    PAGE2.replace("https://example.com", `https://${host}`);
  SvalSiteProtections.setExceptions("test1.example.com", ["audio"]);
  try {
    checkStandard(await readAt(atHost("test1.example.com")), "the chosen host");
    Assert.deepEqual(
      device(await readAt(atHost("test2.example.com"))),
      real,
      "its sibling still reads the device's values"
    );

    SvalSiteProtections.setExceptions("test1.example.com", []);
    SvalSiteProtections.setExceptions(SITE, ["audio"]);
    SvalSiteProtections.setExceptions("test1.example.com", []);
    Assert.deepEqual(
      SvalSiteProtections.ruleFor("test1.example.com").exceptions,
      [],
      "the host keeps none of its site's exceptions as a choice of its own"
    );
    Assert.deepEqual(
      device(await readAt(atHost("test1.example.com"))),
      real,
      "so the host reads the device's values"
    );
    checkStandard(
      await readAt(atHost("test2.example.com")),
      "its sibling, under the site's choice"
    );
  } finally {
    reset();
  }
});
