/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// A search engine's suggestions, in the OpenSearch JSON form Firefox reads:
// four completions of the query, so a test sees the section cut them to its
// limit. After a request with `echo=on`, and until one with `echo=off`, the
// query itself comes first, as an engine suggests what was typed.
function handleRequest(request, response) {
  const params = new URLSearchParams(request.queryString);
  response.setHeader("Cache-Control", "no-store", false);
  if (params.has("echo")) {
    setState("sval-launcher-echo", params.get("echo") === "on" ? "1" : "");
    response.write("");
    return;
  }
  const query = params.get("q") ?? "";
  response.setHeader("Content-Type", "application/json", false);
  const completions = ["alpha", "bravo", "charlie", "delta"].map(
    word => `${query} ${word}`
  );
  if (getState("sval-launcher-echo") === "1") {
    completions.unshift(query);
  }
  response.write(JSON.stringify([query, completions]));
}
