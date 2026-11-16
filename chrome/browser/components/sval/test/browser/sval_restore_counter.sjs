/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Answers with how many times it has been asked, cacheable for an hour, so a
// page shown from the cache shows an older count than one fetched again.
function handleRequest(request, response) {
  const count = Number(getState("sval_restore_counter") || "0") + 1;
  setState("sval_restore_counter", String(count));
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.setHeader("Cache-Control", "max-age=3600", false);
  response.write(`<title>${count}</title>${count}`);
}
