/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Every console message says where it came from: "Page · <site>" for the
 * page's own scripts, "Extension · <name>" for an extension's, content
 * scripts included, and "Sval" for the browser's own. The filter bar's Page,
 * Extensions and Sval toggles hide and show each, and its extension menu
 * narrows Extensions to one extension.
 */

const { require } = ChromeUtils.importESModule(
  "resource://devtools/shared/loader/Loader.sys.mjs"
);
const { gDevTools } = require("devtools/client/framework/devtools");
const {
  BrowserConsoleManager,
} = require("devtools/client/webconsole/browser-console-manager");
const {
  getElementText,
} = require("devtools/client/webconsole/utils/clipboard");

// Loading an extension records its internal address (`UUIDMap` in
// Extension.sys.mjs); opening a toolbox records that one was opened and which
// tool it showed; the filter bar keeps its toggles, and the Browser Console
// its mode, as prefs.
keepPrefs(
  "extensions.webextensions.uuids",
  "devtools.everOpened",
  "devtools.toolbox.selectedTool",
  "devtools.webconsole.filter.",
  "devtools.browserconsole.filter.",
  "devtools.browsertoolbox.scope"
);

const FIRST = "Origin Label Test";
const SECOND = "Second Origin Test";

/**
 * An extension that logs from its background page and a content script.
 *
 * @param {string} name
 */
function loadExtension(name) {
  return ExtensionTestUtils.loadExtension({
    manifest: {
      name,
      content_scripts: [
        { matches: ["https://example.com/*"], js: ["content.js"] },
      ],
    },
    background() {
      const { browser } = this;
      browser.test.onMessage.addListener(text => {
        if (text === "unchecked lastError") {
          // A callback that leaves `lastError` unread has system code report
          // it with this script's frame (`withLastError` in
          // ExtensionCommon.sys.mjs). No page listens, so the send fails.
          this.chrome.runtime.sendMessage("nobody listens", () => {
            browser.test.sendMessage("logged");
          });
          return;
        }
        console.log(text);
        browser.test.sendMessage("logged");
      });
    },
    files: {
      "content.js": `console.log("sval-origin: content script of ${name}");`,
    },
  });
}

/**
 * The console's message rows whose body includes `text`.
 *
 * @param {object} hud
 * @param {string} text
 */
function rowsWith(hud, text) {
  return [...hud.ui.outputNode.querySelectorAll(".message")].filter(row =>
    row.querySelector(".message-body")?.textContent.includes(text)
  );
}

function rowWith(hud, text) {
  return within(
    TestUtils.waitForCondition(() => rowsWith(hud, text)[0], `"${text}"`),
    10_000,
    `the console's row for "${text}"`
  );
}

function gone(hud, text) {
  return within(
    TestUtils.waitForCondition(
      () => !rowsWith(hud, text).length,
      `no "${text}"`
    ),
    10_000,
    `"${text}" leaving the console`
  );
}

/**
 * The origin a message's label shows: its kind, and the site or extension it
 * names, the text after the label's separator.
 *
 * @param {Element} row
 * @returns {?Array} `[kind, name]`, `name` null when the label names none.
 */
function originOf(row) {
  const badge = row.querySelector(".sval-console-origin");
  if (!badge) {
    return null;
  }
  const named = badge.childNodes.length > 1;
  return [badge.dataset.origin, named ? badge.lastChild.textContent : null];
}

function filterButton(hud, key) {
  return hud.ui.window.document.querySelector(
    `.webconsole-filterbar-secondary [data-category="${key}"]`
  );
}

function click(element) {
  element.click();
}

/**
 * Picks the extension named `name` from the filter bar's extension menu, or
 * with no name the menu's first item, every extension.
 *
 * @param {object} hud
 * @param {Document} toolboxDoc
 *        The document the menu opens in.
 * @param {?string} name
 */
