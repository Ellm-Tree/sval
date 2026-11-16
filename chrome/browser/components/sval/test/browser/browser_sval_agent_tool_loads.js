/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What an agent's loads answer (agent-control spec §4): a page's status, a
 * stable code for each way a load fails, and the page's source read in
 * windows that stay inside it.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/** The levels the agents here have: full access to the test pages' sites. */
const SITES = { "example.com": "full", "example.org": "full" };

/**
 * A paired agent, on the stack the product builds.
 *
 * @param {object} [sites] Its levels.
 * @returns {Promise<object>} `agentSetup`'s.
 */
function agentTools(sites = SITES) {
  return agentSetup({ sites });
}

/** Answers with the status in its query string. */
const STATUS_PAGE = ROOT + "sval_agent_status.sjs";

add_task(async function a_load_reports_its_status() {
  const { call } = await agentTools();
  const missing = await call("open_tab", { url: `${STATUS_PAGE}?404` });
  Assert.equal(missing.title, "Status 404", "the page loads");
  Assert.equal(missing.status, 404);

  const redirected = await call("navigate_tab", {
    tab: missing.tab,
    to: `${ROOT}sval_agent_redirect.sjs?${encodeURIComponent(
      `${STATUS_PAGE}?500`
    )}`,
  });
  Assert.equal(redirected.status, 500, "the last response's status");
  Assert.equal(redirected.url, `${STATUS_PAGE}?500`, "after the redirect");

  const back = await call("navigate_tab", { tab: missing.tab, to: "back" });
  Assert.equal(back.url, `${STATUS_PAGE}?404`);
  Assert.ok(
    back.status === undefined || back.status === 404,
    "a history entry answers what it answered, or nothing"
  );
});

/** @returns {Promise<number>} A local port nothing listens on. */
async function closedPort() {
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  server.init(-1, true, -1);
  const { port } = server;
  server.close();
  return port;
}

add_task(async function a_failed_load_has_a_stable_code() {
  const { call } = await agentTools({
    ...SITES,
    "sval-no-such-host.invalid": "full",
    "127.0.0.1": "full",
  });
  const failure = async url => {
    try {
      await call("open_tab", { url });
    } catch (err) {
      return err;
    }
    return null;
  };

  // eslint-disable-next-line sdl/no-insecure-url
  const unknown = await failure("http://sval-no-such-host.invalid/");
  Assert.equal(unknown?.code, "dns_failure");
  Assert.ok(unknown.message.includes("NS_ERROR_UNKNOWN_HOST"), unknown.message);

  const port = await closedPort();
  // eslint-disable-next-line sdl/no-insecure-url
  const refused = await failure(`http://127.0.0.1:${port}/`);
  Assert.equal(refused?.code, "connection_refused");
  Assert.ok(
    refused.message.includes("NS_ERROR_CONNECTION_REFUSED"),
    refused.message
  );
});

add_task(async function a_tls_failure_has_a_stable_code() {
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  server.init(-1, true, -1);
  // Kept open until the test ends: a transport closed with the client's
  // handshake unread resets the connection, which is a different failure.
  const open = [];
  server.asyncListen({
    onSocketAccepted(socket, transport) {
      open.push(transport);
      // Plain bytes where a TLS handshake answer belongs.
      const out = transport.openOutputStream(0, 0, 0);
      const junk = "HTTP/1.1 200 OK\r\n\r\n";
      out.write(junk, junk.length);
    },
    onStopListening() {},
  });
  atTaskEnd(() => {
    open.forEach(transport => transport.close(Cr.NS_OK));
    server.close();
  });
  const { call } = await agentTools({ ...SITES, "127.0.0.1": "full" });
  await Assert.rejects(
    call("open_tab", { url: `https://127.0.0.1:${server.port}/` }),
    e => e.code === "tls_error",
    "a host that does not speak TLS"
  );
});

/**
 * An offset past the end reads an empty window of the page's own source, one
 * below zero or fractional is refused, and every chunk has its secret values
 * removed.
 */
add_task(async function page_source_offsets_stay_inside_the_source() {
  const { call } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });
  const whole = await call("get_page_source", { tab, max_chars: 100_000 });
  Assert.ok(!whole.html.includes("hunter2"), "a password's value is removed");

  const past = await call("get_page_source", { tab, offset: 10_000_000 });
  Assert.deepEqual(
    [past.html, past.offset, past.next_offset, past.total],
    ["", whole.total, null, whole.total],
    "past the end is empty"
  );
  for (const offset of [-5, 2.9]) {
    await Assert.rejects(
      call("get_page_source", { tab, offset }),
      e => e.code === "invalid_arguments",
      `an offset of ${offset} is refused`
    );
  }

  let seen = "";
  for (let offset = 0; offset !== null; ) {
    const chunk = await call("get_page_source", { tab, offset, max_chars: 40 });
    Assert.ok(!chunk.html.includes("hunter2"), "every chunk is cleaned");
    seen += chunk.html;
    offset = chunk.next_offset;
  }
  Assert.equal(seen, whole.html);
});
