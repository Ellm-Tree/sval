/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Each sample of the audio output a page reads is scaled by its own gain
 * just under 1, fixed per first-party site and browsing session and drawn
 * from the samples themselves (RFPTarget::AudioOutputRandomization,
 * catalogue §2): an OfflineAudioContext's rendered buffer, an AnalyserNode's
 * data, the input a ScriptProcessorNode or an AudioWorkletProcessor reads,
 * and a DynamicsCompressorNode's reduction. A reference signal rendered
 * alongside cannot divide the noise out. A site with fingerprinting
 * protection off reads the raw output.
 */

const { SvalSiteProtections } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

const FP = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
);

/**
 * Turns the advanced switch `id` to `on`, as the card does.
 *
 * @param {string} id A `SvalFingerprinting.ITEMS` id.
 * @param {boolean} on
 */
function setSwitch(id, on) {
  FP.setSwitches(new Map([[FP.ITEMS.find(item => item.id === id), on]]));
}
const OTHER_PAGE = PAGE2.replace("https://example.com", "https://example.org");

/** SvalRFPService::RandomizeAudioOutput's range, with float32 rounding. */
const MIN_GAIN = 0.999 - 1e-6;
const MAX_GAIN = 0.9999 + 1e-6;

/**
 * Renders a compressed oscillator offline, as audio fingerprinting scripts
 * do, and reads it every way a page can. Channel 1 carries a constant 1, and
 * a second context renders a constant 1 alone, the references a page would
 * divide the noise out with. Evaluated in the page's own global, so it must
 * stand alone.
 */
