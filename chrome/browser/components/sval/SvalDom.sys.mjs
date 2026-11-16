/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Builds the HTML elements Sval's chrome modules draw into a document, and
 * shades the edges of what scrolls between them.
 */

export const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * An HTML element of `doc`, in the XHTML namespace so it is one in a XUL
 * document too.
 *
 * @param {Document} doc
 * @param {string} tag
 * @param {object} [props] Properties to set, with `dataset` and with
 *   attributes given as `attrs`.
 * @param {...(Node|string|null|undefined)} children Null and undefined are
 *   left out.
 * @returns {Element}
 */
export function htmlElement(doc, tag, props = {}, ...children) {
  const node = doc.createElementNS(HTML_NS, tag);
  const { attrs, dataset, ...rest } = props;
  Object.assign(node, rest);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    node.setAttribute(name, value);
  }
  Object.assign(node.dataset, dataset ?? {});
  node.append(...children.filter(c => c !== null && c !== undefined));
  return node;
}

/**
 * Marks the parts fixed across a scroller's two edges with `sval-over-rows`
 * while its content lies past that edge, so each casts the shadow its
 * `sval-edge-above` or `sval-edge-below` class draws (`sval-tokens.css`).
 * The markers are zero-height elements at the content's two ends; one out of
 * view is content past its edge. An observer follows scrolling, resizing and
 * content coming and going alike, where a scroll listener sees only the
 * first.
 *
 * @param {Element} scroller
 * @param {object} edges
 * @param {Element} edges.topMarker The first thing in the scroller.
 * @param {Element} edges.bottomMarker The last.
 * @param {Element} edges.top The part across the top edge.
 * @param {Element} edges.bottom The part across the bottom edge.
 * @returns {IntersectionObserver} for its owner to disconnect.
 */
export function shadeScrollEdges(
  scroller,
  { topMarker, bottomMarker, top, bottom }
) {
  const observer = new scroller.documentGlobal.IntersectionObserver(
    entries => {
      for (const { target, isIntersecting } of entries) {
        const part = target === topMarker ? top : bottom;
        part.toggleAttribute("sval-over-rows", !isIntersecting);
      }
    },
    { root: scroller }
  );
  observer.observe(topMarker);
  observer.observe(bottomMarker);
  return observer;
}
