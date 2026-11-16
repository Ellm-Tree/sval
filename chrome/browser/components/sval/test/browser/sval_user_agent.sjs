/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Answers with the User-Agent header the request arrived with, as plain text.
function handleRequest(request, response) {
  response.setHeader("Content-Type", "text/plain; charset=utf-8", false);
  response.setHeader("Cache-Control", "no-store", false);
  response.write(request.getHeader("User-Agent"));
}
