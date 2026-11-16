/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The element picker's candidates: the selector, the depth stops, the name,
// the media source and what can be pointed at (element picker spec §3). A
// DOMParser document has no layout, so sizes come in as rects.

const { hostOf, nameOf, pointable, selectorFor, sourceOf, stops } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalElementCandidates.sys.mjs"
  );

function parse(html) {
  return new DOMParser().parseFromString(html, "text/html");
}

add_task(function test_selectorFor_class() {
  let doc = parse(`<div class="ad-slot x" id="top"></div>`);
  let el = doc.querySelector("div");
  Assert.equal(selectorFor(el), ".ad-slot.x", "classes win over the id");
  Assert.ok(el.matches(selectorFor(el)));
});

add_task(function test_selectorFor_escapes_class_names() {
  let doc = parse(`<div class="md:hidden w-1/2 2xl"></div>`);
  let el = doc.querySelector("div");
  let selector = selectorFor(el);
  Assert.equal(selector, ".md\\:hidden.w-1\\/2.\\32 xl");
  Assert.ok(el.matches(selector), "the escaped selector matches");
});

add_task(function test_selectorFor_id() {
  let doc = parse(`<div id="top"></div><div id="1st x"></div>`);
  let [a, b] = doc.querySelectorAll("div");
  Assert.equal(selectorFor(a), "#top");
  Assert.ok(b.matches(selectorFor(b)), "an id needing escapes still matches");
});

add_task(function test_selectorFor_attribute() {
  let doc = parse(`
    <div data-ad-unit="1"></div>
    <p data-slot="a"></p><p data-slot="b"></p>
    <div data-wide="${"x".repeat(80)}"></div>
    <section style="color:red" role="banner"></section>`);
  let [unit, a, b, wide, section] = doc.body.children;
  Assert.equal(selectorFor(unit), "div[data-ad-unit]", "tag-prefixed");
  Assert.equal(
    selectorFor(a),
    `p[data-slot="a"]`,
    "the value is added when the bare attribute matches more than the set"
  );
  Assert.equal(selectorFor(b), `p[data-slot="b"]`);
  Assert.equal(selectorFor(wide), "div[data-wide]", "a long value is left out");
  Assert.equal(
    selectorFor(section),
    "body > section:nth-of-type(1)",
    "style and role do not identify an element"
  );
  for (let el of [unit, a, b, wide, section]) {
    Assert.ok(el.matches(selectorFor(el)));
  }
});

add_task(function test_selectorFor_attribute_choice() {
  let doc = parse(`
    <div role="banner" aria-label="x" tabindex="0" type="a" width="3"
      height="4" itemprop="ad" data-z="1"></div>
    <div role="banner" aria-label="x" tabindex="0" itemprop="ad"></div>`);
  let [first, second] = doc.body.children;
  Assert.equal(selectorFor(first), "div[data-z]", "data attributes first");
  Assert.equal(
    selectorFor(second),
    "div[itemprop]",
    "role, aria-*, tabindex and sizes are never used"
  );
});

add_task(function test_selectorFor_on_attributes() {
  let doc = parse(`
    <div onetrust-banner="1"></div>
    <div onclick="x()"></div>`);
  let [banner, handler] = doc.body.children;
  Assert.equal(
    selectorFor(banner),
    "div[onetrust-banner]",
    "a page's own name starting with on identifies it"
  );
  Assert.equal(
    selectorFor(handler),
    "body > div:nth-of-type(2)",
    "an event handler attribute is never used"
  );
});

