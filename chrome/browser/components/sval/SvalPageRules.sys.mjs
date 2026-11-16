/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Page rules: the element hiding, procedural actions and scriptlets in Sval's
 * filter lists, applied in each page (protections spec §5, decision 0102).
 *
 * adblock-rust answers for pages from the same engines that block requests
 * (`nsIContentClassifierService.pageRules` and `hiddenClassIdSelectors`, the
 * content-classifier-page-rules patch), so one set of lists and one blocking
 * level serve both. `SvalPageRules`, a JSWindowActor pair, asks for a
 * document's rules as its root element is inserted and applies them before
 * the page's own scripts run.
 *
 * `browser.sval.adblock.pageRules` turns page rules off while leaving request
 * blocking on. The protection button's site exception and the Off level turn
 * off the lists' rules and leave the user's own, My filters, which the
 * `my-filters` engine serves alone (decision 1993).
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  myFilters,
  SvalBlockingLists,
} from "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs";

export const PAGE_RULES_PREF = "browser.sval.adblock.pageRules";
/** The most class and id names, of each kind, one generic lookup takes. */
export const MAX_GENERIC_NAMES = 1000;
const ACTOR = "SvalPageRules";

let registered = false;
/** The scriptlet library, a JSON array of adblock-rust resources. */
let scriptletResources = "[]";
/** The service the library was last handed to. */
let resourcesGivenTo = null;

/**
 * The content classifier service, once its Remote Settings client has
 * attached it to the list loader, with the scriptlet library handed over.
 *
 * @returns {?nsIContentClassifierService}
 */
function service() {
  const svc = SvalBlockingLists.service;
  if (svc && svc !== resourcesGivenTo) {
    // Handed over once per service: a library the engine refuses is not
    // offered again on every page.
    resourcesGivenTo = svc;
    try {
      svc.setScriptletResources(scriptletResources);
    } catch (err) {
      SvalLog.warn(
        `page rules: the scriptlet library was refused: ${SvalLog.errorName(err)}`
      );
    }
  }
  return svc;
}

export const SvalPageRules = {
  /** Registers the actor. Runs once, at startup. */
  init() {
    if (registered) {
      return;
    }
    registered = true;
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalPageRulesParent.sys.mjs",
      },
      child: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalPageRulesChild.sys.mjs",
        events: {
          DOMDocElementInserted: { capture: true },
          DOMWindowCreated: { capture: true },
        },
      },
      // No address patterns: a frame that inherits its origin has an
      // about:, data: or blob: address, and the parent decides from the
      // document's principal.
      allFrames: true,
      remoteTypes: ["web", "webIsolated", "webCOOP+COEP"],
    });
  },

  /**
   * Replaces the scriptlet library: a JSON array of adblock-rust resources,
   * the format of Brave's adblock-resources `resources.json`.
   *
   * @param {string} json
   */
  setScriptletResources(json) {
    scriptletResources = json;
    resourcesGivenTo = null;
    service();
  },

  /**
   * A document's page rules, or null when it gets none: page rules are off,
   * or no engine holds a rule for it. Page rules come only from lists; the
   * engines that block without one (Mozilla's features, the allowed domains)
   * hold none.
   *
   * @param {string} url The document's address.
   * @param {boolean} isPrivate Whether the document is in a private window.
   * @param {boolean} ownOnly Whether only My filters' rules apply.
   * @returns {?{selectors: string[], procedural: string[], script: string,
   *   exceptions: string[], generichide: boolean}} Each procedural filter is
   *   JSON-encoded, as adblock-rust gives it.
   */
  forDocument(url, isPrivate, ownOnly) {
    // Without a rule in My filters there is no `my-filters` engine
    // (`SvalBlocking.apply`), and an empty answer would still send the page
    // looking for generic rules.
    if (
      !Services.prefs.getBoolPref(PAGE_RULES_PREF, true) ||
      (ownOnly && !myFilters().trim())
    ) {
      return null;
    }
    const svc = service();
    if (!svc) {
      return null;
    }
    // The service merges the engines' answers once per address, and every
    // frame there reads that one answer.
    const rules = svc.pageRules(url, isPrivate, ownOnly);
    const { selectors, proceduralActions, script, generichide } = rules;
    if (
      !selectors.length &&
      !proceduralActions.length &&
      !script &&
      generichide
    ) {
      return null;
    }
    return {
      selectors,
      procedural: proceduralActions,
      script,
      exceptions: rules.exceptions,
      generichide,
    };
  },

  /**
   * The generic hiding selectors for class and id names a page uses.
   *
   * @param {string[]} classes
   * @param {string[]} ids
   * @param {string[]} exceptions From the document's page rules.
   * @param {boolean} isPrivate
   * @param {boolean} ownOnly Whether only My filters' rules apply.
   * @returns {string[]}
   */
  genericSelectors(classes, ids, exceptions, isPrivate, ownOnly) {
    const svc = service();
    if (!svc || (!classes.length && !ids.length)) {
      return [];
    }
    return [
      ...new Set(
        svc.hiddenClassIdSelectors(classes, ids, exceptions, isPrivate, ownOnly)
      ),
    ];
  },
};
