/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Answers with the HTTP status in the query string, and a page whose title
// says so.
function handleRequest(request, response) {
  const code = parseInt(request.queryString, 10);
  response.setHeader("Cache-Control", "no-cache", false);
  response.setHeader("Content-Type", "text/html", false);
  response.setStatusLine(request.httpVersion, code, "Status");
  response.write(`<!DOCTYPE html><title>Status ${code}</title><p>${code}</p>`);
}
