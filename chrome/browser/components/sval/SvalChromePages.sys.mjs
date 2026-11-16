/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Hands Sval's code the browser's own pages as each one's document is
 * inserted, through one `document-element-inserted` observer for the
 * process. That topic fires for every document the parent process makes, so
 * one observer checks the principal once, and each caller says which address
 * it wants.
 */

import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

/** `{ matches, handle }` for each page asked for, in the order asked. */
const handlers = [];

let observing = false;

const observer = {
  observe(doc) {
    // Only a document with the system principal: a web page at any address
    // is never handed to Sval's code.
    if (!doc?.nodePrincipal?.isSystemPrincipal || !doc.defaultView) {
      return;
    }
    const url = doc.documentURI ?? "";
    for (const { matches, handle } of handlers) {
      if (!matches(url)) {
        continue;
      }
      try {
        handle(doc);
      } catch (err) {
        SvalLog.warn(
          `a browser page did not take Sval's part: ${describeError(err)}`
        );
      }
    }
  },
};

export const SvalChromePages = {
  /**
   * Calls `handle` with each browser page whose address `matches` accepts,
   * as its document element is inserted.
   *
   * @param {(url: string) => boolean} matches
   * @param {(doc: Document) => void} handle
   */
  on(matches, handle) {
    handlers.push({ matches, handle });
    if (!observing) {
      observing = true;
      Services.obs.addObserver(observer, "document-element-inserted");
    }
  },
};
