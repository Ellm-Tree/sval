/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Answers with a body the HTTP cache keeps for an hour.
function handleRequest(request, response) {
  response.setHeader("Content-Type", "text/plain; charset=utf-8", false);
  response.setHeader("Cache-Control", "max-age=3600", false);
  response.write("cached");
}
