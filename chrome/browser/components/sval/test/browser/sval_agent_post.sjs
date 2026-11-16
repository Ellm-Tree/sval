/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// A form that posts to itself. The page says which method fetched it and how
// many posts have arrived since the last `?reset`, so a test can tell a
// replayed post from a fresh load. `?frame` is a page with the form in a
// frame.
const COUNT = "sval_agent_post_count";

function handleRequest(request, response) {
  if (request.queryString === "reset") {
    setState(COUNT, "0");
  }
  let posts = Number(getState(COUNT) || "0");
  if (request.method === "POST") {
    posts++;
    setState(COUNT, String(posts));
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  if (request.queryString === "frame") {
    response.write(
      `<!doctype html><title>Framed form</title>` +
        `<iframe src="sval_agent_post.sjs"></iframe>`
    );
    return;
  }
  response.write(
    `<!doctype html><title>${request.method} ${posts}</title>` +
      `<form id="f" method="post" action="sval_agent_post.sjs">` +
      `<input name="a" value="1"><button id="send">Send</button></form>`
  );
}
