/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Redirects to the URL in the query string.
function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-cache", false);
  response.setStatusLine(request.httpVersion, 302, "Found");
  response.setHeader(
    "Location",
    decodeURIComponent(request.queryString),
    false
  );
}
