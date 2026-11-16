/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A host too long for the address bar's site name or a Quick Peek's bar loses its
 * start, so its end, the site it belongs to, stays in view: a host that
 * begins with another site's name reads as the site it is. A host that fits
 * shows whole.
 *
 * The long host is served by Mozilla's Node HTTPS test server with a
 * certificate the test CA signs for it, and `network.dns.localDomains`
 * sends it to that server.
 */

const { SvalQuickPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
);
const { NodeHTTPSServer } = ChromeUtils.importESModule(
  "resource://testing-common/NodeServer.sys.mjs"
);

/** The registrable domain the long host belongs to. */
const SITE = "sval-test.example";

/** A host of about 150 characters that starts with another site's name. */
const LONG_HOST = [
  "accounts.google.com.signin.v3.identifier",
  "flowname-glifwebsignin.servicelogin",
  "0123456789abcdef0123456789abcdef",
  "0123456789abcdef",
  SITE,
].join(".");

const SHORT = "https://example.com/browser/";

/** The long host's origin, with the server's port. */
let longOrigin;

add_setup(async function () {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await SpecialPowers.pushPrefEnv({
    set: [["network.dns.localDomains", LONG_HOST]],
  });
  const server = new NodeHTTPSServer();
  await server.start(0, [LONG_HOST]);
  registerCleanupFunction(() => server.stop());
  await server.registerPathHandler("/", (req, resp) => {
    resp.writeHead(200, { "Content-Type": "text/html" });
    resp.end(
      '<a id="long" href="/quick-peeked/a/path/long/enough/to/be/cut">long</a> ' +
        '<a id="short" href="https://example.com/browser/">short</a>'
    );
  });
  longOrigin = `https://${LONG_HOST}:${server.port()}`;
});

/**
 * The on-screen box of the text in `el` from `start` to its end.
 *
 * @param {Element} el
 * @param {number} start
 * @returns {DOMRect}
 */
function textBox(el, start) {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  const range = el.ownerDocument.createRange();
  range.setStart(node, start);
  range.setEnd(node, node.length);
  return range.getBoundingClientRect();
}

/**
 * Whether `inner` lies within every box of `clips`, to the pixel.
 *
 * @param {DOMRect} inner
 * @param {Element[]} clips The elements that clip it.
 * @returns {boolean}
 */
function insideAll(inner, clips) {
  return clips.every(clip => {
    const box = clip.getBoundingClientRect();
    return inner.left >= box.left - 1 && inner.right <= box.right + 1;
  });
}

/**
 * Asserts that `hostEl`'s registrable domain and all that follows it are on
 * screen inside `clips`, and that the host is wider than they are.
 *
 * @param {Element} hostEl
 * @param {Element[]} clips
 */
function assertEndInView(hostEl, clips) {
  const text = hostEl.textContent;
  Assert.ok(text.startsWith("accounts.google.com."), "the long host shows");
  const whole = textBox(hostEl, 0);
  const room = Math.min(...clips.map(c => c.getBoundingClientRect().width));
  info(`the host is ${whole.width}px wide in ${room}px`);
  Assert.greater(whole.width, room, "the host is too long for its room");
  Assert.ok(
    insideAll(textBox(hostEl, text.lastIndexOf(SITE)), clips),
    "the host's end, its registrable domain, is in view"
  );
}

/**
 * Asserts that `hostEl` shows its whole text, with no ellipsis.
 *
 * @param {Element} hostEl
 * @param {Element[]} clips
 */
function assertWhole(hostEl, clips) {
  Assert.lessOrEqual(
    hostEl.scrollWidth,
    hostEl.clientWidth,
    "the host fits, so no ellipsis is drawn"
  );
  Assert.ok(insideAll(textBox(hostEl, 0), clips), "all of it is in view");
}

add_task(async function the_address_bar_keeps_a_long_hosts_end_in_view() {
  const label = document.getElementById("sval-urlbar-domain");
  const host = label.querySelector(".sval-urlbar-host");
  const shown = () =>
    BrowserTestUtils.isVisible(label) && label.getBoundingClientRect().width;

  const tab = await openPage(`${longOrigin}/`);
  await TestUtils.waitForCondition(
    () => shown() && host.textContent === LONG_HOST,
    "the site name shows the long host"
  );
  assertEndInView(host, [host, label]);
  BrowserTestUtils.removeTab(tab);

  const short = await openPage(SHORT);
  await TestUtils.waitForCondition(
    () => shown() && host.textContent === "example.com",
    "the site name shows a short host"
  );
  assertWhole(host, [host, label]);
  BrowserTestUtils.removeTab(short);
});

/**
 * Alt-clicks link `selector` in `browser`'s page and waits for the Quick Peek to
 * show `url` loaded.
 *
 * @param {object} browser
 * @param {string} selector
 * @param {string} url
 * @returns {Promise<object>} the Quick Peek's tab.
 */
async function quickPeekAt(browser, selector, url) {
  await BrowserTestUtils.synthesizeMouseAtCenter(
    selector,
    { altKey: true },
    browser
  );
  await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(window),
    "a Quick Peek opens"
  );
  const quickPeek = SvalQuickPeek.tabOf(window);
  await TestUtils.waitForCondition(
    () =>
      quickPeek.linkedBrowser?.currentURI.spec === url &&
      !quickPeek.hasAttribute("busy"),
    "the Quick Peek's page loads"
  );
  return quickPeek;
}

/** @param {object} quickPeek A Quick Peek's tab. */
async function closeQuickPeek(quickPeek) {
  SvalQuickPeek.close(window);
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(window) && !quickPeek.linkedBrowser,
    "the Quick Peek closes"
  );
}

add_task(async function a_quick_peeks_bar_keeps_a_long_hosts_end_in_view() {
  const tab = await openPage(`${longOrigin}/`);
  const browser = tab.linkedBrowser;

  let quickPeek = await quickPeekAt(
    browser,
    "#long",
    `${longOrigin}/quick-peeked/a/path/long/enough/to/be/cut`
  );
  let card = document.getElementById(quickPeek.linkedPanel);
  let url = card.querySelector(".sval-quick-peek-url");
  let host = card.querySelector(".sval-quick-peek-host");
  await TestUtils.waitForCondition(
    () => host.textContent.startsWith(LONG_HOST),
    "the bar shows the long host"
  );
  assertEndInView(host, [host, url]);
  await closeQuickPeek(quickPeek);

  quickPeek = await quickPeekAt(browser, "#short", SHORT);
  card = document.getElementById(quickPeek.linkedPanel);
  url = card.querySelector(".sval-quick-peek-url");
  host = card.querySelector(".sval-quick-peek-host");
  await TestUtils.waitForCondition(
    () => host.textContent === "example.com",
    "the bar shows a short host"
  );
  assertWhole(host, [host, url]);
  await closeQuickPeek(quickPeek);

  BrowserTestUtils.removeTab(tab);
  await PlacesUtils.history.clear();
});
