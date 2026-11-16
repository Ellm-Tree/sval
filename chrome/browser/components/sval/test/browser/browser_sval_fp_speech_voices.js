/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * speechSynthesis.getVoices lists only the OS's default voice and its own
 * voices for the UI language (RFPTarget::SpeechVoicesDefault), and a site
 * can be given the full list. Gecko's fake speech service adds voices in
 * several languages (dom/media/webspeech/synth/test), so the list has voices
 * to hide on every machine. It registers when the voice registry
 * starts, which nothing in Sval's suites does before this file.
 */

/** Evaluated in the page's own global, so it must stand alone. */
async function voicesProbe() {
  let voices = speechSynthesis.getVoices();
  // The voices arrive from the parent once the registry has started, and
  // the fake service's English voices always pass the filter.
  while (!voices.length) {
    await new Promise(resolve =>
      speechSynthesis.addEventListener("voiceschanged", resolve, {
        once: true,
      })
    );
    voices = speechSynthesis.getVoices();
  }
  return JSON.stringify(
    voices.map(v => ({ uri: v.voiceURI, lang: v.lang, isDefault: v.default }))
  );
}

async function readVoices(browser) {
  return within(
    SpecialPowers.spawn(browser, [voicesProbe.toString()], async src => {
      return JSON.parse(await content.wrappedJSObject.eval(`(${src})()`));
    }),
    10_000,
    "the page's voices"
  );
}

const UI_LANGUAGE = Services.locale.appLocaleAsBCP47.split("-")[0];

function checkVoices(voices, where) {
  for (const v of voices) {
    Assert.ok(
      v.isDefault || v.lang.split(/[-_]/)[0] == UI_LANGUAGE,
      `${where}: ${v.uri} is the default voice or in the UI language`
    );
    Assert.ok(
      !/com\.apple\.voice\.(enhanced|premium)\./.test(v.uri),
      `${where}: ${v.uri} is not a downloaded voice`
    );
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["media.webspeech.synth.test", true]],
  });
});

add_task(async function a_normal_window_lists_the_default_voices() {
  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    checkVoices(await readVoices(browser), "normal window");
  });
});

add_task(async function a_private_window_lists_the_same() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a new window opening"
  );
  try {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE2),
      10_000,
      "a new tab's load"
    );
    checkVoices(await readVoices(tab.linkedBrowser), "private window");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});

add_task(async function a_site_can_be_given_every_voice() {
  const limited = await BrowserTestUtils.withNewTab(PAGE2, readVoices);
  await withException("voices", async () => {
    const all = await BrowserTestUtils.withNewTab(PAGE2, readVoices);
    Assert.greaterOrEqual(
      all.length,
      limited.length,
      "the lifted site lists every voice"
    );
    const uris = all.map(v => v.uri);
    Assert.ok(
      uris.includes("urn:moz-tts:fake:celine"),
      "the full list holds a voice in another language"
    );
    Assert.ok(
      limited.every(v => uris.includes(v.uri)),
      "the full list holds the default voices"
    );
  });
});
