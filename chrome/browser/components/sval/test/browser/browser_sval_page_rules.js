/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */

// The page rules in Sval's lists hide elements, procedural ones included,
// follow the page's class names batch after batch until a page that keeps
// changing has brought nothing new for long enough, and run scriptlets before
// the page's own scripts; no selector can open a comment and no :style() can
// fetch; the PDF viewer, the site exception, the page-rules switch and a
// level without lists get none of the lists' rules; private windows get the
// same (page rules spec §5). My filters' own rules apply where the site
// exception or a level without lists takes the lists' away. A frame with no origin of its own (about:blank, srcdoc, blob:,
// data:, sandboxed) gets the rules of the origin that made it, as does a
// popup the page writes or opens at a blob: address, and none when that site
// has protections off. A frame the page adds runs the page's scriptlets
// before the page can read its globals, and only once.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { SvalPageRules, PAGE_RULES_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPageRules.sys.mjs"
);
const { ContentBlockingAllowList } = ChromeUtils.importESModule(
  "resource://gre/modules/ContentBlockingAllowList.sys.mjs"
);

const RULES_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_page_rules.html";
/** The test page at an address the list excepts from generic rules. */
const GENERICHIDE_PAGE = RULES_PAGE + "?generichide";

const TEST_LIST = [
  "! Title: Test page rules",
  "example.net##.sval-test-specific",
  "example.net##.sval-test-label:has-text(Sponsored):upward(1)",
  "example.net##.sval-test-styled:style(color: rgb(1, 2, 3))",
  'example.net##.sval-test-beacon:style(background-image: image-set("https://example.net/browser/browser/components/sval/test/browser/sval_page_rules_beacon.sjs?hit" 1x))',
  "##.sval-test-generic",
  "##.sval-test-generic-late",
  "@@||example.net/browser/browser/components/sval/test/browser/sval_page_rules.html?generichide$generichide",
  "example.net##+js(sval-test-scriptlet)",
  "",
].join("\n");

const TEST_RESOURCES = JSON.stringify([
  {
    name: "sval-test-scriptlet.js",
    aliases: ["sval-test-scriptlet"],
    kind: { mime: "application/javascript" },
    content: btoa(
      "window.svalScriptletRuns = (window.svalScriptletRuns ?? 0) + 1;" +
        "window.svalScriptletRan = true;"
    ),
  },
]);

function displayOf(browser, id) {
  return SpecialPowers.spawn(browser, [id], target => {
    const el = content.document.getElementById(target);
    return content.getComputedStyle(el).display;
  });
}

async function pageRulesApply(browser) {
  is(await displayOf(browser, "specific"), "none", "the element is hidden");
  is(await displayOf(browser, "plain"), "block", "an unlisted one is not");
  await SpecialPowers.spawn(browser, [], async () => {
    const { document } = content;
    await ContentTaskUtils.waitForCondition(
      () =>
        content.getComputedStyle(document.getElementById("sponsored"))
          .display == "none",
      "a procedural rule hides its target"
    );
    is(
      content.getComputedStyle(document.getElementById("organic")).display,
      "block",
      "and leaves alone an element its text test refuses"
    );
  });
  ok(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.wrappedJSObject.scriptletBeforePage
    ),
    "the scriptlet ran before the page's first script"
  );
}

/** A frame's content: a listed element, and one carrying a generic class. */
const FRAMED =
  '<div id="framed" class="sval-test-specific">Framed</div>' +
  '<div id="generic" class="sval-test-generic">Generic</div>';

/**
 * Has the page in `browser` fill frames of its own (`addFrames` in
 * sval_page_rules.html), from its own script, as an ad slot is filled.
 *
 * @param {Browser} browser
 * @returns {Promise<string[]>} the frames' ids.
 */
function addFrames(browser) {
  return SpecialPowers.spawn(browser, [FRAMED], async framed => {
    const ids = await content.wrappedJSObject.addFrames(framed);
    return [...Cu.waiveXrays(ids)];
  });
}

