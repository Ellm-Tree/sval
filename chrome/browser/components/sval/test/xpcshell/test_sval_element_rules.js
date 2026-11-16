/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The element picker's reading and editing of a site's lines in "My filters"
// (element picker spec §2). Pure text in, text out.

const {
  appendLines,
  exceptionLine,
  exceptionsInFilters,
  forgetSite,
  hideAgain,
  hideLine,
  linesBySite,
  linesForScope,
  linesForSite,
  networkLine,
  removeSiteFromLine,
  scopesInFilters,
  showAgain,
  sitesInFilters,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalElementRules.sys.mjs"
);

const TEXT = [
  "a.com##.ad",
  "||x.example/p.png$image,domain=a.com",
  "b.com##.ad",
  "a.com,b.com##.both",
  "~a.com##.not",
  "a.com#@#.except",
  "||y.example/q$domain=~a.com",
].join("\n");

add_task(function test_linesForSite() {
  let found = linesForSite(TEXT, "a.com");
  Assert.deepEqual(
    found.map(l => l.index),
    [3, 1, 0],
    "newest first, only lines that list the site"
  );
  Assert.deepEqual(
    found.map(l => l.kind),
    ["hide", "network", "hide"]
  );
  Assert.deepEqual(
    found.map(l => l.shown),
    [".both", "||x.example/p.png", ".ad"]
  );
  Assert.equal(found[0].line, "a.com,b.com##.both");
});

add_task(function test_host_lines_are_grouped_under_their_site() {
  let text = [
    "app.a.com##.ad",
    "a.com##.x",
    "||x.example/p.png$domain=app.a.com",
    "b.github.io##.y",
    "app.a.com#@#.z",
  ].join("\n");
  Assert.deepEqual(
    linesForSite(text, "a.com").map(l => [l.index, l.scope]),
    [
      [2, "app.a.com"],
      [1, "a.com"],
      [0, "app.a.com"],
    ],
    "a site's lines are its own and its hosts', each naming its scope"
  );
  Assert.deepEqual(
    linesForScope(text, "a.com").map(l => l.index),
    [1],
    "a scope's own lines are the site's alone"
  );
  Assert.deepEqual(
    linesForScope(text, "app.a.com").map(l => l.index),
    [2, 0],
    "and the host's alone"
  );
  Assert.deepEqual(sitesInFilters(text), ["a.com", "b.github.io"]);
  Assert.deepEqual(scopesInFilters(text), [
    "app.a.com",
    "a.com",
    "b.github.io",
  ]);
  Assert.deepEqual(
    [...linesBySite(text).keys()],
    ["a.com", "b.github.io"],
    "a host under a public suffix is a site of its own"
  );
  Assert.equal(
    showAgain(text, "app.a.com##.ad", "app.a.com").split("\n").length,
    4,
    "showing a host's line again takes it out"
  );
  Assert.equal(
    showAgain(text, "app.a.com##.ad", "a.com"),
    null,
    "and the site does not name it"
  );
});

add_task(function test_linesBySite() {
  let text = `${TEXT}\nA.com,a.com##.dup\nc.com##.c`;
  let bySite = linesBySite(text);
  for (let site of ["a.com", "b.com", "c.com", "y.example", "x.example"]) {
    Assert.deepEqual(
      bySite.get(site) ?? [],
      linesForSite(text, site),
      `${site} reads as linesForSite reads it`
    );
  }
  Assert.equal(bySite.get("a.com").length, 4, "a line names a site once");
});

add_task(function test_showAgain() {
  Assert.equal(
    showAgain(TEXT, "a.com##.ad", "a.com"),
    removeSiteFromLine(TEXT, 0, "a.com"),
    "the line found by its text loses the site"
  );
  Assert.equal(
    showAgain(TEXT, "a.com,b.com##.both", "a.com").split("\n")[3],
    "b.com##.both",
    "a line with other sites keeps them"
  );
  Assert.equal(
    showAgain(TEXT, "a.com##.gone", "a.com"),
    null,
    "a line that is no longer there is null"
  );
  Assert.equal(
    showAgain(TEXT, "b.com##.ad", "a.com"),
    null,
    "a line that does not name the site is null"
  );
  Assert.equal(
    showAgain(TEXT, "a.com#@#.except", "a.com"),
    null,
    "a line that is not a hidden element is null"
  );
  // The line moved since the card drew: the text decides, not the index.
  let moved = `c.com##.new\n${TEXT}`;
  Assert.equal(
    showAgain(moved, "a.com##.ad", "a.com").split("\n").length,
    moved.split("\n").length - 1,
    "the line is found where it sits"
  );
  Assert.ok(
    showAgain(moved, "a.com##.ad", "a.com").includes("c.com##.new"),
    "no other line goes"
  );
});

