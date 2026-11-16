/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Serves an image and counts the requests for it, but for `?same`, the page's
// own copy; `?count` answers with the count so far. The test reads the count
// from the parent, whose requests the image's network rule, scoped to the
// page's site, does not block.
function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-store", false);
  const count = parseInt(
    getSharedState("sval-element-picker-image") || "0",
    10
  );
  if (request.queryString == "count") {
    response.setHeader("Content-Type", "text/plain", false);
    response.write(String(count));
    return;
  }
  if (request.queryString != "same") {
    setSharedState("sval-element-picker-image", String(count + 1));
  }
  response.setHeader("Content-Type", "image/svg+xml", false);
  response.write(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">' +
      '<rect width="40" height="40" fill="#888"/></svg>'
  );
}
