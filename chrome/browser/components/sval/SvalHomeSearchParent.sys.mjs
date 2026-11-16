/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The home page's field, answered by the address bar's own engine (decision
 * 0098). Each page gets a `UrlbarController` on the address bar's providers
 * (`sapName` "urlbar"), so what it types reaches the same providers, under the
 * same settings, as typing in the address bar: the heuristic that decides
 * between visiting and searching, history, Favorites, open tabs from every
 * workspace, Sval's commands and the engine's suggestions, in the address
 * bar's sections (launcher spec §3). The page draws the rows; this side
 * decides them, labels them with the address bar's own strings, and opens
 * what is picked through the functions the address bar picks with.
 *
 * The page autofills as the address bar does: what the field holds takes the
 * heuristic's completion, selected after what was typed, when the user typed
 * at its end and did not delete. The rows the address bar's view draws from
 * other providers' templates (the calculator, unit conversion), its tips, its
 * search-mode offers ("@" lists them) and the menu of a row with commands
 * are drawn from what this side sends, and act through the providers'
 * engagement, as the view's do (`UrlbarInput.pickResult`).
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  ContentSearch: "resource:///actors/ContentSearchParent.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  accessOf: "moz-src:///browser/components/sval/SvalLauncherRows.sys.mjs",
  describeRow: "moz-src:///browser/components/sval/SvalLauncherRows.sys.mjs",
  meaningIds: "moz-src:///browser/components/sval/SvalLauncherRows.sys.mjs",
  footFor: "moz-src:///browser/components/sval/SvalLauncherRows.sys.mjs",
  keycap: "moz-src:///browser/components/sval/SvalLauncherRows.sys.mjs",
  LAUNCHER_KEY: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
  MENU_KEYS: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
  ariaShortcut: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
  keyOf: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
  shortcutText: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
  COMMANDS_PROVIDER:
    "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs",
  PINS_GROUP:
    "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs",
  SvalFavoritesProvider:
    "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs",
  SvalLauncherCommands:
    "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs",
  SvalLauncherEnter:
    "moz-src:///browser/components/sval/SvalLauncherEnter.sys.mjs",
  SvalLauncherSections:
    "moz-src:///browser/components/sval/SvalLauncherSections.sys.mjs",
  UrlbarController:
    "moz-src:///browser/components/urlbar/UrlbarController.sys.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  UrlbarProviderOpenTabs:
    "moz-src:///browser/components/urlbar/UrlbarProviderOpenTabs.sys.mjs",
  UrlbarQueryContext:
    "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
  UrlbarUtils: "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
  UrlbarSearchUtils:
    "moz-src:///browser/components/urlbar/UrlbarSearchUtils.sys.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () =>
    new Localization([
      "browser/browser.ftl",
      "toolkit/branding/brandings.ftl",
      "sval/launcher.ftl",
    ])
);

/**
 * What a row teaches (`SvalLauncherRows`), for the page: its chip, the glyph
 * a row with no favicon shows, a workspace's swatch, Enter's key and the
 * line under the list while it is selected, and the messages of its hint
 * and of its name.
 *
 * @param {UrlbarResult} result
 * @param {Window|null} window
 * @param {boolean} choosing Whether the list is a command's choices.
 * @returns {{row: object, hint: object|null, described: object|null}}
 *   `described` is `SvalLauncherRows.describeRow`'s answer.
 */
function teach(result, window, choosing) {
  // A page asking as its window closes has no window left to read from.
  const taught = window ? lazy.describeRow(result, window) : null;
  return {
    row: {
      enterKey: lazy.keycap("VK_RETURN"),
      chip: taught?.chip ?? null,
      glyph: taught?.icon ?? null,
      swatch: taught?.swatch ?? null,
      foot: lazy.footFor(taught, { choosing }),
    },
    hint: taught?.hint ?? null,
    described: taught,
  };
}

/**
 * How a keyword offer enters its search mode, by its provider, as
 * `UrlbarInput._searchModeForResult` records it; any other is a keyword
 * offer's.
 */
const SEARCH_MODE_ENTRIES = Object.freeze({
  UrlbarProviderTopSites: "topsites_urlbar",
  UrlbarProviderTabToSearch: "tabtosearch",
});

/** What the address bar lists in the actions' search mode (`UrlbarInput`). */
const UNLIMITED_MAX_RESULTS = 99;

/** The sap whose providers, and so whose settings, the page shares. */
const SAP_NAME = "urlbar";

/**
 * @param {object|null} message A message `formatMessages` answered.
 * @param {string} name
 * @returns {string|null} the message's attribute `name`, or null.
 */
function attributeOf(message, name) {
  return message?.attributes?.find(a => a.name == name)?.value ?? null;
}

/**
 * A pick in the page as the event the address bar's pick functions read:
 * Enter as a key event, a click as a mouse event with its button. The page
 * cannot hand over its own event, whose keys belong to the content process.
 * `UrlbarInput._whereToOpen` and `SvalLauncherEnter.pickFavorite` tell a key
 * from a click by the event's interface. The target is the window's
 * document, which `PlacesUIUtils.openNodeWithEvent` opens a Favorite from,
 * as it would from the address bar's row.
 *
 * @param {Window} window The page's browser window.
 * @param {object} modifiers The page's `{shiftKey, ctrlKey, metaKey, altKey,
 *   altGraph, button}`, `button` absent for a key.
 * @returns {Event}
 */
function pickEvent(window, modifiers) {
  const init = {
    shiftKey: !!modifiers.shiftKey,
    ctrlKey: !!modifiers.ctrlKey,
    metaKey: !!modifiers.metaKey,
    altKey: !!modifiers.altKey,
    modifierAltGraph: !!modifiers.altGraph,
  };
  const event =
    modifiers.button === undefined
      ? new window.KeyboardEvent("keydown", {
          ...init,
          key: "Enter",
          keyCode: window.KeyEvent.DOM_VK_RETURN,
        })
      : new window.MouseEvent("click", { ...init, button: modifiers.button });
  Object.defineProperty(event, "target", {
    value: window.document.documentElement,
  });
  return event;
}

/**
 * The search mode a row enters, as `UrlbarInput._searchModeForResult` and
 * `UrlbarInput.setSearchMode` make it: a local mode for the row's restriction
 * keyword, the default engine for the search keyword, else the row's engine,
 * which must be one the user has.
 *
 * @param {UrlbarResult} result
 * @param {boolean} isPrivate
 * @param {string} entry How it was entered, as `setSearchMode` records it.
 * @returns {object|null}
 */
function searchModeFor(result, isPrivate, entry) {
  const { keyword, engine, originalEngine } = result.payload;
  const { RESTRICT_TOKENS, SEARCH_MODE_RESTRICT } = lazy.UrlbarShared;
  let engineName = null;
  let source = null;
  if (keyword == RESTRICT_TOKENS.SEARCH) {
    engineName = lazy.UrlbarSearchUtils.getDefaultEngine(isPrivate)?.name;
  } else if (keyword) {
    source =
      lazy.UrlbarUtils.LOCAL_SEARCH_MODES.find(m => m.restrict == keyword)
        ?.source ?? null;
  }
  if (!engineName && source === null && engine) {
    if (!originalEngine || engine == originalEngine) {
      engineName = engine;
    }
  }
  const mode = searchModeOf({ engineName, source }, entry);
  if (!mode) {
    return null;
  }
  if (result.type == lazy.UrlbarUtils.RESULT_TYPE.RESTRICT) {
    mode.restrictType = "keyword";
  } else if (SEARCH_MODE_RESTRICT.has(keyword)) {
    mode.restrictType = "symbol";
  }
  return mode;
}