async function pickExtension(hud, toolboxDoc, name) {
  const button = hud.ui.window.document.querySelector(
    '[aria-controls="sval-console-extension-menu"]'
  );
  const before = button.textContent;
  click(button);
  const item = await within(
    TestUtils.waitForCondition(() => {
      const items = [
        ...toolboxDoc.querySelectorAll(
          "#sval-console-extension-menu-list [role=menuitemradio]"
        ),
      ];
      return name ? items.find(node => node.textContent === name) : items[0];
    }),
    10_000,
    `the extension menu's item for ${name ?? "every extension"}`
  );
  click(item);
  await within(
    TestUtils.waitForCondition(() =>
      name ? button.textContent === name : button.textContent !== before
    ),
    10_000,
    `the extension menu showing ${name ?? "every extension"}`
  );
}

add_task(async function a_page_console_labels_and_filters_by_origin() {
  const first = loadExtension(FIRST);
  const second = loadExtension(SECOND);
  await within(first.startup(), 20_000, "the first extension's start");
  await within(second.startup(), 20_000, "the second extension's start");
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    10_000,
    "the page's tab"
  );
  const toolbox = await within(
    gDevTools.showToolboxForTab(tab, { toolId: "webconsole" }),
    20_000,
    "the page's toolbox"
  );
  try {
    const { hud } = toolbox.getPanel("webconsole");
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      const script = content.document.createElement("script");
      script.textContent = `console.log("sval-origin: the page")`;
      content.document.body.append(script);
    });

    const page = await rowWith(hud, "sval-origin: the page");
    const content = await rowWith(hud, `content script of ${FIRST}`);
    await rowWith(hud, `content script of ${SECOND}`);
    Assert.deepEqual(
      originOf(page),
      ["page", "example.com"],
      "the page's message names its site"
    );
    Assert.deepEqual(
      originOf(content),
      ["extension", FIRST],
      "a content script's message names its extension"
    );
    const location = content.querySelector(".message-location");
    ok(
      location
        .querySelector(".sval-console-origin-source")
        ?.textContent.startsWith(FIRST) &&
        location.textContent.includes("content.js"),
      "a content script's source link names its extension before the file"
    );
    ok(
      !page.querySelector(".message-location .sval-console-origin-source"),
      "the page's source link is the file alone"
    );
    // Copy Message copies what the console shows minus Sval's additions, as
    // Firefox's console would.
    const copied = getElementText(content);
    ok(
      copied.includes(`content script of ${FIRST}`) &&
        copied.includes("content.js"),
      `a copied message keeps its text and source: ${copied}`
    );
    const kind = content.querySelector(".sval-console-origin").firstChild;
    ok(
      !copied.includes(kind.textContent) &&
        !copied.includes(
          location.querySelector(".sval-console-origin-source").textContent
        ),
      `a copied message leaves out the label and the source's prefix: ${copied}`
    );

    // Extensions off hides both extensions' messages, not the page's.
    const extensions = filterButton(hud, "extensions");
    is(extensions.getAttribute("aria-pressed"), "true", "Extensions starts on");
    click(extensions);
    await gone(hud, `content script of ${FIRST}`);
    await gone(hud, `content script of ${SECOND}`);
    ok(rowsWith(hud, "sval-origin: the page").length, "the page's stays");
    click(extensions);
    await rowWith(hud, `content script of ${FIRST}`);

    // Page off hides the page's message, not the extensions'.
    const pageButton = filterButton(hud, "page");
    click(pageButton);
    await gone(hud, "sval-origin: the page");
    ok(
      rowsWith(hud, `content script of ${SECOND}`).length,
      "an extension's message stays"
    );
    click(pageButton);
    await rowWith(hud, "sval-origin: the page");

    // One extension shows only that extension's messages among extensions'.
    await pickExtension(hud, toolbox.doc, SECOND);
    await gone(hud, `content script of ${FIRST}`);
    ok(
      rowsWith(hud, `content script of ${SECOND}`).length,
      "the chosen extension's message stays"
    );
    ok(rowsWith(hud, "sval-origin: the page").length, "the page's stays");
    await pickExtension(hud, toolbox.doc, null);
    await rowWith(hud, `content script of ${FIRST}`);
  } finally {
    await toolbox.destroy();
    BrowserTestUtils.removeTab(tab);
    await first.unload();
    await second.unload();
  }
});

/**
 * A page names its own scripts: `//# sourceURL=` and a `data:` URL's text are
 * the page's to write. A page script that names itself after an extension's
 * or Sval's files, or after a host siteOf refuses, is still the page's.
 */
