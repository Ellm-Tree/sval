/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Answers after 1.5 s, as a slow read a click handler awaits would.
//
// `?hold=<key>` answers only once a `?release=<key>` arrives, for a test that
// needs the read to end when it says. The server's own timers cannot promise
// that: on Windows, a timer in the otherwise idle server process can fire
// seconds late. A release that arrives first is kept, so the hold it was
// meant for answers at once.
//
// What is held or released outlives the file that asked, because every file
// of a run shares this server. So each hold names its own key, and a release
// one test sent with nothing held cannot answer another test's hold.
const DELAY_MS = 1500;

let timer;

function answer(response) {
  response.write("token");
  response.finish();
}

function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-cache", false);
  response.setHeader("Content-Type", "text/plain", false);
  const [verb, key] = request.queryString.split("=");
  const held = `sval_agent_slow_held:${key}`;
  if (verb === "release") {
    getObjectState(held, waiting => {
      if (waiting) {
        setObjectState(held, null);
        answer(waiting);
      } else {
        setState(held, "released");
      }
    });
    response.write("released");
    return;
  }
  response.processAsync();
  if (verb === "hold") {
    if (getState(held) === "released") {
      setState(held, "");
      answer(response);
    } else {
      setObjectState(held, response);
    }
    return;
  }
  timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.init(() => answer(response), DELAY_MS, Ci.nsITimer.TYPE_ONE_SHOT);
}