add_task(function test_removeSiteFromLine() {
  Assert.equal(
    removeSiteFromLine(TEXT, 3, "a.com").split("\n")[3],
    "b.com##.both",
    "the site leaves a shared line"
  );
  let lines = removeSiteFromLine(TEXT, 0, "a.com").split("\n");
  Assert.equal(lines.length, 6, "a line of one site is deleted");
  Assert.equal(lines[0], "||x.example/p.png$image,domain=a.com");

  let shared = "||x.example/p.png$domain=a.com|b.com";
  Assert.equal(
    removeSiteFromLine(shared, 0, "a.com"),
    "||x.example/p.png$domain=b.com"
  );
  Assert.equal(
    removeSiteFromLine("||x.example/p.png$image,domain=a.com", 0, "a.com"),
    "",
    "a network line left with no site is deleted, never widened"
  );
  Assert.equal(
    removeSiteFromLine("a.com,~b.com##.x\nc.com##.y", 0, "a.com"),
    "c.com##.y",
    "a line left with only exclusions is deleted"
  );
  Assert.equal(
    removeSiteFromLine(TEXT, 4, "a.com"),
    TEXT,
    "a line that does not list the site is unchanged"
  );
  Assert.equal(removeSiteFromLine(TEXT, 99, "a.com"), TEXT);
});

add_task(function test_forgetSite() {
  let { text, removed } = forgetSite(TEXT, "a.com");
  Assert.equal(removed, 4);
  Assert.equal(
    text,
    [
      "b.com##.ad",
      "b.com##.both",
      "~a.com##.not",
      "||y.example/q$domain=~a.com",
    ].join("\n"),
    "the exclusion and the other site's lines stay"
  );
  Assert.deepEqual(
    forgetSite(
      [
        "app.a.com##.x",
        "app.a.com,b.com##.y",
        "app.a.com#@#.z",
        "c.com##.k",
      ].join("\n"),
      "a.com"
    ),
    { text: "b.com##.y\nc.com##.k", removed: 3 },
    "the site's hosts' lines and exceptions go with it"
  );
  Assert.deepEqual(forgetSite("b.com##.x", "a.com"), {
    text: "b.com##.x",
    removed: 0,
  });
});

add_task(function test_writing_lines() {
  Assert.equal(hideLine("a.com", ".ad > img"), "a.com##.ad > img");
  Assert.equal(hideLine("app.a.com", ".ad"), "app.a.com##.ad");
  Assert.equal(exceptionLine("app.a.com", ".ad"), "app.a.com#@#.ad");
  Assert.equal(
    networkLine("a.com", "https://cdn.x.example/c/ad.png?u=1#f"),
    "||cdn.x.example/c/ad.png$domain=a.com"
  );
  Assert.equal(appendLines("x\n", ["y"]), "x\ny");
  Assert.equal(appendLines("x", ["y"]), "x\ny");
  Assert.equal(appendLines("", ["y"]), "y");
  Assert.equal(appendLines("x\n", ["y", "z"]), "x\ny\nz");
  Assert.equal(appendLines("x", []), "x");
});

add_task(function test_networkLine_refuses_a_rule_that_matches_more() {
  for (let url of [
    "https://x.example/",
    "https://x.example",
    "https://x.example/?q=1",
    "https://x.example/a*b.png",
    "https://x.example/a^b.png",
    "https://x.example/a|b.png",
    "https://x.example/a$b.png",
    "not a url",
  ]) {
    Assert.equal(networkLine("a.com", url), null, `no rule for ${url}`);
  }
  Assert.equal(
    networkLine("a.com", "http://x.example:8080/p/q.js"),
    "||x.example:8080/p/q.js$domain=a.com"
  );
});

add_task(function test_scriptlets_and_html_filters_are_not_hidden_elements() {
  let text = [
    "a.com##+js(set-constant, x, 1)",
    "a.com##^script:has-text(ad)",
    "a.com##.ad",
    "a.com,b.com##+js(nobab)",
  ].join("\n");
  Assert.deepEqual(
    linesForSite(text, "a.com").map(l => l.index),
    [2],
    "only the hiding rule is listed"
  );
  Assert.equal(removeSiteFromLine(text, 0, "a.com"), text);
  Assert.equal(removeSiteFromLine(text, 3, "a.com"), text);
  let forgotten = forgetSite(text, "a.com");
  Assert.equal(forgotten.removed, 1);
  Assert.equal(
    forgotten.text,
    [
      "a.com##+js(set-constant, x, 1)",
      "a.com##^script:has-text(ad)",
      "a.com,b.com##+js(nobab)",
    ].join("\n")
  );
});

add_task(function test_network_line_with_hashes_in_its_path() {
  let text = [
    "||h.example/a##b$domain=a.com",
    "||h.example/c#?#d$domain=a.com|b.com",
  ].join("\n");
  let found = linesForSite(text, "a.com");
  Assert.deepEqual(
    found.map(l => [l.index, l.kind, l.shown]),
    [
      [1, "network", "||h.example/c#?#d"],
      [0, "network", "||h.example/a##b"],
    ]
  );
  Assert.equal(removeSiteFromLine(text, 0, "a.com").split("\n").length, 1);
  Assert.equal(
    removeSiteFromLine(text, 1, "a.com").split("\n")[1],
    "||h.example/c#?#d$domain=b.com"
  );
});

