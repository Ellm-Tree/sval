/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Pages that look to Sval like a human-verification check, all served from
// the local test hosts, so no test reaches a real vendor. The query names
// the page:
// - cf: a Cloudflare-style challenge page, 403 with `cf-mitigated`;
// - cfdom: the same page's script marker with no header;
// - aws: an AWS WAF CAPTCHA, 405 with `x-amzn-waf-action: captcha`;
// - awschallenge: AWS WAF's silent challenge, which is not one;
// - px: a HUMAN (PerimeterX) block page;
// - widget: a page embedding a visible widget frame from example.org, which
//   the test names as the widget origin, beside hidden and zero-size ones;
// - negatives: only the hidden and zero-size frames;
// - selfclearing: a visible widget the page removes after one second;
// - frame: the widget frame itself.
// Once the "solve" button has set its cookie, cf and aws serve a plain page.

const SOLVED = "sval_challenge_solved=1";

const page = (title, head, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const SOLVE = `<button id="solve" onclick="document.cookie='${SOLVED}; path=/'; location.reload()">I am a person</button>`;

const PLAIN = page("Shop", "", `<p>The shop.</p><button id="go">Go</button>`);

const hiddenFrames = FRAME =>
  `<iframe src="${FRAME}&hidden" style="visibility:hidden" width="300" height="80"></iframe><iframe src="${FRAME}&zero" width="0" height="0" style="border:0"></iframe>`;

function handleRequest(request, response) {
  const mode = request.queryString;
  // The widget comes from the other test host, as a vendor's does.
  const FRAME = `https://example.org${request.path}?frame`;
  const HIDDEN_FRAMES = hiddenFrames(FRAME);
  const solved =
    request.hasHeader("Cookie") && request.getHeader("Cookie").includes(SOLVED);
  response.setHeader("Cache-Control", "no-store", false);
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  if ((mode === "cf" || mode === "aws") && solved) {
    response.write(PLAIN);
    return;
  }
  switch (mode) {
    case "cf":
      response.setStatusLine(request.httpVersion, 403, "Forbidden");
      response.setHeader("cf-mitigated", "challenge", false);
      response.write(
        page(
          "Just a moment...",
          "<script>window._cf_chl_opt = {};</script>",
          `<p>Checking your browser.</p>${SOLVE}`
        )
      );
      return;
    case "cfdom":
      response.write(
        page(
          "Just a moment...",
          "<script>window._cf_chl_opt = {};</script>",
          "<p>Checking your browser.</p>"
        )
      );
      return;
    case "aws":
      response.setStatusLine(request.httpVersion, 405, "Method Not Allowed");
      response.setHeader("x-amzn-waf-action", "captcha", false);
      response.write(page("Verify", "", `<p>Solve the puzzle.</p>${SOLVE}`));
      return;
    case "awschallenge":
      response.setStatusLine(request.httpVersion, 202, "Accepted");
      response.setHeader("x-amzn-waf-action", "challenge", false);
      response.write(PLAIN);
      return;
    case "px":
      response.setStatusLine(request.httpVersion, 403, "Forbidden");
      response.write(
        page(
          "Access denied",
          '<meta name="description" content="px-captcha">',
          "<p>Press and hold.</p>"
        )
      );
      return;
    case "widget":
      response.write(
        page(
          "Sign in",
          "",
          `<button id="go">Go</button><iframe id="widget" src="${FRAME}" width="300" height="80"></iframe>${HIDDEN_FRAMES}`
        )
      );
      return;
    case "negatives":
      response.write(
        page("Sign in", "", `<button id="go">Go</button>${HIDDEN_FRAMES}`)
      );
      return;
    case "selfclearing":
      response.write(
        page(
          "Sign in",
          "",
          `<button id="go">Go</button><iframe id="widget" src="${FRAME}" width="300" height="80"></iframe><script>setTimeout(() => document.getElementById("widget").remove(), 1000);</script>`
        )
      );
      return;
    default:
      response.write(page("Widget", "", "<p>Check the box.</p>"));
  }
}
