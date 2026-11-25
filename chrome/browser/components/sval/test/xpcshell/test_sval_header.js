/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const {
  EXTENSIONS_BUTTON_ID,
  HEADER_WIDGETS,
  RECORD_WIDGETS,
  SET_AREAS,
  SET_WIDGETS,
  SPLIT_BUTTON_ID,
  addressTail,
  arrangement,
  displayDomain,
  headerPlacements,
  tailChunks,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHeader.sys.mjs"
);

const uri = spec => Services.io.newURI(spec);

/**
 * The header's order: Sval's widgets, then what stays, then the extensions
 * button and the records, whatever order Firefox or a pin left them in.
 */
add_task(function the_header_order_is_sval_then_kept_then_extensions() {
  const pinned = "ext-a-browser-action";
  const stuck = "vertical-spacer";
  const current = [
    "back-button",
    "sval-notices-button",
    "unified-extensions-button",
    "downloads-button",
    "spring",
    pinned,
    "fxa-toolbar-menu-button",
    stuck,
    "urlbar-container",
  ];
  const keep = id => id === pinned || id === stuck;
  Assert.deepEqual(headerPlacements(current, keep), [
    ...HEADER_WIDGETS,
    pinned,
    stuck,
    "unified-extensions-button",
    ...RECORD_WIDGETS,
  ]);
});

add_task(function an_arranged_row_is_its_own_order() {
  const row = [
    ...HEADER_WIDGETS,
    "ext-b-browser-action",
    "unified-extensions-button",
    ...RECORD_WIDGETS,
  ];
  Assert.deepEqual(
    headerPlacements(row, id => id.endsWith("-browser-action")),
    row
  );
});

add_task(function only_a_web_page_is_shortened_to_its_host() {
  Assert.equal(
    displayDomain(uri("https://www.example.com/a?b#c")),
    "example.com"
  );
  Assert.equal(
    displayDomain(uri("http://sub.example.org:8080/")),
    "sub.example.org"
  );
  Assert.equal(
    displayDomain(uri("https://wwwx.example.com/")),
    "wwwx.example.com"
  );
  Assert.equal(displayDomain(uri("about:license")), "");
  Assert.equal(displayDomain(uri("file:///tmp/x.html")), "");
  Assert.equal(displayDomain(null), "");
});

add_task(function the_tail_is_the_path_with_the_query_on_request() {
  const page = uri("https://git.example.com/owner/repo/pulls/1?a=1&b=2#c");
  const decoded = "https://git.example.com/owner/repo/pulls/1?a=1&b=2#c";
  Assert.equal(addressTail(page, decoded, "path"), "/owner/repo/pulls/1");
  Assert.equal(
    addressTail(page, decoded, "full"),
    "/owner/repo/pulls/1?a=1&b=2#c"
  );
  Assert.equal(
    addressTail(uri("https://example.com/"), "https://example.com/", "full"),
    "",
    "the site's root has no tail"
  );
  Assert.equal(
    addressTail(
      uri("http://example.com:8080/a"),
      "http://example.com:8080/a",
      "path"
    ),
    "/a",
    "a port stays with the host"
  );
});

add_task(function a_route_in_the_fragment_is_the_path() {
  const path = spec => addressTail(uri(spec), spec, "path");
  Assert.equal(
    path("https://portal.azure.com/#@tenant.example/resource/billing"),
    "/#@tenant.example/resource/billing",
    "a fragment holding a path stands in for the bare root"
  );
  Assert.equal(
    path("https://mail.example.com/?x=1#inbox/123?compose=new"),
    "/#inbox/123",
    "the page's query and the route's own are dropped"
  );
  Assert.equal(path("https://example.com/#top"), "", "an anchor stays hidden");
  Assert.equal(
    path("https://example.com/docs/#/section"),
    "/docs/",
    "a real path keeps its fragment hidden"
  );
});

add_task(function the_tail_splits_at_its_punctuation() {
  Assert.deepEqual(tailChunks("/hello/world/this?x=1&y=2#z"), [
    "/hello",
    "/world",
    "/this",
    "?x=1",
    "&y=2",
    "#z",
  ]);
  Assert.deepEqual(tailChunks("/dir/"), ["/dir", "/"]);
  Assert.deepEqual(tailChunks(""), []);
});

/**
 * In the Workspace panel, each widget stands in its set, pinned extension
 * buttons in the tools set between Split and the extensions button, and
 * `#nav-bar` keeps only what cannot leave it. Above the page, the sets are
 * empty.
 */
add_task(function each_widget_stands_in_its_set() {
  const pinned = "ext-a-browser-action";
  const stuck = "vertical-spacer";
  const current = {
    "nav-bar": [
      ...HEADER_WIDGETS,
      pinned,
      stuck,
      EXTENSIONS_BUTTON_ID,
      ...RECORD_WIDGETS,
    ],
  };
  const keep = id => id === pinned || id === stuck;
  const isExtension = id => id === pinned;

  const inPanel = arrangement(current, true, keep, isExtension);
  for (const [set, ids] of Object.entries(SET_WIDGETS)) {
    const want =
      set === "tools" ? [SPLIT_BUTTON_ID, pinned, EXTENSIONS_BUTTON_ID] : ids;
    Assert.deepEqual(inPanel[SET_AREAS[set]], want, `the ${set} set`);
  }
  Assert.deepEqual(inPanel["nav-bar"], [stuck], "#nav-bar keeps what stays");

  const above = arrangement(inPanel, false, keep, isExtension);
  for (const area of Object.values(SET_AREAS)) {
    Assert.deepEqual(above[area], [], `${area} is empty above the page`);
  }
  Assert.ok(
    above["nav-bar"].includes(pinned) && above["nav-bar"].includes(stuck),
    "#nav-bar takes every widget back"
  );
});
