/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A server that ends the TLS handshake with an alert gets a page saying the
 * secure connection could not be made, with Try Again, and no claim that the
 * data it received failed to verify (`errors/server-alert-errors.mjs`).
 */

// A plaintext TLS record: alert, TLS 1.2 record version, two bytes long,
// fatal, internal_error (RFC 8446 section 6).
const INTERNAL_ERROR_ALERT = "\x15\x03\x03\x00\x02\x02\x50";

function startAlertServer() {
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  server.init(-1, true, -1);
  const transports = [];
  server.asyncListen({
    onSocketAccepted(_socket, transport) {
      transports.push(transport);
      const out = transport.openOutputStream(
        Ci.nsITransport.OPEN_BLOCKING,
        0,
        0
      );
      out.write(INTERNAL_ERROR_ALERT, INTERNAL_ERROR_ALERT.length);
    },
    onStopListening() {},
  });
  registerCleanupFunction(() => {
    for (const transport of transports) {
      transport.close(Cr.NS_OK);
    }
    server.close();
  });
  return server.port;
}

add_task(async function a_server_alert_gets_a_connection_failure_page() {
  const port = startAlertServer();
  const tab = BrowserTestUtils.addTab(gBrowser, `https://127.0.0.1:${port}/`);
  const shown = BrowserTestUtils.waitForErrorPage(tab.linkedBrowser);
  await selectTab(tab);
  await within(shown, 10_000, "the error page");

  const page = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    // The card's parts are its own getters, which an Xray does not show.
    const card = () =>
      content.document.querySelector("net-error-card")?.wrappedJSObject;
    await ContentTaskUtils.waitForCondition(
      () => card()?.errorIntro,
      "the error card"
    );
    return {
      code: content.document.getNetErrorInfo().errorCodeString,
      intro: card().errorIntro.dataset.l10nId,
      tryAgain: !!card().tryAgainButton,
    };
  });
  Assert.equal(
    page.code,
    "SSL_ERROR_INTERNAL_ERROR_ALERT",
    "the server's alert ended the load"
  );
  Assert.equal(
    page.intro,
    "fp-neterror-connection-intro",
    "the page says the secure connection could not be made"
  );
  Assert.ok(page.tryAgain, "the page offers Try Again");
  BrowserTestUtils.removeTab(tab);
});
