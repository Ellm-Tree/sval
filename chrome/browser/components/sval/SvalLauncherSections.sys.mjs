/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The address bar's rows in fixed sections (launcher spec §5, §6).
 *
 * The muxer places each row by its group, and the groups' layout comes from
 * `UrlbarPrefs`' `makeDefaultResultGroups` alone, with no pref for it.
 * `launcher-sections.patch` hands Firefox's layout to {@link
 * SvalLauncherSections.resultGroups}, which keeps its top area and lists
 * after it the sections in the order of `browser.sval.launcher.order`, each
 * capped at its limit. The top area (spec §5) is Firefox's row Enter takes:
 * the search for what was typed, or the visit when it is an address. When
 * an open tab matches strongly, Open tabs follows it there (spec §3). Then
 * come the extensions' rows and the pages picked before for what is typed
 * (input history), under Firefox's own cap. History and Search suggestions are Firefox's general and
 * suggestions groups, input history aside. Headings come from the section a
 * row's group is in.
 *
 * The limits hold while something is typed outside a search mode. With
 * nothing typed, in a search mode, after a restriction character, with `@`
 * alone, which lists every search mode (`UrlbarProviderRestrictKeywords`,
 * `UrlbarProviderTokenAliasEngines`), or in a command's list of choices, a
 * section has no limit of its own and the list holds as many rows as the
 * query asks for ({@link SvalLauncherSections.maxResults}).
 *
 * A row shows once, in the first place it qualifies for (spec §5). Firefox
 * keeps one row per page (`UrlbarMuxerStandard._canAddResult`), letting an
 * open tab's row stand for its page's history, Favorite rows included, and
 * of two rows of one address the one it reads first. The muxer reads the
 * results as {@link SvalLauncherSections.unsorted} hands them over.
 */

import { UrlbarUtils } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import {
  SECTION_LIMIT_PREFS,
  launcherLimit,
  launcherOrder,
} from "moz-src:///browser/components/sval/SvalLauncherPrefs.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  COMMANDS_GROUP:
    "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs",
  FAVORITES_GROUP:
    "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs",
  FAVORITES_PROVIDER:
    "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs",
  FREQUENT_SITES: "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs",
  FREQUENT_SITES_GROUP:
    "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs",
  PINS_GROUP:
    "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs",
  RECENT_TABS: "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs",
  RECENT_TABS_GROUP:
    "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs",
  TABS_GROUP: "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs",
  TABS_TOP_GROUP: "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
});

/** The address bar's providers manager, which Home's field shares. */
const SAP_NAME = "urlbar";

/** Each section's heading (`sval/launcher.ftl`). */
const HEADINGS = Object.freeze({
  tabs: "launcher-section-tabs",
  favorites: "launcher-section-favorites",
  commands: "launcher-section-commands",
  history: "launcher-section-history",
  suggestions: "launcher-section-suggestions",
});

/**
 * Whether a query's sections are capped at their limits.
 *
 * @param {object} context
 * @returns {boolean}
 */
function limited(context) {
  return (
    !!context.trimmedSearchString &&
    context.trimmedSearchString !== "@" &&
    !context.searchMode &&
    !context.restrictSource &&
    !context.providers
  );
}

/**
 * The section key of the layout's group holding `group`, or null when it is
 * in the top area or nowhere.
 *
 * @param {object} node A layout group.
 * @param {string} group
 * @param {string|null} [section] The section `node` is in.
 * @returns {string|null|undefined} undefined when `node` has no `group`.
 */