add_task(function test_selectorFor_skips_what_a_sheet_refuses() {
  let refused = /[{}\n\r]|\/\*|\*\//;
  let doc = parse(`
    <div class="{{c}}" id="top"></div>
    <div class="{{c}}" id="{{i}}" data-x="ok"></div>
    <div class="{{c}}" id="{{i}}" data-x="{{a}}"></div>
    <div class="{{c}}" data-{{n}}="1"></div>
    <p data-x="{{a}}"></p><p data-x="b"></p>
    <p data-x="a/*b"></p><p data-x="c*/d"></p>
    <p class="r"><span class="{{c}}"></span><i></i></p>`);
  let [byId, byAttr, byOther, byName, braces, , comment, close, withClass] =
    doc.body.children;
  Assert.equal(selectorFor(byId), "#top", "the id follows a refused class");
  Assert.equal(selectorFor(byAttr), `div[data-x="ok"]`);
  Assert.equal(
    selectorFor(byOther),
    "div[data-x]",
    "a refused value leaves the bare attribute"
  );
  Assert.equal(
    selectorFor(byName),
    "body > div:nth-of-type(4)",
    "a refused attribute name is skipped, and the path follows"
  );
  Assert.equal(
    selectorFor(braces),
    "p[data-x]",
    "a refused value leaves the bare attribute"
  );
  Assert.equal(selectorFor(comment), "p[data-x]");
  Assert.equal(selectorFor(close), "p[data-x]");
  let span = withClass.querySelector("span");
  let all = [byId, byAttr, byOther, byName, braces, comment, close, span];
  for (let el of all) {
    let selector = selectorFor(el);
    Assert.ok(!refused.test(selector), `${selector} is not refused`);
    Assert.ok(el.matches(selector), `${selector} matches`);
  }
  Assert.ok(
    !refused.test(selectorFor(doc.querySelector("i"))),
    "a path never takes a refused anchor"
  );
  Assert.equal(selectorFor(doc.querySelector("i")), ".r > i:nth-of-type(1)");
});

add_task(function test_selectorFor_attribute_with_quotes() {
  let doc = parse(`<p data-x='a"b\\c'></p><p data-x="other"></p>`);
  let el = doc.querySelector("p");
  Assert.ok(el.matches(selectorFor(el)), "quotes and backslashes are escaped");
});

add_task(function test_selectorFor_nth_of_type() {
  let doc = parse(`<div class="row"><b></b><span></span><span></span></div>`);
  let el = doc.querySelectorAll("span")[1];
  Assert.equal(selectorFor(el), ".row > span:nth-of-type(2)");
  Assert.ok(el.matches(selectorFor(el)));
  Assert.equal(doc.querySelectorAll(selectorFor(el)).length, 1);
});

add_task(function test_selectorFor_nth_of_type_deep() {
  let doc = parse(
    `<div class="row"><div><i></i></div><div><u></u><u></u></div></div>`
  );
  let el = doc.querySelectorAll("u")[1];
  Assert.equal(
    selectorFor(el),
    ".row > div:nth-of-type(2) > u:nth-of-type(2)",
    "every level between the classed ancestor and the element is counted"
  );
  Assert.ok(el.matches(selectorFor(el)));
});

add_task(function test_selectorFor_nth_of_type_without_classed_ancestor() {
  let doc = parse(`<main><i></i><div><u></u></div></main>`);
  let el = doc.querySelector("u");
  let selector = selectorFor(el);
  Assert.equal(
    selector,
    "body > main:nth-of-type(1) > div:nth-of-type(1) > u:nth-of-type(1)"
  );
  Assert.ok(el.matches(selector));
});

add_task(function test_stops() {
  let doc = parse(
    `<div id="a"><div id="b"><div id="c"><div id="d"><div id="e"><div id="f">
     <div id="g"><i id="el"></i></div></div></div></div></div></div></div>`
  );
  let el = doc.getElementById("el");
  let result = stops(el);
  Assert.equal(result.length, 6, "capped at six");
  Assert.equal(result[0], el, "the clicked element is stop one");
  Assert.deepEqual(
    result.map(e => e.id),
    ["el", "g", "f", "e", "d", "c"],
    "nearest first"
  );
  Assert.ok(!result.some(e => e.localName == "body"), "never body");
});