add_task(function test_other_forms_and_spacing() {
  let text = [
    "a.com#?#.procedural",
    "  a.com##.spaced  ",
    "! a.com##.comment",
    "!a.com##.comment",
    "a.com#@?#.x",
    "a.com#$#.x { color: red }",
    "a.com#%#//scriptlet",
    "@@||x.example/y$domain=a.com",
    "||m.example/n$domain=~a.com|b.com",
    "||o.example/p$domain=a.com,third-party",
    "||q.example/r$third-party,domain=a.com|b.com,image",
  ].join("\n");
  let found = linesForSite(text, "a.com");
  Assert.deepEqual(
    found.map(l => l.index),
    [10, 9, 1, 0]
  );
  Assert.deepEqual(
    found.map(l => l.shown),
    ["||q.example/r", "||o.example/p", ".spaced", ".procedural"]
  );
  Assert.deepEqual(
    linesForSite(text, "b.com").map(l => l.index),
    [10, 8],
    "domain=~a.com|b.com names b.com"
  );

  let lines = removeSiteFromLine(text, 10, "a.com").split("\n");
  Assert.equal(lines[10], "||q.example/r$third-party,domain=b.com,image");
  lines = removeSiteFromLine(text, 9, "a.com").split("\n");
  Assert.equal(lines.length, 10, "a.com was the last domain of the line");
  lines = removeSiteFromLine(text, 8, "b.com").split("\n");
  Assert.equal(lines.length, 10, "only ~a.com would be left, so the line goes");
  lines = removeSiteFromLine(text, 0, "a.com").split("\n");
  Assert.equal(lines[0], "  a.com##.spaced  ", "other lines keep their bytes");
});

add_task(function test_forgetSite_keeps_other_lines_byte_for_byte() {
  let text =
    "keep  \r\na.com##.ad\r\nb.com,a.com##.both\r\n\r\n  ~a.com##.n \r\n";
  let { text: out, removed } = forgetSite(text, "a.com");
  Assert.equal(removed, 2);
  Assert.equal(out, "keep  \r\nb.com##.both\r\n\r\n  ~a.com##.n \r\n");
});

add_task(function test_sitesInFilters() {
  Assert.deepEqual(sitesInFilters(TEXT), ["a.com", "b.com"], "text order");
  Assert.deepEqual(sitesInFilters(""), []);
  let text = [
    "! a.com##.comment",
    "A.com##.ad",
    "a.com##.twice",
    "c.com,~d.com##.some",
    "~e.com##.only-negated",
    "f.com#@#.exception",
    "@@||x.example/p$domain=g.com",
    "h.com##+js(set, a, b)",
    "i.com##^script",
    "||x.example/p$image,domain=j.com|~k.com|l.com",
    "||y.example/q$domain=~m.com",
    "||z.example/path##x",
    "*.n.com##.wild",
    "google.*##.entity",
    "##.generic",
    "||no-domain.example^",
    "o.com#?#.procedural",
    "p.com#$#abort-on-property-read x",
  ].join("\r\n");
  Assert.deepEqual(
    sitesInFilters(text),
    ["a.com", "c.com", "j.com", "l.com", "o.com"],
    "plain domains of hide and network lines, each once"
  );
});

add_task(function test_exceptionsInFilters() {
  const text = [
    "a.com##.ad",
    "App.A.com#@#.ad",
    "app.a.com,b.com#@#.both",
    "~c.com#@#.not",
    "app.a.com#@#.ad",
  ].join("\n");
  Assert.deepEqual(
    [...exceptionsInFilters(text)],
    [
      ["app.a.com", [".ad", ".both", ".ad"]],
      ["b.com", [".both"]],
    ],
    "each plain host with the selectors it shows again, oldest first"
  );
  Assert.equal(exceptionsInFilters("a.com##.ad").size, 0, "a hiding line");
});

add_task(function test_hideAgain() {
  const text = [
    "a.com##.ad",
    "app.a.com#@#.ad",
    "app.a.com,b.com#@#.ad",
    "app.a.com#@#.other",
  ].join("\n");
  Assert.deepEqual(
    hideAgain(text, ["app.a.com", "a.com"], ".ad").split("\n"),
    ["a.com##.ad", "b.com#@#.ad", "app.a.com#@#.other"],
    "the host leaves each exception of the selector, a line naming no other deleted"
  );
  Assert.equal(
    hideAgain(text, ["x.a.com", "a.com"], ".ad"),
    null,
    "no exception names the host"
  );
  Assert.equal(
    hideAgain("a.com##.ad", ["a.com"], ".ad"),
    null,
    "a hiding line is no exception"
  );
});
