/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Applies a document's page rules (protections spec §5.2).
 *
 * It asks `SvalPageRulesParent` for them as the document's root element is
 * inserted, and holds the parser with `document.blockParsing` until they are
 * in, as WebExtension `document_start` content scripts are
 * (`ExtensionContent.sys.mjs`), so they land before the page's first script:
 *
 * - hiding selectors go in as a user-level stylesheet through
 *   `windowUtils.loadSheetUsingURIString`, which page CSP does not govern and
 *   whose `!important` declarations outrank the page's own;
 * - scriptlets run in the page's world as a `ChromeUtils.compileScript`
 *   script executed in the page's global, the way WebExtension `MAIN` world
 *   scripts run, which page CSP does not block either;
 * - procedural actions run here, in the actor's privileged scope, reading the
 *   page through Xrays, so page script can neither see nor tamper with them.
 *
 * Generic rules follow the page: the class and id names it uses, and any it
 * adds later, go to the parent, and the selectors that come back join the
 * stylesheet.
 */

/** How long new class and id names, and DOM changes, gather before a pass. */
const BATCH_MS = 100;
/**
 * The most new class and id names, of each kind, one lookup sends, and the
 * most a document sends in all, so a page cannot keep the parent's engines
 * busy. SvalPageRulesParent holds lookups to the same batch size.
 */
const MAX_BATCH = 1000;
const MAX_NAMES_PER_DOCUMENT = 20000;
/**
 * A document stops following its names once this many misses in a row, a
 * DOM change that brings no new name or a lookup that finds no new rule, and
 * no new rule for `SURVEY_GRACE_MS`. A page that keeps changing its DOM, such
 * as a live dashboard, would otherwise pay for the walk on every change for
 * as long as it stays open. uBlock Origin's surveyor ends on the same two
 * limits (`surveyResultMissCount`, `canShutdownAfter` in its
 * `contentscript.js`).
 */
const SURVEY_MISSES = 256;
export const SURVEY_GRACE_MS = 5 * 60 * 1000;
/** Notified in the content process, with the window, when a survey ends. */
export const SURVEY_ENDED_TOPIC = "sval-page-rules-survey-ended";
/** The survey reads time through this, so a test can move it on. */
export const surveyClock = { now: () => Date.now() };

/**
 * Whether a `:style()` declaration is safe to apply. adblock-rust's own
 * check (`is_valid_css_style`) refuses only escapes, `url(` and comments, and
 * a declaration applied from this privileged scope must not fetch anything or
 * reach outside its element: no URL-taking function, no at-rule, escape,
 * comment, legacy expression or brace.
 *
 * @param {string} style
 * @returns {boolean}
 */
