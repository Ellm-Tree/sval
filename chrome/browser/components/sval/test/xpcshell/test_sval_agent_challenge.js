/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The human-verification classifier, fed literal headers and frame
// descriptions. It parses addresses and fetches nothing.

const { classify, parseOrigins, DEFAULT_ORIGINS, MIN_FRAME_PX } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentChallenge.sys.mjs"
  );

const ORIGINS = parseOrigins(DEFAULT_ORIGINS);

/**
 * @param {string} src
 * @param {object} [extra] Fields to replace.
 * @returns {object} A frame a person could see and use, from `src`.
 */
const frame = (src, extra = {}) => ({
  src,
  width: 300,
  height: 80,
  visible: true,
  ...extra,
});

const widget = (...frames) => classify({ frames }, ORIGINS);

add_task(function each_vendors_interstitial_counts() {
  Assert.deepEqual(
    classify({ headers: { "cf-mitigated": "challenge" } }, ORIGINS),
    { kind: "interstitial", vendor: "cloudflare" }
  );
  Assert.deepEqual(
    classify({ headers: { "x-amzn-waf-action": "captcha" } }, ORIGINS),
    { kind: "interstitial", vendor: "aws" }
  );
  Assert.deepEqual(classify({ markers: { cloudflare: true } }, ORIGINS), {
    kind: "interstitial",
    vendor: "cloudflare",
  });
  Assert.deepEqual(classify({ markers: { perimeterx: true } }, ORIGINS), {
    kind: "interstitial",
    vendor: "perimeterx",
  });
});

add_task(function each_vendors_visible_widget_counts() {
  const cases = [
    [
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile",
      "cloudflare",
    ],
    ["https://geo.captcha-delivery.com/captcha/?initialCid=x", "datadome"],
    [
      "https://www.google.com/recaptcha/api2/anchor?k=key&size=normal",
      "recaptcha",
    ],
    [
      "https://www.recaptcha.net/recaptcha/enterprise/bframe?k=key",
      "recaptcha",
    ],
    [
      "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html",
      "hcaptcha",
    ],
    ["https://client-api.arkoselabs.com/fc/gc/?token=x", "arkose"],
  ];
  for (const [src, vendor] of cases) {
    Assert.deepEqual(widget(frame(src)), { kind: "widget", vendor }, src);
  }
});

add_task(function silent_and_unrelated_signals_do_not_count() {
  const negatives = [
    // reCAPTCHA v3's badge and an invisible v2.
    widget(
      frame("https://www.google.com/recaptcha/api2/anchor?k=k&size=invisible")
    ),
    // Another Google frame on the same origin.
    widget(frame("https://www.google.com/maps/embed?pb=x")),
    // Invisible hCaptcha.
    widget(
      frame(
        "https://newassets.hcaptcha.com/captcha/v1/x/hcaptcha.html#invisible"
      )
    ),
    // A zero-size Turnstile, and one too small to use.
    widget(
      frame("https://challenges.cloudflare.com/x", { width: 0, height: 0 })
    ),
    widget(
      frame("https://challenges.cloudflare.com/x", {
        width: MIN_FRAME_PX - 1,
      })
    ),
    // A hidden or scrolled-away widget.
    widget(frame("https://challenges.cloudflare.com/x", { visible: false })),
    // A look-alike host.
    widget(frame("https://challenges.cloudflare.com.example.net/x")),
    widget(frame("https://notarkoselabs.com/x")),
    // AWS WAF's silent challenge, and a lone DataDome header.
    classify({ headers: { "x-amzn-waf-action": "challenge" } }, ORIGINS),
    classify({ headers: { "x-datadome": "protected" } }, ORIGINS),
    classify({ headers: { "cf-mitigated": "block" } }, ORIGINS),
    // A page that merely loads Cloudflare's platform script.
    classify(
      {
        frames: [
          frame("https://shop.example/cdn-cgi/challenge-platform/scripts/x"),
        ],
      },
      ORIGINS
    ),
    classify({}, ORIGINS),
  ];
  for (const [i, result] of negatives.entries()) {
    Assert.equal(result, null, `negative ${i}`);
  }
});

add_task(
  function a_solved_widget_does_not_count_and_an_interstitial_still_does() {
    const turnstile = frame("https://challenges.cloudflare.com/x");
    Assert.equal(
      classify({ frames: [turnstile], markers: { responded: true } }, ORIGINS),
      null
    );
    Assert.deepEqual(
      classify(
        {
          headers: { "cf-mitigated": "challenge" },
          markers: { responded: true },
        },
        ORIGINS
      ),
      { kind: "interstitial", vendor: "cloudflare" }
    );
  }
);

add_task(function origins_parse_and_match_as_written() {
  const origins = parseOrigins(
    "test=https://example.org, wild=https://*.example.com  bad=notaurl =x noequals"
  );
  Assert.deepEqual(
    origins.map(o => [o.vendor, o.host, o.wildcard]),
    [
      ["test", "example.org", false],
      ["wild", "example.com", true],
    ]
  );
  Assert.deepEqual(
    classify({ frames: [frame("https://example.org/w")] }, origins),
    {
      kind: "widget",
      vendor: "test",
    }
  );
  Assert.equal(
    classify({ frames: [frame("http://example.org/w")] }, origins),
    null,
    "the scheme must match"
  );
  Assert.equal(
    classify({ frames: [frame("https://example.org:8443/w")] }, origins),
    null,
    "and the port"
  );
  Assert.deepEqual(
    classify({ frames: [frame("https://a.example.com/w")] }, origins),
    { kind: "widget", vendor: "wild" }
  );
  Assert.equal(
    classify({ frames: [frame("https://example.com/w")] }, origins),
    null,
    "a wildcard matches subdomains only"
  );
});

add_task(function a_widget_loaded_as_the_whole_page_counts() {
  Assert.deepEqual(
    classify(
      {
        page: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x",
      },
      ORIGINS
    ),
    { kind: "interstitial", vendor: "cloudflare" }
  );
  Assert.equal(
    classify({ page: "https://www.google.com/search?q=x" }, ORIGINS),
    null,
    "another page on a vendor's origin does not"
  );
});