/**
 * The search mode for an engine the user has, or for a local source, as
 * `UrlbarInput.setSearchMode` makes it.
 *
 * @param {object} what
 * @param {string|null} [what.engineName]
 * @param {number|null} [what.source]
 * @param {string} entry How it was entered, as `setSearchMode` records it.
 * @returns {object|null}
 */
function searchModeOf({ engineName = null, source = null }, entry) {
  let mode = null;
  if (engineName) {
    const found = lazy.SearchService.getEngineByName(engineName);
    if (!found || found.hidden) {
      return null;
    }
    mode = {
      engineName,
      isGeneralPurposeEngine: found.isGeneralPurposeEngine,
    };
    if (found.isGeneralPurposeEngine) {
      mode.source = lazy.UrlbarUtils.RESULT_SOURCE.SEARCH;
    }
  } else if (source !== null) {
    mode = { source };
  } else {
    return null;
  }
  mode.isPreview = false;
  mode.entry = lazy.UrlbarUtils.SEARCH_MODE_ENTRY.has(entry) ? entry : "other";
  return mode;
}

/**
 * A search mode's chip and placeholder, in the address bar's words
 * (`UrlbarInput._updateSearchModeUI`).
 *
 * @param {object} mode {@link searchModeFor}'s.
 * @returns {{chip: object, placeholder: object}} Messages: the chip's, as
 *   a value, and the placeholder, as attributes.
 */
function searchModeWords(mode) {
  if (mode.engineName) {
    return {
      chip: null,
      placeholder: {
        id: mode.isGeneralPurposeEngine
          ? "urlbar-placeholder-search-mode-web-2"
          : "urlbar-placeholder-search-mode-other-engine",
        args: { name: mode.engineName },
      },
    };
  }
  const label = lazy.UrlbarUtils.LOCAL_SEARCH_MODES.find(
    m => m.source == mode.source
  ).telemetryLabel;
  return {
    chip: { id: `urlbar-search-mode-${label}` },
    placeholder: { id: `urlbar-placeholder-search-mode-other-${label}` },
  };
}

/** The icon of an engine that has none (`SearchModeSwitcher`). */
const SEARCH_GLASS = "chrome://global/skin/icons/search-glass.svg";

/** The view's own menu commands (`UrlbarView`'s `RESULT_MENU_COMMANDS`). */
const MENU = Object.freeze({
  DISMISS: "dismiss",
  HELP: "help",
  MANAGE: "manage",
});

/**
 * The commands of a row's menu, as `UrlbarView#getResultMenuCommands` lists
 * them: its provider's own, else dismissing a blockable row, its help page
 * and managing Firefox Suggest.
 *
 * @param {object} manager The controller's providers manager.
 * @param {UrlbarResult} result
 * @param {boolean} isPrivate
 * @returns {object[]|null} `[{name, l10n, children?}]`.
 */
function menuCommandsFor(manager, result, isPrivate) {
  const own = manager
    .getProvider(result.providerName)
    ?.tryMethod("getResultCommands", result, isPrivate);
  if (own) {
    return own;
  }
  const commands = [];
  if (result.payload.isBlockable) {
    commands.push({
      name: MENU.DISMISS,
      l10n: result.payload.blockL10n || {
        id: "urlbar-result-menu-dismiss-suggestion",
      },
    });
  }
  if (result.payload.helpUrl) {
    commands.push({
      name: MENU.HELP,
      l10n: result.payload.helpL10n || { id: "urlbar-result-menu-learn-more" },
    });
  }
  if (result.payload.isManageable) {
    commands.push({
      name: MENU.MANAGE,
      l10n: { id: "urlbar-result-menu-manage-firefox-suggest" },
    });
  }
  return commands.length ? commands : null;
}

const HTML = "http://www.w3.org/1999/xhtml";

/**
 * A row of a provider's own design, made from its view template and update
 * (`UrlbarProvider.getViewTemplate`, `getViewUpdate`) as the address bar's
 * view makes it, with its texts worded: the element a provider reads when
 * the row is picked (`onEngagement`'s `details.element`), and the texts the
 * page draws. A part the update hides is left out of the texts.
 *
 * @param {object} provider
 * @param {UrlbarResult} result
 * @param {Document} doc The browser window's document.
 * @returns {Promise<{element: Element, title: string, action: string,
 *   icon: string|null}>}
 */
async function dynamicRow(provider, result, doc) {
  const template = provider.getViewTemplate?.(result) ?? {};
  const update = (await provider.getViewUpdate?.(result, new Map())) ?? {};
  const { dynamicType } = result.payload;
  const parts = [];
  const make = (node, tag = "span") => {
    const el = doc.createElementNS(HTML, node.tag ?? tag);
    for (const [name, value] of Object.entries(node.attributes ?? {})) {
      el.setAttribute(name, value);
    }
    el.classList.add(...(node.classList ?? []));
    if (node.name) {
      el.classList.add(`urlbarView-dynamic-${dynamicType}-${node.name}`);
      el.setAttribute("name", node.name);
      parts.push({ el, name: node.name, update: update[node.name] ?? {} });
    }
    for (const child of node.children ?? []) {
      el.append(make(child));
    }
    return el;
  };
  const element = make(template, "div");
  const texts = await Promise.all(
    parts.map(({ update: u }) =>
      u.l10n
        ? lazy.l10n.formatValue(u.l10n.id, u.l10n.args)
        : (u.textContent ?? null)
    )
  );
  const title = [];
  let action = "";
  parts.forEach(({ el, name, update: u }, i) => {
    for (const [attr, value] of Object.entries(u.attributes ?? {})) {
      el.setAttribute(attr, value);
    }
    if (texts[i] === null || texts[i] === undefined) {
      return;
    }
    el.textContent = texts[i];
    if (u.style?.display === "none") {
      return;
    }
    if (name == "action") {
      action = texts[i];
    } else {
      title.push(texts[i]);
    }
  });
  return {
    element,
    title: title.join(" "),
    action,
    icon: update.icon?.attributes?.src ?? null,
  };
}

/**
 * A row's own icon, where the page may load it: a `chrome:` or `data:`
 * address. An engine's `blob:` icon belongs to the parent, so its row shows
 * the page's search glass.
 *
 * @param {*} icon
 * @returns {string|null}
 */
function pageIcon(icon) {
  return typeof icon == "string" && /^(chrome|data):/.test(icon) ? icon : null;
}

/**
 * What kind of row a result is and what the page draws of it, as
 * `UrlbarView#updateRow` decides for its own rows: what the field takes
 * while it is selected, its action, a title or button worded by message,
 * its own icon, and the parts a provider draws for it.
 *
 * @param {UrlbarResult} result
 * @param {number} index
 * @param {UrlbarQueryContext} context
 * @param {Map<number, object>} drawn {@link dynamicRow}'s answers, by index.
 * @returns {object|null} null for a row the view draws in no way the page
 *   can.
 */
