/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Counts requests for `?hit`; `?count` answers with the count so far.
function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-cache", false);
  const count = parseInt(getSharedState("sval-page-rules-beacon") || "0", 10);
  if (request.queryString == "hit") {
    setSharedState("sval-page-rules-beacon", String(count + 1));
    response.setHeader("Content-Type", "image/gif", false);
    return;
  }
  response.setHeader("Content-Type", "text/plain", false);
  response.write(String(count));
}