async function audioProbe() {
  const LENGTH = 4096;
  const fingerprint = context => {
    const oscillator = context.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = 10000;
    const compressor = context.createDynamicsCompressor();
    oscillator.connect(compressor);
    oscillator.start(0);
    return compressor;
  };

  const context = new OfflineAudioContext(2, LENGTH, 44100);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  const merger = context.createChannelMerger(2);
  const compressor = fingerprint(context);
  compressor.connect(analyser);
  analyser.connect(merger, 0, 0);
  const constant = context.createConstantSource();
  constant.connect(merger, 0, 1);
  constant.start(0);
  merger.connect(context.destination);

  const processor = context.createScriptProcessor(1024, 1, 1);
  const processed = new Promise(resolve => {
    processor.onaudioprocess = e =>
      resolve(Array.from(e.inputBuffer.getChannelData(0)));
  });
  fingerprint(context).connect(processor);
  processor.connect(context.destination);

  // The compressor's look-ahead delays the signal, so the processor keeps
  // its first 1024 input samples.
  const module = `registerProcessor("probe", class extends AudioWorkletProcessor {
    samples = [];
    process(inputs) {
      if (inputs[0].length) {
        this.samples.push(...inputs[0][0]);
      }
      if (this.samples.length < 1024) {
        return true;
      }
      this.port.postMessage(this.samples);
      return false;
    }
  });`;
  const url = URL.createObjectURL(
    new Blob([module], { type: "text/javascript" })
  );
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const worklet = new AudioWorkletNode(context, "probe");
  const workletRead = new Promise(resolve => {
    worklet.port.onmessage = e => resolve(e.data);
  });
  fingerprint(context).connect(worklet);
  worklet.connect(context.destination);

  const buffer = await context.startRendering();
  const samples = buffer.getChannelData(0);
  const copied = new Float32Array(buffer.length);
  buffer.copyFromChannel(copied, 0);
  const timeDomain = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(timeDomain);
  const frequency = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(frequency);

  const reference = new OfflineAudioContext(1, LENGTH, 44100);
  const ones = reference.createConstantSource();
  ones.connect(reference.destination);
  ones.start(0);
  const elsewhere = (await reference.startRendering()).getChannelData(0);
  const sameRender = buffer.getChannelData(1);

  return JSON.stringify({
    samples: Array.from(samples),
    copiedMatches: copied.every((v, i) => v === samples[i]),
    timeDomain: Array.from(timeDomain),
    frequency: Array.from(frequency),
    dividedBySameRender: Array.from(samples, (v, i) => v / sameRender[i]),
    dividedByElsewhere: Array.from(samples, (v, i) => v / elsewhere[i]),
    reduction: compressor.reduction,
    processed: await processed,
    worklet: await workletRead,
  });
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
    const read = await within(
      SpecialPowers.spawn(
        tab.linkedBrowser,
        [audioProbe.toString()],
        async src =>
          JSON.parse(await content.wrappedJSObject.eval(`(${src})()`))
      ),
      10_000,
      "the page's offline render"
    );
    Assert.ok(
      read.copiedMatches,
      "copyFromChannel reads what getChannelData does"
    );
    return read;
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

/**
 * The gain on each audible sample of `read` against `raw`, asserting each is
 * inaudible and that they are not one gain.
 *
 * @param {number[]} read
 * @param {number[]} raw
 * @param {string} what
 * @returns {number[]}
 */
function gainsOf(read, raw, what) {
  const gains = raw
    .map((r, i) => [r, read[i]])
    .filter(([r]) => Math.abs(r) > 0.01)
    .map(([r, v]) => v / r);
  Assert.greater(gains.length, 100, `${what}: the read is not silent`);
  Assert.ok(
    gains.every(g => g >= MIN_GAIN && g <= MAX_GAIN),
    `${what}: every gain is between 0.999 and 0.9999`
  );
  Assert.greater(
    new Set(gains).size,
    gains.length / 2,
    `${what}: the samples carry different gains`
  );
  return gains;
}

let raw;

add_setup(async function () {
  setSwitch("audio-noise", false);
  try {
    raw = await readAt(PAGE2);
  } finally {
    setSwitch("audio-noise", true);
  }
  registerCleanupFunction(() =>
    SvalSiteProtections.setProtections("example.com", "on")
  );
});

add_task(async function a_site_reads_the_same_noise_twice() {
  const first = await readAt(PAGE2);
  const second = await readAt(PAGE2);
  Assert.notDeepEqual(first.samples, raw.samples, "the render is noised");
  Assert.deepEqual(second, first, "the site reads the same output again");
});

add_task(async function the_noise_is_inaudible() {
  const read = await readAt(PAGE2);
  gainsOf(read.samples, raw.samples, "rendered buffer");
  const peak = Math.max(...raw.samples.map(Math.abs));
  const deviation = Math.max(
    ...raw.samples.map((r, i) => Math.abs(read.samples[i] - r))
  );
  Assert.lessOrEqual(
    deviation,
    0.001 * peak,
    "no sample moves by more than a thousandth of the peak (under 0.01 dB)"
  );

  gainsOf(read.timeDomain, raw.timeDomain, "analyser time domain");
  const loudest = Math.max(...raw.frequency);
  const bins = raw.frequency
    .map((r, i) => [r, read.frequency[i]])
    .filter(([r]) => r > loudest - 20);
  Assert.greater(bins.length, 2, "the spectrum has the oscillator's partials");
  Assert.ok(
    bins.every(([r, v]) => Math.abs(v - r) < 0.01),
    "the oscillator's partials move by under 0.01 dB"
  );
  Assert.notDeepEqual(read.frequency, raw.frequency, "the spectrum is noised");
});

add_task(async function script_and_worklet_reads_are_noised() {
  const read = await readAt(PAGE2);
  gainsOf(read.processed, raw.processed, "ScriptProcessorNode input");
  gainsOf(read.worklet, raw.worklet, "AudioWorkletProcessor input");
  Assert.notEqual(raw.reduction, 0, "the compressor reduces the signal");
  const gain = read.reduction / raw.reduction;
  Assert.ok(
    gain >= MIN_GAIN && gain <= MAX_GAIN && gain !== 1,
    "the compressor's reduction carries an inaudible gain"
  );
});

add_task(async function a_reference_signal_does_not_divide_it_out() {
  const read = await readAt(PAGE2);
  for (const [name, divided] of [
    ["a constant on another channel", read.dividedBySameRender],
    ["a constant rendered in another context", read.dividedByElsewhere],
  ]) {
    const off = raw.samples.filter((r, i) => divided[i] !== r);
    Assert.greater(
      off.length,
      raw.samples.length / 2,
      `dividing by ${name} does not recover the raw render`
    );
  }
});

add_task(async function two_sites_read_different_noise() {
  const here = await readAt(PAGE2);
  const there = await readAt(OTHER_PAGE);
  Assert.notDeepEqual(
    gainsOf(here.samples, raw.samples, "one site"),
    gainsOf(there.samples, raw.samples, "another site"),
    "each site has its own noise"
  );
});

add_task(async function fingerprinting_protection_off_reads_raw_output() {
  SvalSiteProtections.setProtections("example.com", "fingerprinting");
  try {
    const read = await readAt(PAGE2);
    for (const key of [
      "samples",
      "timeDomain",
      "processed",
      "worklet",
      "reduction",
    ]) {
      Assert.deepEqual(read[key], raw[key], `the site reads raw ${key}`);
    }
    Assert.notDeepEqual(
      (await readAt(OTHER_PAGE)).samples,
      raw.samples,
      "another site is still noised"
    );
  } finally {
    SvalSiteProtections.setProtections("example.com", "on");
  }
});

add_task(async function a_private_window_has_its_own_key() {
  const normal = gainsOf((await readAt(PAGE2)).samples, raw.samples, "normal");
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a new window opening"
  );
  try {
    const first = await readAt(PAGE2, win);
    const second = await readAt(PAGE2, win);
    Assert.deepEqual(
      second.samples,
      first.samples,
      "stable within the session"
    );
    Assert.notDeepEqual(
      gainsOf(first.samples, raw.samples, "private"),
      normal,
      "the private session has its own noise"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});
