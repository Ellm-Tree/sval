/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import {
  shadowSheetsFor,
  sheetsFor,
} from "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs";

/**
 * Loads a Firefox page's Sval sheets as its root element is inserted
 * (`SvalPageStyle`).
 */
export class SvalPageStyleChild extends JSWindowActorChild {
  handleEvent(event) {
    const doc = this.document;
    if (event.type !== "DOMDocElementInserted" || event.target !== doc) {
      return;
    }
    const utils = this.contentWindow.windowUtils;
    for (const sheet of sheetsFor(doc.documentURI)) {
      utils.loadSheetUsingURIString(sheet, utils.AUTHOR_SHEET);
    }
    for (const sheet of shadowSheetsFor(doc.documentURI)) {
      utils.loadSheetUsingURIString(sheet, utils.USER_SHEET);
    }
  }
}
