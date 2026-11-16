/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Answers with the page its query spells out, percent-encoded, so a switcher
// test's tab has a web address that round-trips and a title of its own.
function handleRequest(request, response) {
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.setHeader("Cache-Control", "no-store", false);
  response.write(decodeURIComponent(request.queryString));
}
