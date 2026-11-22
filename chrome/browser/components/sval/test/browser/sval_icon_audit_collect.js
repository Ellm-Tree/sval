/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* exported drawnImages */

/**
 * Every image a document draws from outside Sval's own art, by URL, each with
 * the elements that draw it. A shown element counts with its `::before`,
 * `::after` and `::marker`, its shadow tree and its `src`, `image` and
 * `iconsrc` attributes. Loaded into the parent by
 * `browser_sval_icon_audit.js` and into a content process by its tasks, so
 * it reads nothing outside its argument.
 *
 * @param {Document} doc
 * @returns {{[key: string]: string[]}}
 */
function drawnImages(doc) {
  const SVAL_ART = ["chrome://browser/content/sval/", "chrome://branding/"];
  const URL_RE = /url\("?([^")]+)"?\)/g;
  const PROPERTIES = [
    "list-style-image",
    "background-image",
    "mask-image",
    "content",
    "border-image-source",
  ];
  const found = {};
  const add = (url, el) => {
    if (
      !/^(chrome|resource|moz-src):/.test(url) ||
      SVAL_ART.some(prefix => url.startsWith(prefix))
    ) {
      return;
    }
    const name =
      el.localName +
      (el.id ? `#${el.id}` : "") +
      [...el.classList]
        .slice(0, 2)
        .map(c => `.${c}`)
        .join("");
    const where = (found[url] ??= []);
    if (!where.includes(name) && where.length < 5) {
      where.push(name);
    }
  };
  const visit = root => {
    for (const el of root.querySelectorAll("*")) {
      if (!el.checkVisibility({ checkVisibilityCSS: true })) {
        continue;
      }
      const win = el.documentGlobal;
      for (const pseudo of [null, "::before", "::after", "::marker"]) {
        const style = win.getComputedStyle(el, pseudo);
        for (const property of PROPERTIES) {
          for (const match of style
            .getPropertyValue(property)
            .matchAll(URL_RE)) {
            add(match[1], el);
          }
        }
      }
      for (const attr of ["src", "image", "iconsrc"]) {
        const value = el.getAttribute(attr);
        if (value) {
          add(new URL(value, el.baseURI).href, el);
        }
      }
      const shadow = el.openOrClosedShadowRoot;
      if (shadow) {
        visit(shadow);
      }
    }
  };
  visit(doc);
  return found;
}