add_task(function test_stops_of_body_children() {
  let doc = parse(`<div id="a"></div>`);
  let el = doc.getElementById("a");
  Assert.deepEqual(stops(el), [el]);
  Assert.deepEqual(stops(doc.body), []);
});

add_task(function test_nameOf() {
  let doc = parse(`
    <img><picture></picture><a></a><iframe></iframe><video></video>
    <audio></audio><aside></aside><nav></nav><header></header>
    <footer></footer><section></section><article></article><button></button>
    <dialog></dialog><div role="dialog"></div><div></div><span></span>`);
  Assert.deepEqual([...doc.body.children].map(nameOf), [
    "Image",
    "Image",
    "Link",
    "Frame",
    "Video",
    "Audio",
    "Sidebar",
    "Navigation",
    "Header",
    "Footer",
    "Section",
    "Section",
    "Button",
    "Dialog",
    "Dialog",
    "Box",
    "Box",
  ]);
});

add_task(function test_sourceOf() {
  let doc = parse(`
    <img src="https://a.example/i.png">
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <picture><source srcset="x"><img src="http://a.example/p.jpg"></picture>
    <picture></picture>
    <iframe src="https://a.example/f"></iframe>
    <iframe src="about:blank"></iframe>
    <video><source src="https://a.example/v.mp4"></video>
    <audio src="https://a.example/s.mp3"></audio>
    <img>
    <div></div>`);
  let [
    img,
    dataImg,
    picture,
    emptyPicture,
    iframe,
    blank,
    video,
    audio,
    bare,
    div,
  ] = doc.body.children;
  Assert.equal(sourceOf(img), "https://a.example/i.png");
  Assert.equal(sourceOf(dataImg), null, "a data: image has no host");
  Assert.equal(sourceOf(picture), "http://a.example/p.jpg");
  Assert.equal(sourceOf(emptyPicture), null);
  Assert.equal(sourceOf(iframe), "https://a.example/f");
  Assert.equal(sourceOf(blank), null);
  Assert.equal(sourceOf(video), "https://a.example/v.mp4");
  Assert.equal(sourceOf(audio), "https://a.example/s.mp3");
  Assert.equal(sourceOf(bare), null);
  Assert.equal(sourceOf(div), null);
});

add_task(function test_pointable() {
  let doc = parse(`<div></div>`);
  let div = doc.querySelector("div");
  let rect = (width, height) => ({ width, height });
  Assert.ok(pointable(div, rect(100, 50)));
  Assert.ok(!pointable(div, rect(7, 50)), "under 8 wide");
  Assert.ok(!pointable(div, rect(50, 7)), "under 8 high");
  Assert.ok(pointable(div, rect(8, 8)), "8 by 8 is enough");
  Assert.ok(pointable(div, rect(1000, 800)), "a full-screen layer");
  Assert.ok(!pointable(doc.body, rect(50, 50)), "never body");
  Assert.ok(!pointable(doc.documentElement, rect(50, 50)), "never html");
});

add_task(function test_hostOf() {
  let doc = parse(`<div id="outer"></div><p id="plain"></p>`);
  let outer = doc.getElementById("outer");
  let shadow = outer.attachShadow({ mode: "open" });
  shadow.innerHTML = `<div id="inner"><span id="leaf"></span></div>`;
  let innerHost = shadow.getElementById("inner");
  let nested = innerHost.attachShadow({ mode: "open" });
  nested.innerHTML = `<b id="deep"></b>`;
  Assert.equal(hostOf(shadow.getElementById("leaf")), outer);
  Assert.equal(hostOf(nested.getElementById("deep")), outer, "outermost host");
  let plain = doc.getElementById("plain");
  Assert.equal(hostOf(plain), plain, "an element in the page is its own host");

  let detached = doc.createElement("a");
  Assert.equal(hostOf(detached), detached, "a detached element has no host");
  let fragment = doc.createDocumentFragment();
  let inFragment = fragment.appendChild(doc.createElement("b"));
  Assert.equal(hostOf(inFragment), inFragment, "a fragment is not a host");
});