function sectionOf(node, group, section = null) {
  const here = node.svalSection ?? section;
  if (node.group === group && !node.children) {
    return here;
  }
  for (const child of node.children ?? []) {
    const found = sectionOf(child, group, here);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export const SvalLauncherSections = {
  /**
   * What `UrlbarPrefs.getResultGroups` adds to its cache key, so a layout is
   * made again when the order or a limit changes or the limits lift.
   *
   * @param {object} context The query context.
   * @returns {string}
   */
  cacheKey(context) {
    if (context.sapName !== SAP_NAME) {
      return "";
    }
    if (!limited(context)) {
      return "|sval-unlimited";
    }
    const order = launcherOrder();
    return `|sval:${order.map(key => `${key}=${launcherLimit(SECTION_LIMIT_PREFS[key])}`).join(",")}`;
  },

  /**
   * The address bar's layout: Firefox's top area, Recent tabs and Frequent
   * sites for the empty address bar, then the sections in their order.
   *
   * @param {object} firefox What `makeDefaultResultGroups` made: the
   *   heuristic group, the extensions' group, then a group of suggestions
   *   and general.
   * @param {object} context The query context.
   * @returns {object} The root group.
   */
  resultGroups(firefox, context) {
    const { GENERAL_PARENT, INPUT_HISTORY } = UrlbarUtils.RESULT_GROUP;
    const isMain = child =>
      child.children?.some(c => c.group === GENERAL_PARENT);
    const [heuristic, ...rest] = firefox.children;
    const main = rest.find(isMain);
    const top = rest.filter(child => child !== main);
    const general = main.children.find(c => c.group === GENERAL_PARENT);
    const suggestions = main.children.find(c => c !== general);
    // Firefox lists input history first, under its cap, then any more after
    // the other history; the top area keeps the first.
    const inputHistory = general.children.find(c => c.group === INPUT_HISTORY);
    const history = {
      ...general,
      children: general.children.filter(c => c.group !== INPUT_HISTORY),
    };

    const contents = {
      tabs: [{ group: lazy.TABS_GROUP }],
      favorites: [{ group: lazy.PINS_GROUP }, { group: lazy.FAVORITES_GROUP }],
      commands: [{ group: lazy.COMMANDS_GROUP }],
      history: [history],
      suggestions: [suggestions],
    };
    const capped = limited(context);
    const sections = launcherOrder().map(key => ({
      svalSection: key,
      ...(capped
        ? { maxResultCount: launcherLimit(SECTION_LIMIT_PREFS[key]) }
        : {}),
      children: contents[key],
    }));
    return {
      children: [
        heuristic,
        { group: lazy.TABS_TOP_GROUP },
        ...top,
        inputHistory,
        { group: lazy.RECENT_TABS_GROUP, maxResultCount: lazy.RECENT_TABS },
        {
          group: lazy.FREQUENT_SITES_GROUP,
          maxResultCount: lazy.FREQUENT_SITES,
        },
        ...sections,
      ],
    };
  },

  /**
   * How many rows a query of `sapName` may hold: Firefox's
   * `maxRichResults` for the top area, and each section's limit after it.
   *
   * @param {string} sapName
   * @returns {number}
   */
  maxResults(sapName) {
    const rows = lazy.UrlbarPrefs.get("maxRichResults");
    if (sapName !== SAP_NAME) {
      return rows;
    }
    return launcherOrder().reduce(
      (sum, key) => sum + launcherLimit(SECTION_LIMIT_PREFS[key]),
      rows
    );
  },

  /**
   * The heading above a row, for `UrlbarView`'s `#rowLabel` and Home's
   * field: the row's own, as Sval's rows name theirs, else its section's,
   * and null in the top area. Undefined where Firefox's own labels apply:
   * outside the address bar, and for Firefox's rows while nothing is typed.
   *
   * @param {UrlbarResult} result
   * @param {object|null} queryContext
   * @returns {{id: string}|null|undefined}
   */
  rowLabel(result, queryContext) {
    if (queryContext?.sapName !== SAP_NAME) {
      return undefined;
    }
    if (result.rowLabel) {
      return result.rowLabel;
    }
    if (UrlbarUtils.getResultGroup(result) === lazy.FREQUENT_SITES_GROUP) {
      return { id: "launcher-section-frequent-sites" };
    }
    if (!queryContext.trimmedSearchString) {
      return undefined;
    }
    if (result.heuristic) {
      return null;
    }
    const root = lazy.UrlbarPrefs.getResultGroups({ context: queryContext });
    const key = sectionOf(root, UrlbarUtils.getResultGroup(result));
    return key ? { id: HEADINGS[key] } : null;
  },

  /**
   * The results the muxer sorts, as the sections need them (spec §5):
   *
   * - Input history first, so the muxer reads it before another row of
   *   the same page, which it then leaves out.
   * - Without Firefox's switch-to-tab row for a page `SvalFavorites` lists
   *   as a pin. A pin's open tab is its pin's row, and an open tab's row
   *   would drop that row as a dupe.
   * - Without another provider's row for a page `SvalFavorites` lists, such
   *   as its history row starred as a Favorite, which could otherwise be
   *   read first and kept, in History.
   *
   * @param {object} context The query context.
   * @param {UrlbarResult[]} results
   * @returns {UrlbarResult[]}
   */
  unsorted(context, results) {
    if (context.sapName !== SAP_NAME) {
      return results;
    }
    const { TAB_SWITCH, URL: PAGE } = UrlbarUtils.RESULT_TYPE;
    const favorites = new Set();
    const pins = new Set();
    for (const r of results) {
      if (r.providerName === lazy.FAVORITES_PROVIDER) {
        favorites.add(r.payload.url);
        if (r.group === lazy.PINS_GROUP) {
          pins.add(r.payload.url);
        }
      }
    }
    const first = [];
    const rest = [];
    for (const r of results) {
      if (
        (r.type === TAB_SWITCH &&
          !r.payload.svalNodeId &&
          pins.has(r.payload.url)) ||
        (r.type === PAGE &&
          !r.heuristic &&
          r.providerName !== lazy.FAVORITES_PROVIDER &&
          favorites.has(r.payload.url))
      ) {
        continue;
      }
      if (r.providerName === "UrlbarProviderInputHistory") {
        first.push(r);
      } else {
        rest.push(r);
      }
    }
    return [...first, ...rest];
  },
};
