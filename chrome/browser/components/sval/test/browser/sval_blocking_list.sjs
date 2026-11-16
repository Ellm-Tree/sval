/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// The publisher of the blocking tests' lists and uBlock Origin files.
//
// `?list=<id>&body=<text>` answers with `text` and counts a download of
// list `id`; `?count=<id>` answers with that count.
// `?ubo/test-commit/<path>` answers with the file at `path` of the files a
// POST to `?ubo-files` last gave as JSON, path to text, and any other path
// or commit with 404.
function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-store", false);
  response.setHeader("Content-Type", "text/plain", false);
  const query = request.queryString;
  if (query == "ubo-files") {
    const body = request.bodyInputStream;
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(body);
    setSharedState("sval-blocking-ubo", stream.read(body.available()));
    return;
  }
  if (query.startsWith("ubo/")) {
    const files = JSON.parse(getSharedState("sval-blocking-ubo") || "{}");
    const [, commit, ...parts] = query.split("/");
    const path = parts.join("/");
    if (commit != "test-commit" || !(path in files)) {
      response.setStatusLine(request.httpVersion, 404, "Not Found");
      return;
    }
    response.write(files[path]);
    return;
  }
  const params = new URLSearchParams(query);
  if (params.has("count")) {
    response.write(
      getSharedState(`sval-blocking-${params.get("count")}`) || "0"
    );
    return;
  }
  const key = `sval-blocking-${params.get("list")}`;
  setSharedState(key, String(Number(getSharedState(key) || "0") + 1));
  response.write(params.get("body") ?? "");
}