function rowShape(result, index, context, drawn) {
  const { RESULT_TYPE } = lazy.UrlbarUtils;
  const { payload } = result;
  let kind;
  let fill;
  let action = null;
  let titleMessage = null;
  let button = null;
  let image = null;
  let dynamic = null;
  if (payload.providesSearchMode) {
    // A keyword offer, which enters its search mode
    // (`UrlbarView#setResultTitle`).
    kind = "searchmode";
    fill = payload.keyword ?? "";
    if (result.type == RESULT_TYPE.RESTRICT) {
      titleMessage = {
        id: "urlbar-result-search-with-local-search-mode",
        args: {
          keywords: payload.l10nRestrictKeywords
            .map(keyword => `@${keyword.toLowerCase()}`)
            .join(", "),
          localSearchMode: payload.l10nRestrictKeywords[0].toLowerCase(),
        },
      };
    } else if (
      result.providerName == "UrlbarProviderTokenAliasEngines" &&
      lazy.UrlbarPrefs.getScotchBonnetPref("searchRestrictKeywords.featureGate")
    ) {
      titleMessage = {
        id: "urlbar-result-search-with-engine-keywords",
        args: { keywords: payload.keywords, engine: payload.engine },
      };
    } else {
      titleMessage = {
        id: "urlbar-result-action-search-w-engine",
        args: { engine: payload.engine },
      };
    }
    image = pageIcon(payload.icon);
  } else {
    switch (result.type) {
      case RESULT_TYPE.SEARCH:
        kind = "search";
        fill = payload.suggestion ?? payload.query;
        if (payload.inPrivateWindow) {
          action = payload.isPrivateEngine
            ? {
                id: "urlbar-result-action-search-in-private-w-engine",
                args: { engine: payload.engine },
              }
            : { id: "urlbar-result-action-search-in-private" };
        } else {
          action = {
            id: "urlbar-result-action-search-w-engine",
            args: { engine: payload.engine },
          };
        }
        break;
      case RESULT_TYPE.URL:
      case RESULT_TYPE.KEYWORD:
      case RESULT_TYPE.REMOTE_TAB:
        kind = "url";
        fill = payload.url;
        if (result.heuristic) {
          action = { id: "urlbar-result-action-visit" };
        }
        break;
      case RESULT_TYPE.TAB_SWITCH:
        kind = "tab";
        fill = payload.url;
        // A tab of the tree says where it is in its chip and its hint
        // (`SvalLauncherRows`); Firefox's own row says Switch to Tab.
        if (!payload.svalNodeId) {
          action = { id: "urlbar-result-action-switch-tab" };
        }
        break;
      case RESULT_TYPE.TIP:
        // Its button is what Enter and a click take (`UrlbarView`'s tip
        // rows).
        kind = "tip";
        fill = context.searchString;
        titleMessage = payload.titleL10n ?? null;
        button = payload.buttons?.[0]?.l10n ?? null;
        image = pageIcon(payload.icon);
        break;
      case RESULT_TYPE.DYNAMIC:
        if (result.providerName === lazy.COMMANDS_PROVIDER) {
          kind = "command";
          // What the address bar's field keeps while the row is selected.
          fill = payload.input;
          break;
        }
        dynamic = drawn.get(index);
        if (!dynamic) {
          return null;
        }
        kind = "dynamic";
        fill = payload.input ?? context.searchString;
        image = pageIcon(dynamic.icon);
        break;
      default:
        return null;
    }
  }
  return { kind, fill, action, titleMessage, button, image, dynamic };
}

/**
 * The heading of a row's section, as `UrlbarView#rowLabel` gives it.
 *
 * @param {UrlbarResult} result
 * @param {UrlbarQueryContext} context
 * @returns {{id: string, args?: object}|null}
 */
function rowLabelFor(result, context) {
  if (!lazy.UrlbarPrefs.get("groupLabels.enabled")) {
    return null;
  }
  const sval = lazy.SvalLauncherSections.rowLabel(result, context);
  if (sval !== undefined) {
    return sval;
  }
  if (result.rowLabel) {
    return result.rowLabel;
  }
  const engine =
    result.payload.engine || lazy.SearchService.defaultEngine?.name;
  if (result.payload.trending) {
    return { id: "urlbar-group-trending", args: { engine } };
  }
  if (result.providerName == "UrlbarProviderRecentSearches") {
    return { id: "urlbar-group-recent-searches" };
  }
  if (result.providerName == "UrlbarProviderQuickSuggest") {
    return result.isBestMatch ? null : { id: "urlbar-group-firefox-suggest" };
  }
  if (result.isBestMatch) {
    return { id: "urlbar-group-best-match" };
  }
  if (
    result.providerName == "UrlbarProviderTopSites" &&
    context.results[0].providerName != "UrlbarProviderTopSites"
  ) {
    return { id: "urlbar-group-shortcuts" };
  }
  if (!context.searchString || result.heuristic) {
    return null;
  }
  const {
    KEYWORD,
    REMOTE_TAB,
    TAB_SWITCH,
    URL: PAGE,
    SEARCH,
  } = lazy.UrlbarUtils.RESULT_TYPE;
  switch (result.type) {
    case KEYWORD:
    case REMOTE_TAB:
    case TAB_SWITCH:
    case PAGE:
      return { id: "urlbar-group-firefox-suggest" };
    case SEARCH:
      return { id: "urlbar-group-search-suggestions", args: { engine } };
  }
  return null;
}

/**
 * One home page's end of its field: queries, their rows, and picks.
 *
 * The page asks; this side acts only on what it produced. A pick names a row
 * of the rows this side sent for the page's latest query, and is taken only
 * while the page is the tab its window shows. `SvalHomeSearchChild` lets a
 * pick through only with the user's activation of the page.
 */
export class SvalHomeSearchParent extends JSWindowActorParent {
  #controller = null;
  /**
   * The last query's context, the id the page gave it, the results of each
   * list sent for it, and the element of each provider-drawn row of them.
   */
  #last = null;
  /** The field's search mode, as `UrlbarInput.searchMode` holds one. */
  #searchMode = null;
  /** The row menu open for the page, if one is. */
  #menu = null;
  /** The engine list open for the page, if one is. */
  #engineList = null;

  didDestroy() {
    this.#controller?.cancelQuery();
    this.#controller = null;
    this.#last = null;
    this.#menu?.hidePopup();
    this.#menu?.remove();
    this.#menu = null;
    this.#engineList?.hide(null, { force: true });
  }

  receiveMessage({ name, data }) {
    switch (name) {
      case "Placeholder":
        return this.#placeholder();
      case "Paste":
        // The address bar's own cleaning of pasted and dropped text, which
        // strips `javascript:` (`UrlbarInput#_on_paste`).
        return lazy.UrlbarUtils.sanitizeTextFromClipboard(String(data ?? ""));
      case "Query":
        return this.#query(data);
      case "Pick":
        return this.#pick(data);
      case "Choose":
        return this.#choose(data);
      case "Dismiss":
        return this.#dismiss(data);
      case "Menu":
        return this.#openMenu(data);
      case "EngineMenu":
        return this.#openEngineMenu(data);
      case "ExitSearchMode":
        this.#searchMode = null;
        return null;
      case "StopChoosing":
        if (this.#controller) {
          lazy.SvalLauncherCommands.stopChoosing(this.#controller.input);
        }
        return null;
      case "Shown":
        this.#keepPrivatePageInPrivateWindows();
        return null;
    }
    return null;
  }

  /**
   * about:privatebrowsing is the private window's home page, and says so. A
   * normal window shows it when the user types its address there; it opens in
   * a new private window instead, as upstream's page offers
   * (`AboutPrivateBrowsingParent`, "OpenPrivateWindow"). The tab it was typed
   * into goes back to the page it showed, or closes if it showed none. The
   * window's last tab gives way to a new tab (`closeWindowWithLastTab`), so
   * the window stays open.
   *
   * The window's privacy and the page's address are this side's own, so the
   * page cannot steer it. A private window's page is left where it is.
   */
  #keepPrivatePageInPrivateWindows() {
    const browser = this.#browser;
    const window = this.#window;
    if (
      !browser ||
      !window ||
      this.#isPrivate ||
      browser.currentURI.spec.replace(/[?#].*$/, "") !== "about:privatebrowsing"
    ) {
      return;
    }
    window.OpenBrowserWindow({ private: true });
    if (browser.canGoBack) {
      browser.goBack();
      return;
    }
    const tab = window.gBrowser.getTabForBrowser(browser);
    if (tab) {
      window.gBrowser.removeTab(tab, { closeWindowWithLastTab: false });
    }
  }

  get #browser() {
    return this.browsingContext.top.embedderElement;
  }

  get #window() {
    return this.#browser?.documentGlobal ?? null;
  }