export function isSafeStyle(style) {
  return !/url\(|image\(|image-set\(|cross-fade\(|element\(|src\(|@|\\|\/\*|expression|[{}]/i.test(
    style
  );
}

/**
 * Notified in the content process, with the window, each time a theme has
 * measured a page and told the parent what it found.
 */
export const THEME_MEASURED_TOPIC = "sval-site-style-measured";

/** The relative luminance above which a background reads as light. */
const LIGHT_LUMINANCE = 0.4;

/**
 * @param {string} color A computed color, `rgb()` or `rgba()`.
 * @returns {?{luminance: number, alpha: number}} Its WCAG relative
 *   luminance and alpha, or null for a form this does not read.
 */
function readColor(color) {
  const m =
    /^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)$/.exec(
      color
    );
  if (!m) {
    return null;
  }
  const [r, g, b] = m.slice(1, 4).map(v => {
    const c = Number(v) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return {
    luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b,
    alpha: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/**
 * Whether a page draws a light background: its root's, or its body's, which
 * a root with none gives the canvas. A page with neither shows the canvas's
 * default, which follows the page's color scheme as its text color does, so
 * dark text there means a light page.
 *
 * @param {Window} window
 * @returns {boolean}
 */
export function drawsLight(window) {
  const { document } = window;
  for (const el of [document.documentElement, document.body]) {
    const color = el && readColor(window.getComputedStyle(el).backgroundColor);
    if (color && color.alpha >= 0.5) {
      return color.luminance > LIGHT_LUMINANCE;
    }
  }
  const text = readColor(
    window.getComputedStyle(document.documentElement).color
  );
  return !text || text.luminance < LIGHT_LUMINANCE;
}

const selectorProbes = new WeakMap();

/**
 * Whether a selector may go into a hiding sheet: the document's selector
 * parser accepts it and it holds nothing that could end the rule or open a
 * comment. List text, a user's list included, must never add a rule of its
 * own, such as one loading a `url()` that reports what the page holds.
 *
 * @param {Document} document Parses the selector.
 * @param {string} selector
 * @returns {boolean}
 */
export function usableSelector(document, selector) {
  if (/[{}\n\r]|\/\*|\*\//.test(selector)) {
    return false;
  }
  try {
    // `Element.matches` parses a selector as `querySelector` does, against
    // one detached element rather than every element of the page. A page's
    // rules run to thousands of selectors, so each document keeps one probe.
    let probe = selectorProbes.get(document);
    if (!probe) {
      probe = document.createElement("div");
      selectorProbes.set(document, probe);
    }
    probe.matches(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * A hiding rule per selector, so one selector this engine cannot parse loses
 * only its own rule.
 *
 * @param {Document} document The chrome view of the page, for parsing.
 * @param {string[]} selectors
 * @returns {string}
 */
export function hidingSheet(document, selectors) {
  return selectors
    .filter(s => usableSelector(document, s))
    .map(s => `${s}{display:none !important;}`)
    .join("\n");
}

/**
 * A procedural argument as a matcher: `/re/flags` with a non-empty pattern
 * is a regular expression, anything else a substring. One matcher tests
 * every element, so the `g` and `y` flags are dropped: with either,
 * `RegExp.prototype.test` starts from the `lastIndex` the previous element
 * left.
 *
 * @param {string} arg
 * @returns {(text: string) => boolean}
 */
export function textMatcher(arg) {
  const m = /^\/(.+)\/([dgimsuy]*)$/s.exec(arg);
  if (m) {
    const re = new RegExp(m[1], m[2].replace(/[gy]/g, ""));
    return text => re.test(text);
  }
  return text => text.includes(arg);
}

/**
 * `name: value` with either part possibly `/re/`, as `matches-css` and
 * `matches-attr` take it.
 *
 * @param {string} arg
 * @param {string} separator
 * @returns {[string, string]}
 */
function splitPair(arg, separator) {
  const at = arg.indexOf(separator);
  const unquote = s => s.trim().replace(/^"(.*)"$/s, "$1");
  return at < 0
    ? [unquote(arg), ""]
    : [unquote(arg.slice(0, at)), unquote(arg.slice(at + separator.length))];
}

/**
 * Runs one procedural operator over a set of elements.
 *
 * @param {Window} window
 * @param {Element[]|null} elements The current set; null before the first.
 * @param {{type: string, arg: string}} op
 * @returns {Element[]}
 */
function applyOperator(window, elements, op) {
  const { document } = window;
  const { type, arg } = op;
  if (type == "css-selector") {
    if (!elements) {
      return [...document.querySelectorAll(arg)];
    }
    const found = new Set();
    const sibling = /^\s*([+~])\s*(.*)$/s.exec(arg);
    for (const el of elements) {
      if (!sibling) {
        el.querySelectorAll(`:scope ${arg}`).forEach(m => found.add(m));
        continue;
      }
      const [, combinator, rest] = sibling;
      for (let s = el.nextElementSibling; s; s = s.nextElementSibling) {
        if (s.matches(rest)) {
          found.add(s);
        }
        if (combinator == "+") {
          break;
        }
      }
    }
    return [...found];
  }
  const all = elements ?? [...document.querySelectorAll("*")];
  switch (type) {
    case "has-text": {
      const test = textMatcher(arg);
      return all.filter(el => test(el.textContent));
    }
    case "min-text-length": {
      const min = parseInt(arg, 10);
      return all.filter(el => el.textContent.length >= min);
    }
    case "matches-attr": {
      const [name, value] = splitPair(arg, "=");
      const nameTest = textMatcher(name);
      const valueTest = value ? textMatcher(value) : () => true;
      return all.filter(el =>
        [...el.attributes].some(a => nameTest(a.name) && valueTest(a.value))
      );
    }
    case "matches-css":
    case "matches-css-before":
    case "matches-css-after": {
      const pseudo =
        type == "matches-css" ? null : `::${type.slice("matches-css-".length)}`;
      const [prop, value] = splitPair(arg, ":");
      const test = textMatcher(value);
      return all.filter(el =>
        test(window.getComputedStyle(el, pseudo).getPropertyValue(prop))
      );
    }
    case "matches-path": {
      const { pathname, search } = window.location;
      return textMatcher(arg)(pathname + search) ? all : [];
    }
    case "upward": {
      const steps = Number(arg);
      return all.flatMap(el => {
        let up = el;
        if (Number.isInteger(steps) && steps > 0) {
          for (let i = 0; i < steps && up; i++) {
            up = up.parentElement;
          }
        } else {
          up = el.parentElement?.closest(arg);
        }
        return up ? [up] : [];
      });
    }
    case "xpath": {
      const found = new Set();
      for (const context of elements ?? [document]) {
        const result = document.evaluate(
          arg,
          context,
          null,
          window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
        for (let i = 0; i < result.snapshotLength; i++) {
          const node = result.snapshotItem(i);
          if (node.nodeType == node.ELEMENT_NODE) {
            found.add(node);
          }
        }
      }
      return [...found];
    }
  }
  // An operator this code does not know matches nothing, rather than letting
  // the filter act on everything before it.
  return [];
}

/**
 * Applies a procedural filter's action to what its operators selected.
 *
 * @param {Element[]} elements
 * @param {?{type: string, arg?: string}} action
 */
function applyAction(elements, action) {
  for (const el of elements) {
    switch (action?.type) {
      case undefined:
        el.style.setProperty("display", "none", "important");
        break;
      case "remove":
        el.remove();
        break;
      case "style":
        if (isSafeStyle(action.arg)) {
          el.style.cssText += `;${action.arg}`;
        }
        break;
      case "remove-attr":
        el.removeAttribute(action.arg);
        break;
      case "remove-class":
        el.classList.remove(action.arg);
        break;
    }
  }
}

/** The most compiled scriptlet bundles a content process keeps. */
const MAX_COMPILED_SCRIPTS = 8;

/**
 * Scriptlet bundles this content process has compiled, by their code, oldest
 * first. A site's pages get the same bundle, and a compiled script runs in
 * whatever global it is given (`PrecompiledScript.executeInGlobal`), as
 * `ExtensionContent.sys.mjs`'s `ScriptCache` reuses content scripts across
 * pages, so every document still runs it in its own.
 */
const compiledScripts = new Map();

/**
 * @param {string} code
 * @returns {Promise<PrecompiledScript>}
 */
function compiledScript(code) {
  let compiled = compiledScripts.get(code);
  if (compiled) {
    compiledScripts.delete(code);
  } else {
    compiled = ChromeUtils.compileScript(
      `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`,
      { filename: "<anonymous code>" }
    );
    compiled.catch(() => {
      if (compiledScripts.get(code) === compiled) {
        compiledScripts.delete(code);
      }
    });
  }
  compiledScripts.set(code, compiled);
  for (const oldest of compiledScripts.keys()) {
    if (compiledScripts.size <= MAX_COMPILED_SCRIPTS) {
      break;
    }
    compiledScripts.delete(oldest);
  }
  return compiled;
}

/** One document's page rules, applied as described above. */
export class SvalPageRulesChild extends JSWindowActorChild {
  #rules = null;
  /** The site style's font sheet a document shows: `{document, uri}`. */
  #fontSheet = null;
  /** Counts a theme's measurements, so only the last style's applies. */
  #darkRun = 0;
  /**
   * The documents whose rules have been asked for. `document.open()` keeps
   * its document, and with it the rules already applied, while its parser
   * inserts a fresh root element.
   */
  #started = new WeakSet();
  /**
   * The scriptlets' run in this actor's global, which a reused initial
   * about:blank window shares with the page that follows it. They run there
   * once, and that page waits for the run.
   */
  #scriptRun = null;
  /** The compiled scriptlet bundle run in this actor's global. */
  #scriptlets = null;
  #seenClasses = new Set();
  #seenIds = new Set();
  #pendingClasses = new Set();
  #pendingIds = new Set();
  #timer = null;
  #observer = null;
  /** Per procedural filter, the elements its action has been applied to. */
  #acted = new WeakMap();
  /**
   * Every generic selector found so far. Each batch's new ones go in a sheet
   * of their own, which stays, so a batch parses only its own rules and
   * restyles once; `MAX_NAMES_PER_DOCUMENT` bounds the sheets a document
   * gets. Each selector is checked once, when it arrives.
   */
  #genericSelectors = new Set();
  #namesSent = 0;
  /** Whether the document's names are still followed for generic rules. */
  #surveying = false;
  #surveyMisses = 0;
  #surveyEndsAfter = 0;

  handleEvent(event) {
    const document = this.document;
    if (event.target != document || this.#started.has(document)) {
      return;
    }
    if (event.type == "DOMWindowCreated") {
      // The initial about:blank document is made without a parser, so no
      // DOMDocElementInserted announces it, and a page's script can write
      // into it before anything else does. Its rules go in at once.
      if (document.isInitialDocument) {
        this.#runParentsScriptlets(document);
        this.#begin(document);
      }
      return;
    }
    if (event.type != "DOMDocElementInserted") {
      return;
    }
    if (document.readyState == "complete") {
      return;
    }
    document.blockParsing(this.#begin(document), {
      blockScriptCreated: false,
    });
  }

  /**
   * Asks for `document`'s rules and applies them. The actor outlives a
   * document when an initial about:blank window is reused for a same-origin
   * page, so rules apply only to the document they were asked for.
   *
   * @param {Document} document
   * @returns {Promise<void>}
   */
  #begin(document) {
    this.#started.add(document);
    return this.sendQuery("SvalPageRules:Document").then(
      answer => {
        if (this.#current(document)) {
          this.#setStyle(answer?.style ?? null);
        }
        return this.#start(answer?.rules ?? null, document);
      },
      () => {}
    );
  }

  receiveMessage(message) {
    if (message.name == "SvalPageRules:Style") {
      this.#setStyle(message.data);
    }
  }

  /**
   * Puts the document's site style in place of the one it shows. Gecko
   * paints the colors from the tab's BrowsingContext, which the parent sets.
   * The font is a user sheet, as hiding sheets are, so the page's own
   * script can neither read it nor take it out.
   *
   * A theme asks the site for its light or dark theme, and the parent turns
   * a page still in the other scheme over. Once the page prefers the theme
   * it is measured, and the parent told whether it draws dark on its own.
   * The page's computed colors are its own: the turning over happens as
   * they are painted.
   *
   * @param {?{sheet: string, theme: ?string}} style Null for none.
   */
  #setStyle(style) {
    const window = this.contentWindow;
    if (!window) {
      return;
    }
    const { document } = window;
    this.#showFontSheet(document, style?.sheet ?? "");
    const run = ++this.#darkRun;
    const theme = style?.theme;
    if (!theme) {
      return;
    }
    const measure = () => {
      if (run == this.#darkRun && this.#current(document)) {
        this.sendAsyncMessage("SvalPageRules:DrawsDark", !drawsLight(window));
        Services.obs.notifyObservers(window, THEME_MEASURED_TOPIC);
      }
    };
    // The tab's scheme is set in the parent, and reaches this process apart
    // from this actor's messages, so the page is measured once it prefers
    // the theme. Measured before then, it would show the scheme it was
    // leaving.
    const prefers = window.matchMedia(`(prefers-color-scheme: ${theme})`);
    const whenPrefers = prefers.matches
      ? Promise.resolve()
      : new Promise(resolve =>
          prefers.addEventListener("change", resolve, { once: true })
        );
    whenPrefers.then(() => {
      if (run != this.#darkRun || !this.#current(document)) {
        return;
      }
      // A page's own sheets in its head are in by DOMContentLoaded, and a
      // script can set its colors up to its load.
      if (document.readyState == "loading") {
        window.addEventListener("DOMContentLoaded", measure, { once: true });
      } else {
        measure();
      }
      if (document.readyState != "complete") {
        window.addEventListener("load", measure, { once: true });
      }
    });
  }

  /**
   * Loads `sheet` as the document's font sheet, in place of the one it had.
   *
   * @param {Document} document
   * @param {string} sheet "" for none.
   */
  #showFontSheet(document, sheet) {
    const uri = sheet
      ? `data:text/css;charset=utf-8,${encodeURIComponent(sheet)}`
      : null;
    // The actor outlives a reused initial about:blank document, whose
    // sheets went with it.
    const held = this.#fontSheet;
    const shown = held?.document == document ? held.uri : null;
    if (uri == shown) {
      return;
    }
    const { windowUtils } = document.defaultView;
    this.#fontSheet = null;
    try {
      if (shown) {
        windowUtils.removeSheetUsingURIString(shown, windowUtils.USER_SHEET);
      }
      if (uri) {
        windowUtils.loadSheetUsingURIString(uri, windowUtils.USER_SHEET);
        this.#fontSheet = { document, uri };
      }
    } catch {
      // A document going away mid-load takes its sheets with it.
    }
  }

  /**
   * Runs, in a frame's initial about:blank window, the scriptlets its parent
   * document already compiled and ran, when both have the same principal. A
   * popup has no parent, so its opener's document stands in.
   * The page that adds the frame or opens the popup can read the window's
   * globals, a pristine `fetch` among them, before its `appendChild` or
   * `window.open` returns, long before `#begin`'s answer arrives. DOMWindowCreated is dispatched by a script
   * runner inside that call (`nsGlobalWindowOuter::SetNewDocument`), as is
   * the `initial-document-element-inserted` from which WebExtension content
   * scripts that match about:blank run there
   * (`ExtensionPolicyService::CheckDocument`), from a compiled-script cache
   * like `compiledScripts`. The frame's own rules still arrive through
   * `#begin`, and `#scriptRun` keeps the scriptlets from running twice.
   *
   * @param {Document} document
   */
  #runParentsScriptlets(document) {
    const context = this.browsingContext;
    const source =
      context.parentWindowContext ?? context.opener?.currentWindowContext;
    const parent = source?.windowGlobalChild?.getExistingActor("SvalPageRules");
    const scriptlets = parent?.#scriptlets;
    if (
      !scriptlets ||
      !document.nodePrincipal.equals(parent.document.nodePrincipal)
    ) {
      return;
    }
    this.#scriptRun = Promise.resolve();
    this.#execute(this.contentWindow, scriptlets);
  }

  didDestroy() {
    this.#stop();
  }

  /**
   * Whether `document` is still the one this actor's window shows.
   *
   * @param {Document} document
   * @returns {boolean}
   */
  #current(document) {
    // `contentWindow` throws once the actor is destroyed; `manager` reads
    // null then.
    return !!this.manager && this.contentWindow?.document == document;
  }

  async #start(rules, document) {
    if (!this.#current(document)) {
      return;
    }
    const window = this.contentWindow;
    this.#stop();
    this.#seenClasses = new Set();
    this.#seenIds = new Set();
    this.#pendingClasses = new Set();
    this.#pendingIds = new Set();
    this.#acted = new WeakMap();
    this.#genericSelectors = new Set();
    this.#namesSent = 0;
    this.#surveying = false;
    if (!rules) {
      return;
    }
    // Each procedural filter arrives JSON-encoded, as adblock-rust gives it;
    // this document's passes read it parsed.
    this.#rules = {
      ...rules,
      procedural: rules.procedural.flatMap(json => {
        try {
          return [JSON.parse(json)];
        } catch {
          return [];
        }
      }),
    };
    if (rules.selectors.length) {
      this.#loadSheet(hidingSheet(this.document, rules.selectors));
    }
    if (rules.script) {
      this.#scriptRun ??= this.#runScript(window, rules.script);
      await this.#scriptRun;
      if (!this.#current(document)) {
        return;
      }
    }
    if (!this.#rules.procedural.length && rules.generichide) {
      return;
    }
    if (document.readyState == "loading") {
      window.addEventListener("DOMContentLoaded", () => this.#watch(), {
        once: true,
      });
    } else {
      this.#watch();
    }
  }

  /**
   * Loads a hiding sheet built by {@link hidingSheet}.
   *
   * @param {string} sheet
   */
  #loadSheet(sheet) {
    const window = this.contentWindow;
    if (!window || !sheet) {
      return;
    }
    const { windowUtils } = window;
    try {
      const uri = `data:text/css;charset=utf-8,${encodeURIComponent(sheet)}`;
      windowUtils.loadSheetUsingURIString(uri, windowUtils.USER_SHEET);
    } catch {
      // A document going away mid-load takes its sheets with it.
    }
  }

  async #runScript(window, script) {
    // scriptletGlobals is what uBlock Origin's scriptlets expect to share,
    // as Brave's injection provides it.
    const code = `(function() { const scriptletGlobals = {}; ${script}\n})();`;
    let compiled;
    try {
      compiled = await compiledScript(code);
    } catch {
      return;
    }
    this.#execute(window, compiled);
  }

  /**
   * @param {Window} window
   * @param {PrecompiledScript} compiled
   */
  #execute(window, compiled) {
    if (window.closed) {
      return;
    }
    this.#scriptlets = compiled;
    try {
      compiled.executeInGlobal(window);
    } catch {
      // Each scriptlet catches its own errors; this is a document unloading.
    }
  }

  /** Starts generic and procedural passes, and repeats them as the DOM changes. */
  #watch() {
    const window = this.contentWindow;
    if (!window || !this.#rules) {
      return;
    }
    const { document } = window;
    this.#surveying = !this.#rules.generichide;
    this.#surveyMisses = 0;
    this.#surveyEndsAfter = surveyClock.now() + SURVEY_GRACE_MS;
    if (this.#surveying) {
      for (const el of document.querySelectorAll("[class],[id]")) {
        this.#note(el);
      }
    }
    this.#pass();
    this.#observer = new window.MutationObserver(records => {
      const surveying = this.#surveying;
      const pending = this.#pendingClasses.size + this.#pendingIds.size;
      for (const record of surveying ? records : []) {
        if (record.type == "attributes") {
          this.#note(record.target);
        }
        for (const node of record.addedNodes) {
          if (node.nodeType != node.ELEMENT_NODE) {
            continue;
          }
          this.#note(node);
          for (const el of node.querySelectorAll("[class],[id]")) {
            this.#note(el);
          }
        }
      }
      if (
        surveying &&
        this.#pendingClasses.size + this.#pendingIds.size == pending
      ) {
        this.#surveyMissed();
      }
      this.#schedule();
    });
    this.#observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "id"],
    });
  }

  #note(el) {
    if (
      !this.#surveying ||
      this.#namesSent + this.#pendingClasses.size + this.#pendingIds.size >=
        MAX_NAMES_PER_DOCUMENT
    ) {
      return;
    }
    // The attribute read once and split on ASCII whitespace, as
    // `DOMTokenList` splits it: walking `classList` through Xrays costs a
    // wrapper call per name.
    for (const name of el.getAttribute?.("class")?.split(/[\t\n\f\r ]+/) ??
      []) {
      if (name && !this.#seenClasses.has(name)) {
        this.#seenClasses.add(name);
        this.#pendingClasses.add(name);
      }
    }
    if (el.id && !this.#seenIds.has(el.id)) {
      this.#seenIds.add(el.id);
      this.#pendingIds.add(el.id);
    }
  }

  #schedule() {
    const window = this.contentWindow;
    // A window torn down while its observer still fires throws on
    // `setTimeout`.
    if (this.#timer || !window || window.closed) {
      return;
    }
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      this.#pass();
    }, BATCH_MS);
  }

  async #pass() {
    const window = this.contentWindow;
    if (!window || !this.#rules) {
      return;
    }
    for (const filter of this.#rules.procedural) {
      try {
        let elements = null;
        for (const op of filter.selector) {
          elements = applyOperator(window, elements, op);
          if (!elements.length) {
            break;
          }
        }
        let acted = this.#acted.get(filter);
        if (!acted) {
          acted = new WeakSet();
          this.#acted.set(filter, acted);
        }
        const fresh = (elements ?? []).filter(el => !acted.has(el));
        fresh.forEach(el => acted.add(el));
        applyAction(fresh, filter.action);
      } catch {
        // A filter this engine cannot evaluate, such as an invalid selector,
        // is skipped; the others still apply.
      }
    }
    if (!this.#pendingClasses.size && !this.#pendingIds.size) {
      return;
    }
    const take = pending => {
      const batch = [...pending].slice(0, MAX_BATCH);
      batch.forEach(name => pending.delete(name));
      return batch;
    };
    const classes = take(this.#pendingClasses);
    const ids = take(this.#pendingIds);
    if (this.#pendingClasses.size || this.#pendingIds.size) {
      this.#schedule();
    }
    this.#namesSent += classes.length + ids.length;
    try {
      const selectors = await this.sendQuery("SvalPageRules:Generic", {
        classes,
        ids,
      });
      const fresh = selectors.filter(s => !this.#genericSelectors.has(s));
      fresh.forEach(s => this.#genericSelectors.add(s));
      this.#loadSheet(hidingSheet(this.document, fresh));
      if (fresh.length) {
        this.#surveyMisses = 0;
        this.#surveyEndsAfter = surveyClock.now() + SURVEY_GRACE_MS;
      } else {
        this.#surveyMissed();
      }
    } catch {
      // The actor was destroyed with its document.
    }
  }

  /**
   * Counts a miss, and ends the survey once
   * `SURVEY_MISSES` and `SURVEY_GRACE_MS` are both reached. Procedural rules
   * keep the observer, since their targets can appear at any time.
   */
  #surveyMissed() {
    if (!this.#rules || !this.#surveying) {
      return;
    }
    this.#surveyMisses += 1;
    if (
      this.#surveyMisses < SURVEY_MISSES ||
      surveyClock.now() < this.#surveyEndsAfter
    ) {
      return;
    }
    this.#surveying = false;
    this.#pendingClasses.clear();
    this.#pendingIds.clear();
    if (!this.#rules.procedural.length && this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    Services.obs.notifyObservers(this.contentWindow, SURVEY_ENDED_TOPIC);
  }

  #stop() {
    // The actor can outlive its window's wrappers: a document the tab left
    // for a new process is cut off before `didDestroy`, and its observer
    // went with it.
    if (this.#observer && !Cu.isDeadWrapper(this.#observer)) {
      this.#observer.disconnect();
    }
    this.#observer = null;
    if (this.#timer) {
      this.contentWindow?.clearTimeout(this.#timer);
    }
    this.#timer = null;
    this.#rules = null;
  }
}
