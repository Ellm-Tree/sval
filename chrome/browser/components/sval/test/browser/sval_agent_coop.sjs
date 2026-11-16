/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// A page that isolates itself, so loading it replaces the tab's top-level
// browsing context.
function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-cache", false);
  response.setHeader("Content-Type", "text/html", false);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin", false);
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp", false);
  response.write("<!doctype html><title>isolated</title>");
}
