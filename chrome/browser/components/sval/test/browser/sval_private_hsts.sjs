/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// A page that asks to be loaded over HTTPS only from now on.
function handleRequest(request, response) {
  response.setHeader("Strict-Transport-Security", "max-age=600", false);
  response.setHeader("Content-Type", "text/html", false);
  response.write("<!doctype html><title>HSTS</title>");
}