/**
 * The display of each element in each frame `addFrames` made, once the
 * frame's parser has finished.
 *
 * @param {Browser} browser
 * @param {string[]} ids
 * @param {boolean} hidden Whether to wait for the elements to be hidden.
 * @returns {Promise<object>} `{ frame id: [framed, generic] }`.
 */
async function framedDisplays(browser, ids, hidden) {
  const displays = {};
  for (const [i, bc] of browser.browsingContext.children.entries()) {
    displays[ids[i]] = await SpecialPowers.spawn(
      bc,
      [hidden],
      async waitHidden => {
        const doc = content.document;
        const display = id =>
          content.getComputedStyle(doc.getElementById(id)).display;
        if (waitHidden) {
          await ContentTaskUtils.waitForCondition(
            () =>
              doc.getElementById("generic") &&
              display("framed") == "none" &&
              display("generic") == "none",
            "the frame's page rules apply"
          ).catch(() => {});
        }
        return [display("framed"), display("generic")];
      }
    );
  }
  return displays;
}

async function framesTakeTheirMakersRules(browser) {
  const ids = await within(addFrames(browser), 10_000, "the frames load");
  const displays = await framedDisplays(browser, ids, true);
  for (const id of ids) {
    Assert.deepEqual(
      displays[id],
      ["none", "none"],
      `the ${id} frame takes the page's rules`
    );
  }
}

/**
 * Has the page in `browser` open a popup through `opener`, `writePopup` or
 * `openBlobPopup` in sval_page_rules.html, and closes it again.
 *
 * @param {Browser} browser
 * @param {string} opener
 * @param {boolean} hidden Whether to wait for the listed elements to be hidden.
 * @returns {Promise<{origin: string, displays: string[], ruled: boolean}>}
 *   the popup's origin, the display of the listed element in it and in each
 *   frame it holds, and whether the parent gives its document rules.
 */
async function popupDisplays(browser, opener, hidden) {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.disable_open_during_load", false]],
  });
  try {
    return await openPopup(browser, opener, hidden);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

/**
 * `popupDisplays` once popups may open. `ruled` is the parent actor's own
 * answer for the popup's document, which shows the decision even where the
 * page's rules would land after the display is read.
 *
 * @param {Browser} browser
 * @param {string} opener
 * @param {boolean} hidden
 * @returns {Promise<{origin: string, displays: string[], ruled: boolean}>}
 */
async function openPopup(browser, opener, hidden) {
  const opened = BrowserTestUtils.waitForNewTab(
    browser.documentGlobal.gBrowser,
    opener == "writePopup" ? "about:blank" : url => url.startsWith("blob:")
  );
  await SpecialPowers.spawn(browser, [opener, FRAMED], (name, framed) =>
    content.wrappedJSObject[name](framed)
  );
  const popup = await within(opened, 10_000, "the popup opening");
  try {
    const shown = await SpecialPowers.spawn(
      popup.linkedBrowser,
      [hidden],
      async waitHidden => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(() => {
          const inner = doc.getElementById("inner");
          return (
            doc.readyState == "complete" &&
            doc.getElementById("framed") &&
            (!inner || inner.contentDocument?.readyState == "complete")
          );
        }, "the popup loaded");
        const inner = doc.getElementById("inner")?.contentDocument;
        const docs = inner ? [doc, inner] : [doc];
        const display = d =>
          d.defaultView.getComputedStyle(d.getElementById("framed")).display;
        if (waitHidden) {
          await ContentTaskUtils.waitForCondition(
            () => docs.every(d => display(d) == "none"),
            "the popup's page rules apply"
          ).catch(() => {});
        }
        return {
          origin: doc.nodePrincipal.originNoSuffix,
          displays: docs.map(display),
        };
      }
    );
    const actor =
      popup.linkedBrowser.browsingContext.currentWindowGlobal.getActor(
        "SvalPageRules"
      );
    const ruled = !!actor.receiveMessage({ name: "SvalPageRules:Document" });
    return { ...shown, ruled };
  } finally {
    BrowserTestUtils.removeTab(popup);
  }
}