add_task(async function a_page_script_cannot_take_another_origin() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    10_000,
    "the page's tab"
  );
  const toolbox = await within(
    gDevTools.showToolboxForTab(tab, { toolId: "webconsole" }),
    20_000,
    "the page's toolbox"
  );
  try {
    const { hud } = toolbox.getPanel("webconsole");
    await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const doc = content.document;
      for (const name of [
        "moz-extension://x/y.js",
        "resource://gre/foo.js",
        "https://a..b/c.js",
      ]) {
        const script = doc.createElement("script");
        script.textContent = `console.log("sval-origin: named ${name}")\n//# sourceURL=${name}`;
        doc.body.append(script);
        content.eval(
          `console.log("sval-origin: evaluated as ${name}")\n//# sourceURL=${name}`
        );
      }
      const loaded = new Promise(resolve => {
        const script = doc.createElement("script");
        script.src = `data:text/javascript,console.log("sval-origin: data -> moz-extension://x/y.js")`;
        script.onload = resolve;
        doc.body.append(script);
      });
      await loaded;
    });
    for (const text of [
      "named moz-extension://x/y.js",
      "named resource://gre/foo.js",
      "evaluated as moz-extension://x/y.js",
      "evaluated as resource://gre/foo.js",
      "named https://a..b/c.js",
      "evaluated as https://a..b/c.js",
      "data -> moz-extension://x/y.js",
    ]) {
      const row = await rowWith(hud, `sval-origin: ${text}`);
      is(
        originOf(row)[0],
        "page",
        `a page script ${text} is labelled ${originOf(row)}`
      );
    }
  } finally {
    await toolbox.destroy();
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function the_browser_console_labels_and_filters_by_origin() {
  // An extension's background page runs in its own process, which the
  // Browser Console shows in its Multiprocess mode. Set before the console
  // opens, as Mozilla's `browser_console_webextension.js` does, the opening
  // waits for its targets: switched in an open console, the switch's
  // `watchTargets` request (`TargetCommand._updateBrowserToolboxScope`) is
  // not awaited and can be left pending when the console closes.
  await SpecialPowers.pushPrefEnv({
    set: [["devtools.browsertoolbox.scope", "everything"]],
  });
  const hud = await within(
    BrowserConsoleManager.toggleBrowserConsole(),
    20_000,
    "the Browser Console's opening"
  );
  const extension = loadExtension(FIRST);
  try {
    await within(extension.startup(), 20_000, "the extension's start");
    extension.sendMessage("sval-origin: the background page");
    await within(extension.awaitMessage("logged"), 10_000, "the log");
    console.log("sval-origin: Sval itself");

    const sval = await rowWith(hud, "sval-origin: Sval itself");
    const background = await rowWith(hud, "sval-origin: the background page");
    Assert.deepEqual(
      originOf(sval),
      ["sval", null],
      "the browser's own message says Sval"
    );
    Assert.deepEqual(
      originOf(background),
      ["extension", FIRST],
      "a background page's message names its extension"
    );

    // System code's report of the extension's error, made from a chrome
    // context, names the extension whose frame it carries.
    extension.sendMessage("unchecked lastError");
    await within(extension.awaitMessage("logged"), 10_000, "the send");
    const unchecked = await rowWith(hud, "Unchecked lastError value");
    Assert.deepEqual(
      originOf(unchecked),
      ["extension", FIRST],
      "an unchecked lastError names the extension"
    );

    // Sval off, from the keyboard, hides the browser's message, not the
    // extension's.
    const svalButton = filterButton(hud, "sval");
    svalButton.focus();
    EventUtils.synthesizeKey(" ", {}, hud.ui.window);
    await gone(hud, "sval-origin: Sval itself");
    is(svalButton.getAttribute("aria-pressed"), "false", "Sval is off");
    ok(
      rowsWith(hud, "sval-origin: the background page").length,
      "the extension's message stays"
    );
    EventUtils.synthesizeKey(" ", {}, hud.ui.window);
    await rowWith(hud, "sval-origin: Sval itself");
  } finally {
    await extension.unload();
    await within(
      BrowserConsoleManager.closeBrowserConsole(),
      10_000,
      "the Browser Console's closing"
    );
  }
});
