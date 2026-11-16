/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import {
  scopeOf,
  siteOf,
} from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import { SvalBlocking } from "moz-src:///browser/components/sval/SvalBlocking.sys.mjs";
import {
  SvalElementPicker,
  availabilityOf,
} from "moz-src:///browser/components/sval/SvalElementPicker.sys.mjs";
import {
  appendLines,
  hideLine,
  linesForScope,
  networkLine,
} from "moz-src:///browser/components/sval/SvalElementRules.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { usableSelector } from "moz-src:///browser/components/sval/SvalPageRulesChild.sys.mjs";

// The longest selector and address a save takes.
const MAX_SELECTOR = 1024;
const MAX_URL = 2048;

let probeDocument = null;

/**
 * Whether `selector` is plain CSS that My filters reads back as the one
 * hiding rule it is written as. A selector the page's CSS parser refuses
 * covers every other filter syntax: a scriptlet (`+js(`), an HTML filter
 * (`^`) and the procedural operators (`:has-text(`, `:style(`, `:remove(`,
 * `:xpath(`). It is parsed against an element of a document made here, never
 * the page's.
 *
 * @param {string} scope
 * @param {string} selector
 * @returns {boolean}
 */
function isPlainRule(scope, selector) {
  probeDocument ??= new DOMParser().parseFromString(
    "<!doctype html><html></html>",
    "text/html"
  );
  if (
    !selector.trim() ||
    selector.startsWith("+js(") ||
    selector.startsWith("^") ||
    !usableSelector(probeDocument, selector)
  ) {
    return false;
  }
  const read = linesForScope(hideLine(scope, selector), scope);
  return (
    read.length == 1 && read[0].kind == "hide" && read[0].shown == selector
  );
}

/**
 * @param {string} url
 * @param {string} site
 * @returns {boolean} whether `url` is a web address on another site.
 */
function isOtherSite(url, site) {
  try {
    const other = siteOf(url);
    return !!other && other != site;
  } catch {
    return false;
  }
}

/**
 * Stores the user's rules.
 *
 * @param {string} text
 * @returns {?{ok: false, error: string}} null when stored.
 */
function write(text) {
  try {
    SvalBlocking.setMyFilters(text);
  } catch (err) {
    if (err.message == "too-large") {
      return { ok: false, error: "too-large" };
    }
    SvalLog.warn(
      `element picker: writing My filters failed: ${SvalLog.errorName(err)}`
    );
    return { ok: false, error: "invalid" };
  }
  return null;
}

/**
 * Writes the rules the picker's child asks for. The child names the scope,
 * the page's host or its site (decision 1980), and the parent takes it only
 * where it is one of the two its own record of the document gives
 * (`scopeOf`). Every write checks availability again, because the window or
 * the site's protections can change while the picker is open.
 */
export class SvalElementPickerParent extends JSWindowActorParent {
  /** The lines this actor saved and has not undone. */
  #saved = [];

  /** How many snips on this actor's document are not undone. */
  snipped = 0;

  receiveMessage(message) {
    switch (message.name) {
      case "SvalElementPicker:Save":
        return this.#save(message.data);
      case "SvalElementPicker:Undo":
        return this.#undo(message.data);
      case "SvalElementPicker:Unsnipped":
        this.snipped = Math.max(0, this.snipped - 1);
        SvalElementPicker.snipsChanged(this.#browser);
        break;
      case "SvalElementPicker:Ended":
        if (message.data?.mode == "snip" && message.data.removed) {
          this.snipped++;
          SvalElementPicker.snipsChanged(this.#browser);
        }
        SvalElementPicker.ended(
          this.#browser,
          this,
          message.data?.removed ? "done" : "left"
        );
        break;
    }
    return null;
  }

  didDestroy() {
    SvalElementPicker.ended(this.#browser, this);
  }

  get #browser() {
    return this.browsingContext?.top?.embedderElement ?? null;
  }

  /**
   * Whether this actor's document is the tab's current one and the tab is in
   * the picker with this actor running it. The content process asks for
   * nothing else to be written.
   */
  #running() {
    return (
      this.manager.isCurrentGlobal &&
      SvalElementPicker.isRunning(this.#browser, this, "remove")
    );
  }

  /**
   * @param {object} [message]
   * @param {string} [message.selector]
   * @param {?string} [message.url] The address of the element's resource.
   * @param {string} [message.scope] The page's host or its site, as
   *   `scopeOf` names them; the site where none is given.
   */
  #save({ selector, url, scope } = {}) {
    if (
      typeof selector != "string" ||
      selector.length > MAX_SELECTOR ||
      (url != null && (typeof url != "string" || url.length > MAX_URL)) ||
      (scope != null && typeof scope != "string")
    ) {
      return { ok: false, error: "invalid" };
    }
    if (!this.#running() || availabilityOf(this.browsingContext) != "ok") {
      return { ok: false, error: "unavailable" };
    }
    let site;
    try {
      site = siteOf(this.manager.documentURI.spec);
    } catch {
      return { ok: false, error: "unavailable" };
    }
    const scopes = scopeOf(this.manager.documentURI.spec);
    scope ??= site;
    if (
      !site ||
      !scopes ||
      (scope != scopes.site && scope != scopes.host) ||
      !isPlainRule(scope, selector)
    ) {
      return { ok: false, error: "invalid" };
    }
    // The classifier never blocks a page's request to its own site
    // (`ContentClassifierEngine`), so a rule for one would do nothing.
    if (url != null && !isOtherSite(url, site)) {
      return { ok: false, error: "invalid" };
    }
    const lines = [hideLine(scope, selector)];
    // A URL that cannot make a narrow rule saves the hiding line alone.
    const network = url == null ? null : networkLine(scope, url);
    if (network) {
      lines.push(network);
    }
    const failed = write(appendLines(SvalBlocking.myFilters, lines));
    if (failed) {
      return failed;
    }
    this.#saved.push(...lines);
    // One save ends the session. The toast's Undo outlives it.
    SvalElementPicker.ended(this.#browser, this, "done");
    return { ok: true, lines };
  }

  /**
   * Takes lines this actor saved out of My filters, the last occurrence of
   * each as it reads at this moment. A line it did not save stays, so the
   * content process cannot delete the user's other rules.
   *
   * @param {object} [message]
   * @param {string[]} [message.lines]
   */
  #undo({ lines } = {}) {
    if (!Array.isArray(lines)) {
      return { ok: false, error: "invalid" };
    }
    if (!this.manager.isCurrentGlobal) {
      return { ok: false, error: "unavailable" };
    }
    const before = SvalBlocking.myFilters;
    const text = before.split("\n");
    const saved = [...this.#saved];
    for (const line of lines) {
      const at = saved.indexOf(line);
      if (at < 0) {
        continue;
      }
      saved.splice(at, 1);
      const found = text.findLastIndex(l => l.replace(/\r$/, "") == line);
      if (found >= 0) {
        text.splice(found, 1);
      }
    }
    const after = text.join("\n");
    if (after != before) {
      const failed = write(after);
      if (failed) {
        return failed;
      }
    }
    this.#saved = saved;
    return { ok: true };
  }
}