/**
 * A popup the page writes, and one it opens at a blob: address, run as the
 * page's origin and take its rules.
 *
 * @param {Browser} browser
 */
async function popupsTakeTheirOpenersRules(browser) {
  const written = await popupDisplays(browser, "writePopup", true);
  Assert.deepEqual(
    written,
    { origin: "https://example.net", displays: ["none", "none"], ruled: true },
    "the written popup and its frame take the page's rules"
  );
  const blob = await popupDisplays(browser, "openBlobPopup", true);
  Assert.deepEqual(
    blob,
    { origin: "https://example.net", displays: ["none"], ruled: true },
    "the blob: page takes the page's rules"
  );
}

/**
 * With the page's site on the allow list, neither popup takes rules.
 *
 * @param {Browser} browser
 */
async function popupsTakeTheSiteException(browser) {
  const written = await popupDisplays(browser, "writePopup", false);
  Assert.deepEqual(
    [written.displays, written.ruled],
    [["block", "block"], false],
    "the written popup gets no rules"
  );
  const blob = await popupDisplays(browser, "openBlobPopup", false);
  Assert.deepEqual(
    [blob.displays, blob.ruled],
    [["block"], false],
    "the blob: page gets no rules"
  );
}

add_setup(async function () {
  // The level, and the prefs Sval and Firefox derive from it, as this file
  // found them.
  keepPrefs(
    "browser.sval.adblock.",
    "privacy.trackingprotection.",
    "privacy.query_stripping.",
    "browser.contentblocking.category"
  );
  await SpecialPowers.pushPrefEnv({
    set: [...CONTENT_BLOCKING_TEST_PREFS],
  });
  await serveLists({ "sval-easylist": TEST_LIST });
  SvalPageRules.setScriptletResources(TEST_RESOURCES);
  registerCleanupFunction(async () => {
    SvalPageRules.setScriptletResources("[]");
    SvalBlocking.setLevel("off");
    await IOUtils.remove(SvalBlockingLists.dir, {
      recursive: true,
      ignoreAbsent: true,
    });
  });

  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  await SvalBlockingLists.update("sval-easylist");
  await listsInForce();
});

add_task(async function page_rules_apply() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, pageRulesApply);
});

add_task(async function a_selector_cannot_open_a_comment() {
  // The parser accepts an unclosed comment at the end of a selector, which in
  // a sheet would swallow every rule after it.
  const selector = ".sval-none /*";
  document.querySelector(selector);
  const { hidingSheet } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPageRulesChild.sys.mjs"
  );
  is(
    hidingSheet(document, [selector, ".sval-kept"]),
    ".sval-kept{display:none !important;}",
    "the selector is left out and the rule after it kept"
  );
});

add_task(function a_regex_matches_every_element_alike() {
  const { textMatcher } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPageRulesChild.sys.mjs"
  );
  for (const flags of ["g", "y", "gi"]) {
    const test = textMatcher(`/ad/${flags}`);
    Assert.deepEqual(
      ["ad", "ad", "ad"].map(test),
      [true, true, true],
      `/ad/${flags} matches each element, whatever the one before`
    );
  }
  Assert.ok(textMatcher("/AD/i")("ad"), "the other flags are kept");
  const empty = textMatcher("//");
  Assert.ok(!empty("an ad"), "an empty pattern matches no element");
  Assert.ok(empty("a // b"), "it is matched as text");
});

add_task(async function a_style_cannot_fetch() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], async () => {
      const styled = content.document.getElementById("styled");
      await ContentTaskUtils.waitForCondition(
        () => content.getComputedStyle(styled).color == "rgb(1, 2, 3)",
        "a plain :style() applies"
      );
      const beacon = content.document.getElementById("beacon");
      is(
        content.getComputedStyle(beacon).backgroundImage,
        "none",
        "a :style() that loads an image does not"
      );
    });
    const count = await (
      await fetch(
        "https://example.net/browser/browser/components/sval/test/browser/sval_page_rules_beacon.sjs?count"
      )
    ).text();
    is(count, "0", "nothing requested the style's URL");
  });
});

