/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Answers a form's POST with a page, which reloading must send again.
function handleRequest(request, response) {
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.setHeader("Cache-Control", "no-store", false);
  response.write(`<!doctype html><title>Sent</title><p>${request.method}</p>`);
}
