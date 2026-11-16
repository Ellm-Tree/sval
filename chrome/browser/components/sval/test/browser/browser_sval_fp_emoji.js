/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Strict's bundled emoji font (RFPTarget::EmojiFontBundled, fingerprinting
 * catalogue §1): a page renders emoji in Twemoji Mozilla, in a normal
 * and a private window; Restore gives it the default emoji font back; and
 * granularOverrides lifts it for one site.
 */

const { GROUPS, restore, restoreDefaults, setStrict, snapshot } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
  );

const BUNDLED = "Twemoji Mozilla";
const EMOJI = "\u{1F600}";

/**
 * The families that render `EMOJI` in `doc`, read from the fonts layout used.
 *
 * @param {Document} doc
 * @returns {string[]}
 */
function emojiFamiliesIn(doc) {
  const div = doc.createElement("div");
  div.textContent = EMOJI;
  (doc.body ?? doc.documentElement).append(div);
  const range = doc.createRange();
  range.selectNodeContents(div);
  const families = InspectorUtils.getUsedFontFaces(range).map(
    f => f.CSSFamilyName
  );
  div.remove();
  return families;
}

async function pageEmojiFamilies(win) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE2),
    10_000,
    "a new tab's load"
  );
  try {
    return await within(
      SpecialPowers.spawn(tab.linkedBrowser, [EMOJI], emoji => {
        const div = content.document.createElement("div");
        div.textContent = emoji;
        content.document.body.append(div);
        const range = content.document.createRange();
        range.selectNodeContents(div);
        const families = InspectorUtils.getUsedFontFaces(range).map(
          f => f.CSSFamilyName
        );
        div.remove();
        return families;
      }),
      10_000,
      "the page's emoji font"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

/** The emoji font the browser's own UI renders, which no target touches. */
const uiFamilies = () => emojiFamiliesIn(document);

async function withPrivateWindow(fn) {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a new window opening"
  );
  try {
    return await fn(win);
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
}

add_task(function the_setting_is_a_strict_font_item() {
  const fonts = GROUPS.find(g => g.id === "fonts");
  const item = fonts.items.find(i => i.id === "emoji");
  Assert.ok(item?.strict, "Bundled emoji font is a strict font item");
  Assert.deepEqual(item.on, ["+EmojiFontBundled"], "it writes its target");
});

/**
 * What a page renders the emoji in with Sval's defaults, checked to be the
 * same in a private window. macOS and Windows always have an emoji font of
 * their own. On Linux font.name-list.emoji names the bundled font after Noto
 * Color Emoji, so without that package the default already is the bundled
 * font and Strict cannot change what a page sees.
 *
 * @returns {Promise<string[]>}
 */
async function defaultPageFamilies() {
  const families = await pageEmojiFamilies(window);
  Assert.equal(families.length, 1, "a page renders the emoji in one font");
  await withPrivateWindow(async win => {
    Assert.deepEqual(
      await pageEmojiFamilies(win),
      families,
      "a private window renders the same emoji font by default"
    );
  });
  if (AppConstants.platform !== "linux") {
    Assert.notDeepEqual(
      families,
      [BUNDLED],
      "by default a page renders the system's emoji font"
    );
  } else if (families[0] === BUNDLED) {
    info(
      "This Linux system has no emoji font of its own, so its default already is the bundled one; Strict keeps it"
    );
  }
  return families;
}

add_task(async function strict_renders_the_bundled_emoji_font() {
  const ui = uiFamilies();
  const byDefault = await defaultPageFamilies();

  const saved = snapshot();
  try {
    setStrict(true);
    Assert.deepEqual(
      await pageEmojiFamilies(window),
      [BUNDLED],
      "under Strict a page renders the bundled emoji font"
    );
    await withPrivateWindow(async win => {
      Assert.deepEqual(
        await pageEmojiFamilies(win),
        [BUNDLED],
        "under Strict a private window renders the bundled emoji font"
      );
    });
    Assert.deepEqual(
      uiFamilies(),
      ui,
      "the browser's own UI keeps its emoji font"
    );

    restoreDefaults();
    Assert.deepEqual(
      await pageEmojiFamilies(window),
      byDefault,
      "Restore gives pages the default emoji font back"
    );
    await withPrivateWindow(async win => {
      Assert.deepEqual(
        await pageEmojiFamilies(win),
        byDefault,
        "and private windows too"
      );
    });
  } finally {
    restore(saved);
  }
});

add_task(async function a_site_can_be_lifted() {
  const byDefault = await defaultPageFamilies();
  const saved = snapshot();
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "privacy.fingerprintingProtection.granularOverrides",
        JSON.stringify([
          { firstPartyDomain: "example.com", overrides: "-EmojiFontBundled" },
        ]),
      ],
    ],
  });
  try {
    setStrict(true);
    Assert.deepEqual(
      await pageEmojiFamilies(window),
      byDefault,
      "the lifted site renders the default emoji font"
    );
  } finally {
    restore(saved);
    await SpecialPowers.popPrefEnv();
  }
});