add_task(async function the_pdf_viewer_gets_no_page_rules() {
  // The viewer has the PDF's web address and a resource:// principal.
  const pdf =
    "https://example.net/browser/browser/components/sval/test/browser/sval_agent_doc.pdf";
  await BrowserTestUtils.withNewTab(pdf, async browser => {
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.readyState == "complete",
        "the viewer loaded"
      );
      ok(
        content.document.nodePrincipal.schemeIs("resource"),
        "the PDF viewer opened"
      );
      ok(!content.wrappedJSObject.svalScriptletRan, "no scriptlet ran in it");
    });
  });
});

add_task(async function a_generic_rule_follows_a_class_the_page_adds() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], async () => {
      const el = content.document.createElement("div");
      el.id = "late";
      el.textContent = "Late";
      content.document.body.append(el);
      is(content.getComputedStyle(el).display, "block", "shown at first");
      el.className = "sval-test-generic";
      await ContentTaskUtils.waitForCondition(
        () => content.getComputedStyle(el).display == "none",
        "hidden once it carries the listed class"
      );
      // A class arriving in a later batch is hidden too, and the earlier
      // batch's rule still holds.
      const later = content.document.createElement("div");
      later.textContent = "Later";
      content.document.body.append(later);
      later.className = "sval-test-generic-late";
      await ContentTaskUtils.waitForCondition(
        () => content.getComputedStyle(later).display == "none",
        "a later batch's class is hidden"
      );
      is(
        content.getComputedStyle(el).display,
        "none",
        "the first stays hidden"
      );
    });
  });
});

add_task(async function a_page_that_keeps_changing_stops_being_surveyed() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    await within(
      SpecialPowers.spawn(browser, [], async () => {
        const { surveyClock, SURVEY_ENDED_TOPIC, SURVEY_GRACE_MS } =
          ChromeUtils.importESModule(
            "moz-src:///browser/components/sval/SvalPageRulesChild.sys.mjs"
          );
        const { document } = content;
        await ContentTaskUtils.waitForCondition(
          () =>
            content.getComputedStyle(document.getElementById("sponsored"))
              .display == "none",
          "the page's rules are in"
        );
        let ended = false;
        const observer = () => (ended = true);
        Services.obs.addObserver(observer, SURVEY_ENDED_TOPIC);
        // The grace period passes without the page waiting it out.
        const now = surveyClock.now;
        surveyClock.now = () => now() + SURVEY_GRACE_MS;
        try {
          // A dashboard's redraw: the same element changes over and over,
          // and no change brings a name the survey has not seen.
          const counter = document.getElementById("plain");
          for (let i = 0; i < 1000 && !ended; i++) {
            counter.textContent = `Plain ${i}`;
            await Promise.resolve();
          }
        } finally {
          surveyClock.now = now;
          Services.obs.removeObserver(observer, SURVEY_ENDED_TOPIC);
        }
        ok(ended, "the survey ended");

        // Procedural rules still follow the page; generic ones do not.
        const late = document.createElement("div");
        late.className = "sval-test-generic-late";
        const sponsored = document.createElement("div");
        sponsored.innerHTML = '<span class="sval-test-label">Sponsored</span>';
        document.body.append(late, sponsored);
        await ContentTaskUtils.waitForCondition(
          () => content.getComputedStyle(sponsored).display == "none",
          "a procedural target added later is hidden"
        );
        is(
          content.getComputedStyle(late).display,
          "block",
          "a generic class added after the survey ended is not"
        );
      }),
      20_000,
      "the survey's end"
    );
  });
});