  get #isPrivate() {
    return lazy.PrivateBrowsingUtils.isBrowserPrivate(this.#browser);
  }

  /**
   * A controller on the address bar's providers, standing in for an address
   * bar the page does not have. `UrlbarController` asks its input only for
   * what it names here, and the address bar's pick functions only for its
   * window and `handleRevert`, which puts the address bar's text back: the
   * page's field puts back its own.
   */
  get #urlbarController() {
    if (!this.#controller) {
      const window = this.#window;
      const isPrivate = this.#isPrivate;
      this.#controller = new lazy.UrlbarController({
        input: {
          window,
          isPrivate,
          sapName: SAP_NAME,
          onFirstResult: () => false,
          getSearchSource: () => "urlbar",
          handleRevert: () => {},
        },
      });
      this.#controller.addListener({
        onQueryResults: context => this.#sendLogged(context),
        // A provider took a row away, as one does on ⇧Delete
        // (`UrlbarController.removeResult`).
        onQueryResultRemoved: () => {
          if (this.#last) {
            this.#sendLogged(this.#last.context);
          }
        },
      });
    }
    return this.#controller;
  }

  /**
   * The address bar's own placeholder, chosen as `UrlbarInput#_setPlaceholder`
   * chooses it (`launcher-float.patch`), and the Launcher's key as it is now,
   * which the page shows in a key cap as the address bar does
   * (`SvalLauncher`): from any page, the key opens the Launcher this field
   * is.
   *
   * @returns {Promise<{text: string, key: string}>} `key` is "" when the user
   *   cleared it.
   */
  async #placeholder() {
    // A page still asking as its tab closes, as one closing with its window
    // does, has no browser left to read the window's privacy from, and shows
    // nothing more.
    const window = this.#browser && this.#window;
    if (!window) {
      return { text: "", key: "", engineLabel: "" };
    }
    const keywords = lazy.UrlbarPrefs.get("keyword.enabled");
    const message = keywords
      ? { id: "launcher-placeholder" }
      : { id: "urlbar-placeholder-keyword-disabled" };
    // The switcher's own name for its button (`SearchModeSwitcher`'s
    // `updateSearchIcon`).
    const engine = lazy.UrlbarSearchUtils.getDefaultEngine(this.#isPrivate);
    let button = { id: "urlbar-searchmode-button-no-engine2" };
    if (!keywords) {
      button = { id: "urlbar-searchmode-no-keyword2" };
    } else if (engine) {
      button = {
        id: "urlbar-searchmode-button3",
        args: { engine: engine.name },
      };
    }
    const [formatted, buttonWords] = await lazy.l10n.formatMessages([
      message,
      button,
    ]);
    const keyEl = window.document.getElementById(lazy.LAUNCHER_KEY);
    return {
      engineLabel: attributeOf(buttonWords, "title") ?? "",
      text:
        formatted.attributes.find(a => a.name == "placeholder")?.value ?? "",
      key:
        keyEl?.getAttribute("key") || keyEl?.getAttribute("keycode")
          ? lazy.shortcutText(lazy.keyOf(keyEl))
          : "",
    };
  }

  /**
   * Starts a query for what the page's field holds, as the address bar starts
   * one for its own (`UrlbarInput#makeQueryContext`).
   *
   * @param {object} data
   * @param {number} data.id The page's id for the query.
   * @param {string} data.searchString What the field holds.
   * @param {boolean} [data.allowAutofill] Whether the user typed at the
   *   field's end, as `UrlbarInput#_on_input` allows autofill.
   * @param {boolean} [data.pasted] Whether the text was pasted or dropped.
   */
  #query({ id, searchString, allowAutofill = false, pasted = false }) {
    const window = this.#window;
    if (!window) {
      return null;
    }
    const browser = this.#browser;
    const controller = this.#urlbarController;
    const providers = lazy.SvalLauncherCommands.providersFor(controller.input);
    // The page sends it, so it is whatever the page sent.
    const text = String(searchString ?? "");
    const mode = providers ? null : this.#searchMode;
    const context = new lazy.UrlbarQueryContext({
      allowAutofill: !providers && allowAutofill === true,
      isPrivate: this.#isPrivate,
      sapName: SAP_NAME,
      maxResults:
        mode?.source == lazy.UrlbarUtils.RESULT_SOURCE.ACTIONS
          ? UNLIMITED_MAX_RESULTS
          : lazy.SvalLauncherSections.maxResults(SAP_NAME),
      searchString: text,
      userContextId: parseInt(browser.getAttribute("usercontextid") || 0),
      tabGroup: window.gBrowser.getTabForBrowser(browser)?.group?.id ?? null,
      currentPage: browser.currentURI.spec,
      prohibitRemoteResults:
        pasted === true &&
        lazy.UrlbarPrefs.get("maxCharsForSearchSuggestions") < text.length,
      ...(mode
        ? {
            searchMode: mode,
            ...(mode.source ? { sources: [mode.source] } : {}),
          }
        : {}),
      ...(providers ? { providers } : {}),
    });
    this.#last = { id, context, sent: new Map(), elements: new Map() };
    controller.startQuery(context);
    return null;
  }

  /**
   * {@link #send}, for a listener that cannot wait on it.
   *
   * @param {UrlbarQueryContext} context
   */
  #sendLogged(context) {
    this.#send(context).catch(err =>
      lazy.SvalLog.error(
        `home search: the results failed: ${lazy.describeError(err)}`
      )
    );
  }

  async #send(context) {
    // An answer can arrive after the page's tab has closed or moved on, and
    // the page it was for has gone with its browser.
    if (this.#last?.context !== context || !this.#browser) {
      return;
    }
    // A pick names a row of a list the page drew, by that list's number, so
    // it reads that list, not `context.results`, which the muxer replaces as
    // answers arrive, nor a later list still on its way to the page.
    const results = context.results.slice();
    if (await this.#enterTypedSearchMode(results[0])) {
      return;
    }
    if (this.#last?.context !== context || !this.#browser) {
      return;
    }
    const { id } = this.#last;
    const elements = new Map();
    const rows = await this.#rows(context, results, elements);
    if (!rows) {
      return;
    }
    const idleFoot = await this.#idleFoot(this.#choosing());
    const [menuButton] = await lazy.l10n.formatMessages([
      { id: "urlbar-result-menu-button" },
    ]);
    if (this.#last?.context !== context) {
      return;
    }
    const list = this.#last.sent.size;
    this.#last.sent.set(list, results);
    this.#last.elements.set(list, elements);
    this.sendAsyncMessage("Results", {
      id,
      list,
      searchString: context.searchString,
      rows,
      idleFoot,
      allowEmptySelection: !results[0]?.heuristic,
      menuLabel: attributeOf(menuButton, "title") ?? "",
      // `UrlbarController.keyEventMovesCaret`'s platforms, and the macOS
      // Ctrl+N and Ctrl+P of `handleKeyNavigation`.
      caretKeys: ["macosx", "linux"].includes(AppConstants.platform),
      emacsKeys: AppConstants.platform == "macosx",
    });
  }

  /**
   * Enters the search mode a typed keyword names, as the address bar does
   * on its first result (`UrlbarInput.onFirstResult`): "@history " or an
   * engine's alias and a space.
   *
   * @param {UrlbarResult|undefined} first
   * @returns {Promise<boolean>} Whether it entered one, and the page queries
   *   again in it.
   */
  async #enterTypedSearchMode(first) {
    if (
      !this.#browser ||
      this.#searchMode ||
      this.#choosing() ||
      !first?.heuristic ||
      !first.payload.keyword ||
      first.payload.providesSearchMode
    ) {
      return false;
    }
    const mode = searchModeFor(first, this.#isPrivate, "typed");
    if (!mode) {
      return false;
    }
    await this.#enterSearchMode(mode, first.payload.query?.trimStart() || "");
    return true;
  }

  /**
   * Puts the field in `mode`, and tells the page, which shows its chip and
   * placeholder, takes `value` and queries again.
   *
   * @param {object} mode {@link searchModeFor}'s.
   * @param {string} value
   */
  async #enterSearchMode(mode, value) {
    this.#controller?.cancelQuery();
    this.#searchMode = mode;
    const words = searchModeWords(mode);
    const [chip, placeholder, back] = await lazy.l10n.formatMessages([
      words.chip ?? { id: "urlbar-search-mode-indicator-close" },
      words.placeholder,
      { id: "urlbar-search-mode-indicator-close" },
    ]);
    // The field may have queried nothing yet, as when an engine is picked
    // before anything is typed.
    if (!this.#browser) {
      return;
    }
    // The button shows the mode as the address bar's switcher does
    // (`SearchModeSwitcher.updateSearchIcon`): the engine's icon, or the
    // local mode's.
    const engine = mode.engineName
      ? lazy.SearchService.getEngineByName(mode.engineName)
      : null;
    const icon = engine
      ? await lazy.ContentSearch._getEngineIconURL(engine)
      : (lazy.UrlbarUtils.LOCAL_SEARCH_MODES.find(m => m.source == mode.source)
          ?.icon ?? SEARCH_GLASS);
    const [exit] = await lazy.l10n.formatMessages([
      { id: "urlbar-searchmode-exit-button2" },
    ]);
    if (!this.#browser || this.#searchMode !== mode) {
      return;
    }
    this.sendAsyncMessage("SearchMode", {
      icon,
      exit: attributeOf(exit, "title") ?? "",
      chip: words.chip ? (chip?.value ?? "") : mode.engineName,
      placeholder: attributeOf(placeholder, "placeholder") ?? "",
      label: attributeOf(placeholder, "aria-label") ?? "",
      back: attributeOf(back, "aria-label") ?? "",
      value,
    });
  }

  /** @returns {boolean} Whether the page's field lists a command's choices. */
  #choosing() {
    return (
      !!this.#controller &&
      !!lazy.SvalLauncherCommands.providersFor(this.#controller.input)
    );
  }

  /** @returns {boolean} Whether the page is the tab its window shows. */
  #shown() {
    const browser = this.#browser;
    return !!browser && this.#window?.gBrowser.selectedBrowser === browser;
  }

  /**
   * The result a row of a list the page drew stands for.
   *
   * @param {number} id The query.
   * @param {number} list Which of its lists.
   * @param {number} index The row's result index.
   * @returns {UrlbarResult|null}
   */
  #resultAt(id, list, index) {
    return this.#last?.id === id
      ? (this.#last.sent.get(list)?.[index] ?? null)
      : null;
  }

  /**
   * Lists the choices of the command that picks whose row the page picked
   * (`SvalLauncherCommands.choose`): the page's next queries are answered
   * with them, until it steps back or picks.
   *
   * @param {object} data
   * @param {number} data.id
   * @param {number} data.list
   * @param {number} data.index
   * @returns {Promise<object|null>} The field's placeholder and the chip's
   *   Back button's name while the choices show, or null when the command
   *   no longer applies.
   */
  async #choose({ id, list, index }) {
    const result = this.#shown() ? this.#resultAt(id, list, index) : null;
    const command =
      result &&
      this.#controller &&
      lazy.SvalLauncherCommands.choose(this.#controller.input, result);
    if (!command) {
      return null;
    }
    this.#controller.cancelQuery();
    const [placeholder, back] = await lazy.l10n.formatMessages([
      { id: command.chooseL10nId },
      { id: "launcher-chip-back" },
    ]);
    return {
      placeholder: attributeOf(placeholder, "placeholder") ?? "",
      back: attributeOf(back, "aria-label") ?? "",
    };
  }

  /**
   * The rows the page draws, each labelled and worded as the address bar's
   * view words it (`UrlbarView#updateRow`, `UrlbarView#rowLabel`), with
   * what Sval's rows carry there: an open tab's node and workspace, a pin's
   * or Favorite's mark, a command's key, and what each row teaches
   * (`SvalLauncherRows`).
   *
   * @param {UrlbarQueryContext} context
   * @param {UrlbarResult[]} results The results the rows are of.
   * @param {Map<number, Element>} elements Filled with the element of each
   *   row a provider draws ({@link dynamicRow}), by its result index.
   * @returns {Promise<object[]|null>} null once the page's browser is gone.
   */
  async #rows(context, results, elements) {
    const { RESULT_SOURCE, RESULT_TYPE } = lazy.UrlbarUtils;
    const rows = [];
    // Each row's strings, formatted together once the rows are made.
    const strings = [];
    // Read before the waits below, which the browser may not outlast.
    if (!this.#browser || !this.#controller) {
      return null;
    }
    const window = this.#window;
    const isPrivate = this.#isPrivate;
    const choosing = this.#choosing();
    const manager = this.#controller.manager;
    // What each row teaches, by the row.
    const teachings = [];
    // The suggestions label shows only once some other row has come before
    // them (`UrlbarView#updateRowLabel`).
    let onlyHeuristicOrSuggestions = true;
    // The rows a provider draws are made from its template first, which
    // may wait on the provider.
    const drawn = new Map();
    await Promise.all(
      results.map(async (result, index) => {
        if (
          result.type === RESULT_TYPE.DYNAMIC &&
          result.providerName !== lazy.COMMANDS_PROVIDER &&
          window
        ) {
          const provider = manager.getProvider(result.providerName);
          if (!provider) {
            return;
          }
          // A provider that fails loses its own row; the rest still show.
          try {
            drawn.set(
              index,
              await dynamicRow(provider, result, window.document)
            );
          } catch (err) {
            lazy.SvalLog.error(
              `home search: a provider's row failed: ${lazy.describeError(err)}`
            );
          }
        }
      })
    );
    results.forEach((result, index) => {
      const { payload } = result;
      const shape = rowShape(result, index, context, drawn);
      if (!shape) {
        return;
      }
      const { kind, fill, action, titleMessage, button, image, dynamic } =
        shape;
      if (dynamic) {
        elements.set(index, dynamic.element);
      }
      const tokens = context.tokens;
      let title;
      if (kind == "command") {
        title = { value: payload.title, highlights: payload.highlights };
      } else if (kind == "search") {
        title = { value: fill, highlights: [] };
      } else if (kind == "dynamic") {
        title = { value: dynamic.title, highlights: [] };
      } else if (titleMessage || kind == "tip") {
        title = { value: payload.title ?? "", highlights: [] };
      } else {
        title = result.getDisplayableValueAndHighlights("title", { tokens });
      }
      const url =
        kind == "url" || kind == "tab"
          ? result.getDisplayableValueAndHighlights("url", {
              tokens,
              isURL: true,
            })
          : {};
      const isSuggestion = kind == "search" && payload.suggestion;
      let label = null;
      if (!(isSuggestion && onlyHeuristicOrSuggestions)) {
        label = rowLabelFor(result, context);
      }
      if (result.hideRowLabel) {
        label = null;
      }
      onlyHeuristicOrSuggestions &&= result.heuristic || !!isSuggestion;
      // The marks the address bar's view draws: a pin's, and the star of a
      // Favorite's row, which its open tab's row wears too
      // (`favorites-open-tab-star.patch`).
      let mark = null;
      if (result.group === lazy.PINS_GROUP) {
        mark = "pin";
      } else if (
        result.source === RESULT_SOURCE.BOOKMARKS ||
        (kind == "tab" &&
          lazy.SvalFavoritesProvider.nameOf(payload.url) !== null)
      ) {
        mark = "favorite";
      }
      const taught = teach(result, window, choosing);
      teachings.push(taught.described);
      rows.push({
        index,
        kind,
        heuristic: result.heuristic,
        fill: result.heuristic ? context.searchString : fill,
        autofill: result.autofill
          ? {
              value: result.autofill.value,
              selectionStart: result.autofill.selectionStart,
              selectionEnd: result.autofill.selectionEnd,
            }
          : null,
        title: title.value ?? "",
        titleHighlights: title.highlights ?? [],
        url: url.value ?? "",
        urlHighlights: url.highlights ?? [],
        icon: kind == "url" || kind == "tab" ? payload.url : null,
        image,
        mark,
        menu: !!menuCommandsFor(manager, result, isPrivate),
        nodeId: payload.svalNodeId ?? null,
        workspace: payload.svalWorkspaceName ?? null,
        commandId: payload.commandId ?? null,
        picks: !!payload.picks,
        current: !!payload.current,
        shortcut: payload.shortcut ?? null,
        ariaShortcut: payload.ariaShortcut ?? null,
        action: dynamic?.action || null,
        label: null,
        name: null,
        tag: null,
        hint: null,
        button: null,
        ...taught.row,
      });
      strings.push([
        action,
        label,
        titleMessage,
        payload.current ? { id: "launcher-choice-current" } : null,
        taught.hint,
        button,
      ]);
    });
    const feet = rows.map(row => row.foot);
    const footMessages = feet
      .flat()
      .map(item => ({ id: item.note ?? item.l10nId }));
    const formatted = await lazy.l10n.formatMessages([
      ...strings.flat().map(m => m ?? { id: "urlbar-result-action-visit" }),
      ...footMessages,
    ]);
    const PER_ROW = 6;
    rows.forEach((row, i) => {
      const [action, label, title, tag, hint, button] = strings[i].map(
        (m, j) => m && formatted[PER_ROW * i + j]
      );
      row.action = action?.value ?? row.action;
      row.label = attributeOf(label, "label");
      if (title) {
        row.title = title.value ?? "";
      }
      row.tag = tag?.value ?? null;
      row.hint = hint?.value ?? null;
      row.button = button?.value ?? null;
    });
    let at = PER_ROW * rows.length;
    for (const row of rows) {
      row.foot = row.foot.map(item => ({
        keys: item.keys ?? null,
        aria: item.aria ?? null,
        text: formatted[at++]?.value ?? "",
        note: !!item.note,
        end: !!item.end,
      }));
    }
    // What a screen reader hears of each row's keys, which the line under
    // the list shows (`SvalLauncherRows.accessOf`), and an open tab's name.
    const ids = teachings.flatMap(taught => lazy.meaningIds(taught));
    const meanings = ids.length
      ? await lazy.l10n.formatValues(ids.map(id => ({ id })))
      : [];
    let next = 0;
    const names = [];
    rows.forEach((row, i) => {
      const taught = teachings[i];
      const count = lazy.meaningIds(taught).length;
      const access = lazy.accessOf(taught, meanings.slice(next, next + count));
      next += count;
      row.keyshortcuts = access.keyshortcuts;
      row.description = access.description;
      names.push(taught?.name ?? null);
    });
    // The page writes the description itself, with the address it shows.
    const formattedNames = await lazy.l10n.formatMessages(
      names
        .filter(Boolean)
        .map(({ id, args }) => ({ id, args: { ...args, description: "" } }))
    );
    let named = 0;
    rows.forEach((row, i) => {
      row.name = names[i]
        ? attributeOf(formattedNames[named++], "aria-label")
        : null;
    });
    return rows;
  }

  /**
   * The line under the page's list while no row is selected, worded.
   *
   * @param {boolean} choosing Whether the list is a command's choices.
   * @returns {Promise<object[]>} `[{ keys, text, note, end }]`.
   */
  async #idleFoot(choosing) {
    const items = lazy.footFor(null, { choosing });
    const formatted = await lazy.l10n.formatValues(
      items.map(item => ({ id: item.note ?? item.l10nId }))
    );
    return items.map((item, i) => ({
      keys: item.keys ?? null,
      text: formatted[i] ?? "",
      note: !!item.note,
      end: !!item.end,
    }));
  }

  /**
   * Tells the row's provider of an engagement with it, as the address bar's
   * engagement does (`UrlbarController`'s `TelemetryEvent.record`), which is
   * where a provider acts on its own rows.
   *
   * @param {UrlbarResult} result
   * @param {object} details `{ selType, element?, isSessionOngoing? }`.
   */
  #engage(result, details) {
    const controller = this.#urlbarController;
    controller.manager.notifyEngagementChange(
      "engagement",
      this.#last?.context ?? null,
      {
        result,
        element: null,
        searchString: this.#last?.context.searchString ?? "",
        ...details,
      },
      controller
    );
  }

  /**
   * Removes the row the page asked to, on ⇧Delete, as the address bar does
   * (`UrlbarController#dismissSelectedResult`): its provider removes what it
   * can, such as a page from history, and takes the row from the list, which
   * goes to the page again. A heuristic stays, unless it is an autofill.
   *
   * @param {object} data
   * @param {number} data.id
   * @param {number} data.list
   * @param {number} data.index
   */
  #dismiss({ id, list, index }) {
    const result = this.#shown() ? this.#resultAt(id, list, index) : null;
    if (!result || (result.heuristic && !result.autofill)) {
      return;
    }
    this.#engage(result, { selType: "dismiss", isSessionOngoing: true });
  }

  /**
   * Opens a row's menu, as the address bar's view opens it on its menu
   * button (`UrlbarView.openResultMenu`), under the page's button, in the
   * browser window. A command picked there acts as the address bar's do
   * (`UrlbarInput#pickMenuResult`), and the page hears "MenuClosed" when it
   * closes, with whether the list should close too.
   *
   * @param {object} data
   * @param {number} data.id
   * @param {number} data.list
   * @param {number} data.index
   * @param {object} data.anchor The button's box in the page, in CSS pixels.
   */
  async #openMenu({ id, list, index, anchor }) {
    const window = this.#window;
    const browser = this.#browser;
    const result = this.#shown() ? this.#resultAt(id, list, index) : null;
    const commands =
      result &&
      menuCommandsFor(this.#urlbarController.manager, result, this.#isPrivate);
    if (!commands) {
      this.sendAsyncMessage("MenuClosed", { closeList: false });
      return;
    }
    const doc = window.document;
    this.#menu?.remove();
    const popup = doc.createXULElement("menupopup");
    popup.id = "sval-home-result-menu";
    this.#menu = popup;
    let picked = false;
    const fill = (into, items) => {
      for (const command of items) {
        if (command.name == "separator") {
          into.append(doc.createXULElement("menuseparator"));
          continue;
        }
        if (command.children) {
          const menu = doc.createXULElement("menu");
          doc.l10n.setAttributes(menu, command.l10n.id, command.l10n.args);
          const sub = doc.createXULElement("menupopup");
          fill(sub, command.children);
          menu.append(sub);
          into.append(menu);
          continue;
        }
        const item = doc.createXULElement("menuitem");
        doc.l10n.setAttributes(item, command.l10n.id, command.l10n.args);
        // Shift+Delete on the row runs the same dismissal (`#dismiss`).
        if (command.name == MENU.DISMISS) {
          item.setAttribute("key", lazy.MENU_KEYS.dismiss.id);
          item.setAttribute(
            "aria-keyshortcuts",
            lazy.ariaShortcut(lazy.MENU_KEYS.dismiss)
          );
        }
        item.addEventListener("command", event => {
          picked = this.#pickMenuCommand(result, command.name, event);
        });
        into.append(item);
      }
    };
    fill(popup, commands);
    doc.getElementById("mainPopupSet").append(popup);
    await doc.l10n.translateFragment(popup);
    popup.addEventListener(
      "popuphidden",
      event => {
        if (event.target !== popup) {
          return;
        }
        popup.remove();
        if (this.#menu === popup) {
          this.#menu = null;
        }
        // Firefox fires the item's command before the popup hides.
        try {
          this.sendAsyncMessage("MenuClosed", { closeList: picked });
        } catch {
          // The page went away with its menu.
        }
      },
      { once: true }
    );
    const zoom = browser.fullZoom;
    const x = Number(anchor?.left) || 0;
    const y = Number(anchor?.bottom) || 0;
    popup.openPopup(browser, {
      position: "overlap",
      x: x * zoom,
      y: y * zoom,
    });
  }

  /**
   * Opens the field's engine list under the page's engine button: the
   * address bar's search-mode switcher's own list, a `panel-list` in a XUL
   * panel with its classes, items and strings (`SearchModeSwitcher`), so it
   * looks and behaves as the address bar's does. An engine or a local mode
   * puts the field in its search mode with what it holds. Shift, or a pick
   * that opens a tab, opens the engine's results page for what the field
   * holds instead (`SearchModeSwitcher#remoteSearch`). The page hears
   * "EngineMenuClosed" when it closes.
   *
   * @param {object} data
   * @param {string} data.value What the field holds.
   * @param {object} data.anchor The button's box in the page, in CSS pixels.
   * @param {boolean} data.byKeyboard Whether a key opened it, which puts
   *   focus on its first item, as on the address bar's.
   */
  async #openEngineMenu({ value, anchor, byKeyboard }) {
    const window = this.#window;
    const browser = this.#browser;
    if (!window || !browser || !this.#shown()) {
      return;
    }
    const searchString = String(value ?? "");
    const engines = (await lazy.SearchService.getVisibleEngines()).filter(
      engine => !engine.hideOneOffButton
    );
    const settingsRedesign = Services.prefs.getBoolPref(
      "browser.settings-redesign.enabled",
      true
    );
    const locals = lazy.UrlbarUtils.LOCAL_SEARCH_MODES.filter(
      mode => settingsRedesign || lazy.UrlbarPrefs.get(mode.pref)
    );
    const icons = await Promise.all(engines.map(e => e.getIconURL()));
    if (!this.#shown()) {
      return;
    }
    const doc = window.document;
    this.#engineList?.hide(null, { force: true });
    const panel = doc.createXULElement("panel");
    panel.setAttribute("level", "top");
    panel.setAttribute("consumeoutsideclicks", "false");
    panel.classList.add("searchmode-switcher-panel", "toolbar-menupopup");
    const list = doc.createElementNS(HTML, "panel-list");
    list.className = "searchmode-switcher-panel-list";
    list.setAttribute("click-on-mouseup", "");
    // The address bar sets the list's width on `.urlbar`, which this list
    // is outside.
    list.style.setProperty(
      "--urlbar-searchmode-switcher-panel-list-min-width",
      "17em"
    );
    const description = doc.createElementNS(HTML, "div");
    description.className = "searchmode-switcher-panel-description";
    description.setAttribute("role", "heading");
    doc.l10n.setAttributes(
      description,
      "urlbar-searchmode-popup-one-off-header"
    );
    const enginesEnd = doc.createElementNS(HTML, "hr");
    const footer = doc.createElementNS(HTML, "hr");
    footer.className =
      "searchmode-switcher-panel-installed-engine-separator searchmode-switcher-panel-footer-separator";
    const item = (icon, act) => {
      const panelItem = doc.createElementNS(HTML, "panel-item");
      if (icon) {
        panelItem.style.setProperty("--icon-url", `url(${icon})`);
      }
      // As the switcher's items take them (`#addCommandListeners`): a
      // click, or Enter or Space, since a keyboard's click has no Shift.
      panelItem.addEventListener("click", event => {
        if (event.inputSource != window.MouseEvent.MOZ_SOURCE_KEYBOARD) {
          act(event);
        }
      });
      panelItem.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          act(event);
        }
      });
      return panelItem;
    };
    const engineItems = engines.map((engine, index) => {
      const panelItem = item(icons[index] ?? SEARCH_GLASS, event => {
        list.hide(null, { force: true });
        this.#pickEngine(engine, searchString, event);
      });
      panelItem.textContent = engine.name;
      panelItem.classList.add("searchmode-switcher-installed");
      panelItem.setAttribute("title", engine.name);
      panelItem.setAttribute("accesskey", engine.name[0]);
      panelItem.dataset.engineName = engine.name;
      panelItem.dataset.action = "searchmode";
      return panelItem;
    });
    const localItems = locals.map(mode => {
      const panelItem = item(mode.icon, () => {
        list.hide(null, { force: true });
        this.#enterSearchMode(
          searchModeOf({ source: mode.source }, "searchbutton"),
          searchString
        );
      });
      panelItem.classList.add(
        "searchmode-switcher-local",
        `search-button-${lazy.UrlbarUtils.getResultSourceName(mode.source)}`
      );
      panelItem.dataset.action = "localsearchmode";
      panelItem.dataset.restrict = mode.restrict;
      panelItem.setAttribute("data-l10n-attrs", "accesskey");
      doc.l10n.setAttributes(panelItem, mode.uiLabel);
      return panelItem;
    });
    const settings = item(null, () => {
      list.hide(null, { force: true });
      window.openPreferences("paneSearch");
    });
    settings.classList.add("searchmode-switcher-panel-search-settings-button");
    settings.dataset.action = "openpreferences";
    settings.setAttribute("data-l10n-attrs", "accesskey");
    doc.l10n.setAttributes(settings, "urlbar-searchmode-popup-search-settings");
    list.append(
      description,
      ...engineItems,
      enginesEnd,
      ...localItems,
      footer,
      settings
    );
    panel.append(list);
    // The list opens under its anchor, so the anchor is a box placed over
    // the page's button.
    const box = doc.createElementNS(HTML, "div");
    const zoom = browser.fullZoom;
    const page = browser.getBoundingClientRect();
    Object.assign(box.style, {
      position: "fixed",
      pointerEvents: "none",
      left: `${page.left + (Number(anchor?.left) || 0) * zoom}px`,
      top: `${page.top + (Number(anchor?.top) || 0) * zoom}px`,
      width: `${(Number(anchor?.width) || 0) * zoom}px`,
      height: `${(Number(anchor?.height) || 0) * zoom}px`,
    });
    doc.body.append(box);
    doc.getElementById("mainPopupSet").append(panel);
    this.#engineList = list;
    list.addEventListener(
      "hidden",
      () => {
        panel.remove();
        box.remove();
        if (this.#engineList === list) {
          this.#engineList = null;
        }
        try {
          this.sendAsyncMessage("EngineMenuClosed");
        } catch {
          // The page went away with its list.
        }
      },
      { once: true }
    );
    list.show(
      byKeyboard
        ? new window.KeyboardEvent("keydown", { key: "ArrowDown" })
        : null,
      box
    );
  }

  /**
   * Searches with `engine` as the switcher's engine items do
   * (`SearchModeSwitcher#remoteSearch`): the field enters its search mode,
   * or with Shift, or a key that opens a tab, its results page opens.
   *
   * @param {nsISearchEngine} engine
   * @param {string} searchString
   * @param {Event} event The item's command.
   */
  #pickEngine(engine, searchString, event) {
    const window = this.#window;
    if (!window) {
      return;
    }
    let where = lazy.BrowserUtils.whereToOpenLink(event, false, true);
    if (!where.startsWith("tab")) {
      where = "current";
    }
    if (!event.shiftKey && where == "current") {
      const mode = searchModeOf({ engineName: engine.name }, "searchbutton");
      if (mode) {
        this.#enterSearchMode(mode, searchString);
      }
      return;
    }
    const trimmed = searchString.trim();
    const [url, postData] = trimmed
      ? lazy.UrlbarUtils.getSearchQueryUrl(engine, trimmed)
      : [engine.searchForm, null];
    window.openTrustedLinkIn(url, where, {
      inBackground: true,
      postData,
      targetBrowser: this.#browser,
    });
  }

  /**
   * Does what a row's menu command does in the address bar
   * (`UrlbarInput#pickMenuResult`): the provider hears of it, Manage opens
   * the address bar's settings, and Help opens its page in a new tab.
   *
   * @param {UrlbarResult} result
   * @param {string} command
   * @param {Event} event
   * @returns {boolean} Whether the list closes, as the address bar's view
   *   does for a command that opens something.
   */
  #pickMenuCommand(result, command, event) {
    const window = this.#window;
    this.#engage(result, {
      selType: command,
      element: { dataset: { command } },
      isSessionOngoing: command == MENU.DISMISS,
    });
    if (command == MENU.MANAGE) {
      window.openPreferences("search-locationBar");
      return true;
    }
    if (command != MENU.HELP || !result.payload.helpUrl) {
      return false;
    }
    let where = window.gURLBar._whereToOpen(event);
    if (where == "current") {
      where = "tab";
    }
    lazy.SvalLauncherEnter.open(window, result.payload.helpUrl, where, {
      allowInheritPrincipal: false,
      private: this.#isPrivate,
      targetBrowser: this.#browser,
    });
    return true;
  }

  /**
   * Opens what the page picked, where the address bar would open it, through
   * the functions the address bar picks with (`launcher-enter.patch`), at
   * the place the address bar's own `UrlbarInput._whereToOpen` answers for
   * the same keys or click.
   *
   * A pick by index is a row of the page's latest query; one of any other
   * query does nothing. Enter with no row, on text whose query has not
   * answered yet, picks the heuristic of the latest query's text, as the
   * address bar does (`UrlbarUtils.getHeuristicResultFor`): the text this
   * side was asked for, never what the pick says the field holds.
   *
   * @param {object} data
   * @param {number} data.id The query the row belongs to, or -1 for none.
   * @param {number} data.list Which of the query's lists the row is in.
   * @param {number} data.index The row's result index.
   * @param {object} data.modifiers The pick's keys, and a click's button.
   */
  async #pick({ id, list, index, modifiers = {} }) {
    const window = this.#window;
    const browser = this.#browser;
    if (!window || !browser || !this.#shown()) {
      return;
    }
    const controller = this.#urlbarController;
    const searchString = this.#last?.context.searchString ?? "";
    let result = null;
    if (id !== -1) {
      result = this.#resultAt(id, list, index);
      if (!result) {
        return;
      }
    } else {
      if (!searchString.trim()) {
        return;
      }
      result = await lazy.UrlbarUtils.getHeuristicResultFor(searchString, {
        window,
        isPrivate: this.#isPrivate,
        sapName: SAP_NAME,
        controller,
        searchMode: this.#searchMode,
      });
      if (!this.#shown()) {
        return;
      }
    }
    controller.cancelQuery();
    const tab = window.gBrowser.getTabForBrowser(browser);

    // A command's row has no address: it runs whatever the modifiers, as the
    // address bar hands it to its provider (`UrlbarInput.pickResult`).
    if (result.providerName === lazy.COMMANDS_PROVIDER) {
      lazy.SvalLauncherCommands.stopChoosing(controller.input);
      lazy.SvalLauncherCommands.run(window, result.payload, {
        shift: !!modifiers.shiftKey,
      }).catch(err =>
        lazy.SvalLog.error(`a command failed: ${lazy.describeError(err)}`)
      );
      return;
    }

    const { RESULT_TYPE } = lazy.UrlbarUtils;
    if (result.payload.providesSearchMode) {
      const mode = searchModeFor(
        result,
        this.#isPrivate,
        SEARCH_MODE_ENTRIES[result.providerName] ?? "keywordoffer"
      );
      if (mode) {
        await this.#enterSearchMode(
          mode,
          result.payload.query?.trimStart() || ""
        );
      }
      return;
    }
    // A tip's button, and a row a provider draws that loads nothing, are
    // the provider's to act on (`UrlbarInput.pickResult`).
    const ownUrl = lazy.UrlbarUtils.getUrlFromResult(result).url;
    if (
      !ownUrl &&
      (result.type == RESULT_TYPE.TIP || result.type == RESULT_TYPE.DYNAMIC)
    ) {
      const element =
        result.type == RESULT_TYPE.DYNAMIC
          ? (this.#last?.elements.get(list)?.get(index) ?? null)
          : null;
      this.#engage(result, {
        element,
        selType:
          result.type == RESULT_TYPE.TIP
            ? "tip"
            : controller.engagementEvent.typeFromElement(result, element),
      });
      return;
    }

    const event = pickEvent(window, modifiers);
    const where = window.gURLBar._whereToOpen(event, result);

    if (result.payload.svalNodeId) {
      lazy.SvalLauncherEnter.pickTab(window, result, tab, where);
      return;
    }
    if (
      result.type === lazy.UrlbarUtils.RESULT_TYPE.URL &&
      lazy.SvalLauncherEnter.pickFavorite(
        controller.input,
        result,
        where,
        event
      )
    ) {
      return;
    }

    const { url, postData } = lazy.UrlbarUtils.getUrlFromResult(result);
    if (!url) {
      return;
    }

    // Every pick of a switch-to-tab row switches, as in the address bar,
    // which sets no `action-override` (`launcher-enter.patch`).
    if (result.type == lazy.UrlbarUtils.RESULT_TYPE.TAB_SWITCH) {
      const switched = window.switchToTabHavingURI(
        Services.io.newURI(url),
        true,
        {},
        lazy.UrlbarProviderOpenTabs.isNonPrivateUserContextId(
          result.payload.userContextId
        )
          ? result.payload.userContextId
          : null
      );
      if (switched && tab?.isEmpty) {
        window.gBrowser.removeTab(tab);
      }
      return;
    }

    if (
      !this.#isPrivate &&
      !result.heuristic &&
      result.type != lazy.UrlbarUtils.RESULT_TYPE.SEARCH
    ) {
      lazy.UrlbarUtils.addToInputHistory(url, searchString).catch(err =>
        lazy.SvalLog.warn(
          `input history was not recorded: ${lazy.SvalLog.errorName(err)}`
        )
      );
    }

    lazy.SvalLauncherEnter.open(
      window,
      url,
      lazy.SvalLauncherEnter.whereToLoad(window, url, where, browser),
      {
        postData,
        allowInheritPrincipal: false,
        private: this.#isPrivate,
        targetBrowser: browser,
        // A pick's new tab comes to the front, as `UrlbarInput.pickResult`
        // asks for any pick but its context menu's.
        forceForeground: true,
      }
    );
  }
}
