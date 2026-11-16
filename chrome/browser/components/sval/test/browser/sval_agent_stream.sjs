/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// A file served as an attachment a chunk at a time, slowly enough that a test
// can refuse its download while it is still arriving.
const CHUNK = "x".repeat(4096);
const CHUNKS = 200;
const EVERY_MS = 100;

let timer;

function handleRequest(request, response) {
  const query = new URLSearchParams(request.queryString);
  response.processAsync();
  response.setHeader("Cache-Control", "no-cache", false);
  response.setHeader("Content-Type", "application/octet-stream", false);
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${query.get("name") || "stream.bin"}"`,
    false
  );
  let sent = 0;
  timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(
    () => {
      try {
        response.write(CHUNK);
        sent++;
        if (sent >= CHUNKS) {
          timer.cancel();
          response.finish();
        }
      } catch {
        // The download was cancelled and the connection is gone.
        timer.cancel();
      }
    },
    EVERY_MS,
    Ci.nsITimer.TYPE_REPEATING_SLACK
  );
}