add_task(async function a_generichide_exception_spares_only_its_address() {
  // adblock-rust matches $generichide against the whole address, and each
  // address gets its own answer: the excepted page still hides its specific
  // elements but shows its generic ones, and the same page at another address
  // hides both.
  const addGeneric = browser =>
    SpecialPowers.spawn(browser, [], () => {
      const el = content.document.createElement("div");
      el.id = "generic";
      el.className = "sval-test-generic";
      el.textContent = "Generic";
      content.document.body.append(el);
    });
  await BrowserTestUtils.withNewTab(GENERICHIDE_PAGE, async browser => {
    is(await displayOf(browser, "specific"), "none", "specific rules apply");
    await addGeneric(browser);
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("SvalPageRules");
    ok(
      actor.receiveMessage({ name: "SvalPageRules:Document" }),
      "the excepted page has rules"
    );
    Assert.deepEqual(
      actor.receiveMessage({
        name: "SvalPageRules:Generic",
        data: { classes: ["sval-test-generic"], ids: [] },
      }),
      [],
      "but no generic ones"
    );
    is(await displayOf(browser, "generic"), "block", "its generic one shows");
  });
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    await addGeneric(browser);
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(
        () =>
          content.getComputedStyle(content.document.getElementById("generic"))
            .display == "none",
        "another address hides the generic element"
      )
    );
  });
});

add_task(async function the_site_exception_turns_page_rules_off() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    ContentBlockingAllowList.add(browser);
    try {
      await within(
        BrowserTestUtils.reloadTab(gBrowser.selectedTab),
        15_000,
        "the page's reload with protections off"
      );
      is(await displayOf(browser, "specific"), "block", "nothing is hidden");
      ok(
        !(await SpecialPowers.spawn(
          browser,
          [],
          () => content.wrappedJSObject.svalScriptletRan
        )),
        "no scriptlet runs"
      );
    } finally {
      ContentBlockingAllowList.remove(browser);
    }
  });
});

add_task(async function frames_without_an_origin_take_their_makers_rules() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, framesTakeTheirMakersRules);
});

add_task(async function the_site_exception_reaches_into_frames() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    ContentBlockingAllowList.add(browser);
    try {
      await within(
        BrowserTestUtils.reloadTab(gBrowser.selectedTab),
        15_000,
        "the page's reload with protections off"
      );
      // The srcdoc and blob: frames hold their load until their rules are
      // decided, and the others asked first.
      const ids = await within(addFrames(browser), 10_000, "the frames load");
      const displays = await framedDisplays(browser, ids, false);
      for (const id of ids) {
        Assert.deepEqual(
          displays[id],
          ["block", "block"],
          `nothing is hidden in the ${id} frame`
        );
      }

      await popupsTakeTheSiteException(browser);
    } finally {
      ContentBlockingAllowList.remove(browser);
    }
  });
});

add_task(async function a_blank_window_has_scriptlets_the_moment_it_exists() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    await SpecialPowers.pushPrefEnv({
      set: [["dom.disable_open_during_load", false]],
    });
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:blank");
    try {
      const ran = await SpecialPowers.spawn(browser, [FRAMED], framed =>
        Cu.cloneInto(content.wrappedJSObject.blankWindowsAtBirth(framed), {})
      );
      Assert.deepEqual(
        ran,
        { frame: true, popup: true },
        "a frame and a popup the page makes have its scriptlets before the page can read them"
      );
      const [frame] = browser.browsingContext.children;
      const runs = await SpecialPowers.spawn(frame, [], async () => {
        const el = content.document.getElementById("framed");
        await ContentTaskUtils.waitForCondition(
          () => content.getComputedStyle(el).display == "none",
          "the frame's own rules arrive"
        );
        return content.wrappedJSObject.svalScriptletRuns;
      });
      is(runs, 1, "and the frame runs them once");
    } finally {
      BrowserTestUtils.removeTab(await within(opened, 10_000, "the popup"));
      await SpecialPowers.popPrefEnv();
    }
  });
});

