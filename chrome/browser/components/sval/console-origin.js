/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* global module, require */

/**
 * Where a console message came from: the page's own scripts, an extension,
 * or Sval itself.
 *
 * A page writes part of what a message says about its source: `//# sourceURL=`
 * renames a script to any URL, and a `data:` URL's body is the page's text.
 * So the label "Extension" rests on the URL naming an extension installed
 * here, whose internal host is random per profile, and "Sval" on the
 * message's `chromeContext`, which the engine sets for system code alone. A
 * page script that names itself after Sval's files or an unknown extension
 * is labelled Page.
 */

const dom = require("resource://devtools/client/shared/vendor/react-dom-factories.js");
const {
  cloneElement,
} = require("resource://devtools/client/shared/vendor/react.mjs");
const {
  MESSAGE_SOURCE,
} = require("resource://devtools/client/webconsole/constants.js");

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  siteOf: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
});

const ORIGIN = {
  PAGE: "page",
  EXTENSION: "extension",
  SVAL: "sval",
};

const PRIVILEGED_SCHEMES = new Set([
  "chrome",
  "resource",
  "moz-src",
  "jar",
  "moz-extension",
]);

// Messages that carry `chromeContext` when system code logged them. Others,
// such as CSS warnings, carry none, so their URL alone cannot tell Sval's
// files from a page's that borrows their names.
const SOURCES_WITH_CONTEXT = new Set([
  MESSAGE_SOURCE.CONSOLE_API,
  MESSAGE_SOURCE.JAVASCRIPT,
]);

const LABELS = {
  [ORIGIN.PAGE]: "Page",
  [ORIGIN.EXTENSION]: "Extension",
  [ORIGIN.SVAL]: "Sval",
};

function schemeOf(url) {
  return URL.parse(url)?.protocol.slice(0, -1) ?? null;
}

/**
 * The URL of the script a message came from. The engine names eval'd code
 * after the script that ran the eval ("<url> line <n> > eval"), and a script
 * a privileged loader ran after the loader and then the script
 * ("<loader> -> <url>"). What follows the first URL can be text the page
 * chose, so the chain is followed past it only when it is privileged.
 *
 * @param {string} url
 *        The frame's source.
 * @returns {string}
 */
function scriptURLOf(url) {
  const chain = url.split(" -> ");
  const first = chain[0].replace(/ line \d+ > .*$/, "");
  if (chain.length > 1 && PRIVILEGED_SCHEMES.has(schemeOf(first))) {
    return chain.at(-1).replace(/ line \d+ > .*$/, "");
  }
  return first;
}

/**
 * @param {string} uuid
 *        The host of the extension's moz-extension: URLs.
 * @returns {{kind: string, key: string, name: string|null}}
 */
function extensionOrigin(uuid) {
  return {
    kind: ORIGIN.EXTENSION,
    key: uuid,
    name: WebExtensionPolicy.getByHostname(uuid)?.name ?? null,
  };
}

/**
 * @param {object} message
 *        A console message as the console stores it.
 * @returns {{kind: string, key: string, name: string|null}|null}
 *          `key` tells one page site or one extension from another; `name`
 *          is what the user is shown after the kind. Null when the message
 *          names no script, such as console input.
 */
function originOf(message) {
  const source = message.frame?.source;
  if (!source) {
    return null;
  }
  const parsed = URL.parse(scriptURLOf(source));
  const scheme = parsed?.protocol.slice(0, -1);
  // System code reports errors it raises on an extension's behalf, such as an
  // unchecked `lastError` (`withLastError` in ExtensionCommon.sys.mjs), with
  // the extension's frame, and `Cu.reportError` marks a report made outside
  // any window as from a chrome context. So an installed extension's frame
  // names the extension whether or not the message has `chromeContext`.
  if (
    scheme === "moz-extension" &&
    WebExtensionPolicy.getByHostname(parsed.hostname)
  ) {
    return extensionOrigin(parsed.hostname);
  }
  if (message.chromeContext) {
    return { kind: ORIGIN.SVAL, key: ORIGIN.SVAL, name: null };
  }
  if (!parsed) {
    return null;
  }
  if (scheme === "http" || scheme === "https") {
    // siteOf has no site for a host it cannot classify, such as one with an empty
    // label; a page names its own script URLs, so the console labels such a
    // script by its raw host.
    const site = lazy.siteOf(parsed.href) ?? parsed.host;
    return { kind: ORIGIN.PAGE, key: site, name: site };
  }
  if (
    PRIVILEGED_SCHEMES.has(scheme) &&
    !SOURCES_WITH_CONTEXT.has(message.source)
  ) {
    return null;
  }
  // Any other script, a `data:` or `blob:` URL's included, is one a page
  // loaded or made, and its URL names no site.
  return { kind: ORIGIN.PAGE, key: scheme, name: null };
}

/**
 * The label shown at the start of a message. The separator is hidden from
 * screen readers, which read "Extension iCloud Passwords".
 *
 * @param {object|null} origin
 *        The origin `prepareMessage` gave the message's frame.
 */
function OriginBadge(origin) {
  if (!origin) {
    return null;
  }
  const kind = LABELS[origin.kind];
  return dom.span(
    { className: "sval-console-origin", "data-origin": origin.kind },
    origin.name
      ? [
          kind,
          dom.span({ key: "separator", "aria-hidden": true }, " · "),
          origin.name,
        ]
      : kind
  );
}

/**
 * A message's source link, with the extension's name before the file for a
 * script an extension ran, as in "iCloud Passwords · background.js".
 *
 * @param {object|null} location
 *        The Frame element Message renders as the message's location.
 * @param {object|null} origin
 *        The origin `prepareMessage` gave the message's frame.
 */
function withOriginSource(location, origin) {
  if (!location || origin?.kind !== ORIGIN.EXTENSION || !origin.name) {
    return location;
  }
  return dom.span(
    { className: location.props.className },
    dom.span({ className: "sval-console-origin-source" }, `${origin.name} · `),
    cloneElement(location, { className: undefined })
  );
}

/**
 * The filter that hides a message, by the origin `prepareMessage` gave its
 * frame, or null when the filters show it. A message with no origin is never
 * hidden by them.
 *
 * @param {object} message
 * @param {object} filters
 *        The redux "filters" state.
 * @returns {string|null}
 */
function hiddenByOriginFilter(message, filters) {
  const origin = message.frame?.svalOrigin;
  if (!origin) {
    return null;
  }
  switch (origin.kind) {
    case ORIGIN.PAGE:
      return filters.page ? null : "page";
    case ORIGIN.SVAL:
      return filters.sval ? null : "sval";
    case ORIGIN.EXTENSION:
      return filters.extensions &&
        (!filters.extension || filters.extension === origin.key)
        ? null
        : "extensions";
  }
  return null;
}

module.exports = {
  ORIGIN,
  originOf,
  extensionOrigin,
  OriginBadge,
  withOriginSource,
  hiddenByOriginFilter,
};
