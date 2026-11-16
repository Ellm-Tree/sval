/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Sites see only the primary language (RFPTarget::LanguagesPrimaryOnly):
 * navigator.languages, the JS default locale and Accept-Language, the same in
 * the page, an iframe and a worker, and lifted per site.
 */

const LANGUAGES = "de-CH, fr, en-US";
const ECHO = ROOT + "sval_accept_language.sjs";

/**
 * Evaluated in the page's own global, so it must stand alone.
 *
 * @param {string} echo The URL that answers with Accept-Language.
 * @returns {Promise<string>} What the page read, as JSON.
 */
async function languageProbe(echo) {
  const locale = () => Intl.DateTimeFormat().resolvedOptions().locale;
  const read = win => ({
    languages: win.navigator.languages,
    language: win.navigator.language,
    locale: win.eval(`(${locale})()`),
  });
  const frame = document.createElement("iframe");
  frame.src = location.href;
  await new Promise(resolve => {
    frame.onload = resolve;
    document.body.append(frame);
  });
  const framed = read(frame.contentWindow);
  frame.remove();

  const worker = new Worker(
    URL.createObjectURL(
      new Blob([
        `postMessage({
          languages: navigator.languages,
          language: navigator.language,
          locale: (${locale})(),
        })`,
      ])
    )
  );
  const inWorker = await new Promise(resolve => {
    worker.onmessage = e => resolve(e.data);
  });
  worker.terminate();

  const header = await (await fetch(echo)).text();
  return JSON.stringify({ page: read(window), framed, inWorker, header });
}

async function readLanguages(browser) {
  return within(
    SpecialPowers.spawn(
      browser,
      [languageProbe.toString(), ECHO],
      async (src, echo) => {
        const json = await content.wrappedJSObject.eval(`(${src})`)(echo);
        return JSON.parse(json);
      }
    ),
    10_000,
    "the page's languages"
  );
}

function checkPrimary(fp, where) {
  const want = {
    languages: ["de-CH", "de"],
    language: "de-CH",
    locale: "de-CH",
  };
  Assert.deepEqual(fp.page, want, `${where}: the page sees one language`);
  Assert.deepEqual(fp.framed, want, `${where}: an iframe sees the same`);
  Assert.deepEqual(fp.inWorker, want, `${where}: a worker sees the same`);
  Assert.equal(fp.header, "de-CH,de;q=0.9", `${where}: Accept-Language agrees`);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["intl.accept_languages", LANGUAGES]],
  });
});

add_task(async function a_normal_window_sees_the_primary_language() {
  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    checkPrimary(await readLanguages(browser), "normal window");
  });
});

add_task(async function a_private_window_sees_the_same() {
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
    checkPrimary(await readLanguages(tab.linkedBrowser), "private window");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});

add_task(async function a_site_can_be_lifted() {
  await withException("languages", async () => {
    await BrowserTestUtils.withNewTab(PAGE2, async browser => {
      const fp = await readLanguages(browser);
      const all = ["de-CH", "fr", "en-US"];
      Assert.deepEqual(fp.page.languages, all, "the page sees every language");
      Assert.deepEqual(fp.inWorker.languages, all, "so does a worker");
      Assert.equal(
        fp.header,
        "de-CH,fr;q=0.9,en-US;q=0.8",
        "Accept-Language carries every language"
      );
    });
  });
});

add_task(async function a_redirect_carries_the_final_sites_header() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "privacy.fingerprintingProtection.granularOverrides",
        JSON.stringify([
          {
            firstPartyDomain: "example.com",
            overrides: "-LanguagesPrimaryOnly",
          },
        ]),
      ],
    ],
  });
  try {
    // A protected site redirects to the lifted one.
    const start =
      ROOT.replace("https://example.com", "https://example.org") +
      "sval_agent_redirect.sjs?" +
      encodeURIComponent(ECHO);
    await BrowserTestUtils.withNewTab(start, async browser => {
      Assert.equal(
        browser.currentURI.spec,
        ECHO,
        "the redirect reached the lifted site"
      );
      const header = await SpecialPowers.spawn(
        browser,
        [],
        () => content.document.body.textContent
      );
      Assert.equal(
        header,
        "de-CH,fr;q=0.9,en-US;q=0.8",
        "the lifted site gets every language"
      );
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