/**
 * A popup's own rules can arrive after `window.open` returns, as they do here
 * where the parent holds them back, so the popup's initial about:blank runs
 * its opener's scriptlets before the opener can read its globals.
 */
add_task(async function a_popup_has_its_openers_scriptlets_before_its_own() {
  const { SvalPageRulesParent } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPageRulesParent.sys.mjs"
  );
  const receive = SvalPageRulesParent.prototype.receiveMessage;
  const held = Promise.withResolvers();
  SvalPageRulesParent.prototype.receiveMessage = function (message) {
    const answer = receive.call(this, message);
    if (
      message.name == "SvalPageRules:Document" &&
      this.browsingContext.opener
    ) {
      return held.promise.then(() => answer);
    }
    return answer;
  };
  await SpecialPowers.pushPrefEnv({
    set: [["dom.disable_open_during_load", false]],
  });
  try {
    await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
      const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:blank");
      const ran = await SpecialPowers.spawn(browser, [], () =>
        content.wrappedJSObject.popupAtBirth()
      );
      ok(ran, "the popup ran its opener's scriptlets before the page read it");
      const popup = await within(opened, 10_000, "the popup");
      if (popup.isConnected) {
        BrowserTestUtils.removeTab(popup);
      }
    });
  } finally {
    SvalPageRulesParent.prototype.receiveMessage = receive;
    held.resolve();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function popups_take_their_openers_rules() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, popupsTakeTheirOpenersRules);
});

add_task(async function the_switch_turns_page_rules_off() {
  await SpecialPowers.pushPrefEnv({ set: [[PAGE_RULES_PREF, false]] });
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    is(await displayOf(browser, "specific"), "block", "nothing is hidden");
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function private_windows_behave_the_same() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a new private window opening"
  );
  try {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, RULES_PAGE),
      15_000,
      "the new tab opening and loading"
    );
    await pageRulesApply(tab.linkedBrowser);
    await framesTakeTheirMakersRules(tab.linkedBrowser);
    await popupsTakeTheirOpenersRules(tab.linkedBrowser);
    ContentBlockingAllowList.add(tab.linkedBrowser);
    try {
      await popupsTakeTheSiteException(tab.linkedBrowser);
    } finally {
      ContentBlockingAllowList.remove(tab.linkedBrowser);
    }
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

add_task(async function a_level_without_lists_gives_pages_no_page_rules() {
  ok(
    SvalPageRules.forDocument(RULES_PAGE, false, false),
    "a level with a list gives the page its rules"
  );
  SvalBlocking.setLevel("off");
  // Off asks for My filters' rules alone, which are empty here.
  is(
    SvalPageRules.forDocument(RULES_PAGE, false, true),
    null,
    "Off gives it none, so the page runs no generic hiding"
  );
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    is(await displayOf(browser, "specific"), "block", "nothing is hidden");
  });
});

/**
 * Which of the list's element and My filters' element a fresh load hides.
 *
 * @param {Element} browser
 * @returns {Promise<string[]>}
 */
async function listAndOwnDisplays(browser) {
  return [
    await displayOf(browser, "specific"),
    await displayOf(browser, "plain"),
  ];
}

add_task(async function my_filters_apply_where_the_lists_do_not() {
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  SvalBlocking.setMyFilters("example.net###plain");
  try {
    await untilEachLoad(
      RULES_PAGE,
      listAndOwnDisplays,
      ["none", "none"],
      "the list and My filters both hiding"
    );
    await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
      ContentBlockingAllowList.add(browser);
      try {
        await untilEachLoad(
          RULES_PAGE,
          listAndOwnDisplays,
          ["block", "none"],
          "My filters hiding with the site's protections off"
        );
      } finally {
        ContentBlockingAllowList.remove(browser);
      }
    });
    SvalBlocking.setLevel("off");
    await untilEachLoad(
      RULES_PAGE,
      listAndOwnDisplays,
      ["block", "none"],
      "My filters hiding with ad blocking Off"
    );
  } finally {
    SvalBlocking.setMyFilters("");
  }
});
