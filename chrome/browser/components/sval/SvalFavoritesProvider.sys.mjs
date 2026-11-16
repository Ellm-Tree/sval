/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Favorites in the address bar (favorites-native spec §5.2). Places holds no
 * bookmarks of Sval's, so `UrlbarProviderPlaces` finds no favorite and
 * `UrlbarProviderAutofill` fills none. Two providers on the address bar's
 * providers manager put them back, as Firefox's own views, muxer, search mode
 * and restriction tokens expect bookmarks:
 *
 * - `SvalFavorites` answers each query with the favorites that match it,
 *   each a URL result whose source is `RESULT_SOURCE.BOOKMARKS`, so the row
 *   wears the star (`UrlbarView`'s `type="bookmark"`), `*` and the Favorites
 *   search mode reach it, and the muxer drops the history row of the same
 *   address in its favour. A favorite with history also comes from
 *   `UrlbarProviderPlaces` and `UrlbarProviderInputHistory`, and from
 *   `UrlbarProviderTopSites` when nothing is typed. Each asks `nameOf` and
 *   gives the row the same source, so whichever row the muxer keeps has
 *   the star.
 * - `SvalFavoritesAutofill` fills a favorite's origin, else its address, as
 *   Firefox fills a bookmarked one regardless of how often it was visited,
 *   whenever Firefox's own autofill has nothing (`favorites-autofill-group.patch`
 *   gives it Firefox's autofill group).
 *
 * The home page's field reaches both: it queries the same manager
 * (`SvalHomeSearchParent`).
 *
 * In the address bar the rows are the Pins and Favorites section (launcher
 * spec §5): the pins the window's row shows first, then other Favorites. A
 * pin's row stands for its page, open or not, and Enter on it shows the
 * pin's page as a click on the pin does; Enter on a Favorite's row opens it
 * as the Favorites menu does (`SvalLauncherEnter`).
 *
 * **No query, name or address is ever logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import {
  UrlbarProvider,
  UrlbarUtils,
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import {
  guidsOf,
  pinOf,
} from "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  ProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  SvalFavoriteIcons:
    "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
  UrlbarTokenizer:
    "moz-src:///browser/components/urlbar/UrlbarTokenizer.sys.mjs",
  UrlUtils: "resource://gre/modules/UrlUtils.sys.mjs",
});

/** Places' `MAX_CHARS_TO_SEARCH_THROUGH`: how much of a name or address is matched. */
const MAX_CHARS_TO_SEARCH = 255;

/** How many addresses one frecency query binds. */
const FRECENCY_CHUNK = 400;

const MS_PER_DAY = 86_400_000;

/** The groups of the Pins and Favorites section, which the layout names. */
export const PINS_GROUP = "sval-pins";
export const FAVORITES_GROUP = "sval-favorites";

/** The Favorites provider's name, which its results carry as `providerName`. */
export const FAVORITES_PROVIDER = "SvalFavorites";

/** The favorite each row stands for, by its result, and whether it is a pin. */
const favoriteRows = new WeakMap();

/**
 * The pins a window's row shows, in its workspace.
 *
 * @param {Window|null} win
 * @returns {object[]} its slots, pinned folders among them.
 */
function pinsOf(win) {
  return win?.SvalPanel?.pins?.slots ?? [];
}

/**
 * Folds a string as Places' matching does: case and diacritics ignored
 * (`MatchAutoCompleteFunction` with diacritics unmatched). Sval's open-tab
 * rows match with it too (`SvalLauncherTabs`), so a word finds a tab as it
 * finds a favorite.
 *
 * @param {string} text
 * @returns {string}
 */
export function fold(text) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Whether `token`, folded, occurs in `source` at a word boundary, as Places'
 * `MATCH_BOUNDARY` finds it (`findOnBoundary` in `SQLFunctions.cpp`): at the
 * start, or where the character found is not a lowercase ASCII letter that
 * follows another ASCII letter, which also matches CamelCase words.
 *
 * @param {string} token Already folded.
 * @param {string} source
 * @returns {boolean}
 */
export function onBoundary(token, source) {
  if (!token) {
    return true;
  }
  const original = source.slice(0, MAX_CHARS_TO_SEARCH).normalize("NFD");
  const bare = original.replace(/\p{M}/gu, "");
  const folded = bare.toLowerCase();
  for (let at = folded.indexOf(token); at >= 0; ) {
    const here = bare[at];
    const before = at > 0 ? bare[at - 1].toLowerCase() : "";
    const inWord = /[a-z]/.test(here) && /[a-z]/.test(before);
    if (!inWord) {
      return true;
    }
    at = folded.indexOf(token, at + 1);
  }
  return false;
}

/**
 * The address as Places matches it (`fixupURISpec`): unescaped where that
 * yields text, and without an `http://`, `https://` or `ftp://` prefix.
 *
 * @param {string} url
 * @returns {string}
 */
export function matchableUrl(url) {
  let spec = url;
  try {
    spec = decodeURI(url);
  } catch {
    // Not escaped text; matched as it is.
  }
  return spec.replace(/^(https?|ftp):\/\//i, "");
}

/** The Places frecency column in use, as `UrlbarProviderPlaces` picks it. */
function frecencyField() {
  return lazy.PlacesUtils.history.isAlternativeFrecencyEnabled
    ? "alt_frecency"
    : "frecency";
}

/**
 * The frecency Places gives a bookmarked page with no visits: one sample at
 * the bookmark's date with the high weight (`calculate_frecency`'s `bookmark`
 * samples), which comes to that day plus how many half-lives the weight
 * takes to decay to one.
 *
 * @param {number} addedAt Milliseconds since the epoch.
 * @param {number} [decay] As {@link frecencyDecay} answers.
 * @returns {number}
 */
function unvisitedFrecency(addedAt, decay = frecencyDecay()) {
  return Math.floor(addedAt / MS_PER_DAY) + decay;
}

/**
 * The days {@link unvisitedFrecency} adds to a bookmark's day: how many
 * half-lives its weight takes to decay to one. Read once for a whole query,
 * since it reads two prefs.
 *
 * @returns {number}
 */
function frecencyDecay() {
  const branch =
    frecencyField() === "alt_frecency"
      ? "places.frecency.pages.alternative."
      : "places.frecency.pages.";
  const weight = Services.prefs.getIntPref(`${branch}highWeight`, 100);
  const halfLife = Services.prefs.getIntPref(`${branch}halfLifeDays`, 30);
  return Math.trunc((Math.log(weight) * halfLife) / Math.LN2);
}

/**
 * Each address's frecency in Places, for the addresses it holds.
 *
 * @param {string[]} urls
 * @returns {Promise<Map<string, number>>}
 */
async function pageFrecencies(urls) {
  const found = new Map();
  if (!urls.length) {
    return found;
  }
  const db = await lazy.PlacesUtils.promiseLargeCacheDBConnection();
  const field = frecencyField();
  for (let i = 0; i < urls.length; i += FRECENCY_CHUNK) {
    const chunk = urls.slice(i, i + FRECENCY_CHUNK);
    const rows = await db.execute(
      `SELECT url, ${field} AS frecency FROM moz_places
        WHERE url_hash IN (${lazy.PlacesUtils.sqlBindPlaceholders(chunk, "hash(", ")")})
          AND url IN (${lazy.PlacesUtils.sqlBindPlaceholders(chunk)})`,
      [...chunk, ...chunk]
    );
    for (const row of rows) {
      found.set(row.getResultByName("url"), row.getResultByName("frecency"));
    }
  }
  return found;
}

/**
 * The score the muxer orders a favorite's row by (`orderBy: "frecency"`):
 * its page's own frecency, raised to an unvisited bookmark's when that is
 * higher. Half a point above the page's own keeps the favorite's row ahead
 * of its page's history row, which the muxer then drops as the same address
 * from another provider.
 *
 * @param {object} row A favorite, as the store reads it.
 * @param {Map<string, number>} frecencies
 * @param {number} [decay] As {@link frecencyDecay} answers.
 * @returns {number}
 */
function scoreOf(row, frecencies, decay = frecencyDecay()) {
  return (
    Math.max(
      frecencies.get(row.url) ?? 0,
      unvisitedFrecency(row.added, decay)
    ) + 0.5
  );
}

/**
 * The favorites a query may offer: every favorite with an address no other
 * device wrote for this one to refuse (`refused`), without bookmarklets while
 * `browser.urlbar.filter.javascript` keeps them out.
 *
 * @returns {object[]}
 */
function candidates() {
  const filterJs = lazy.UrlbarPrefs.get("filter.javascript");
  return (lazy.SvalFavoritesStore.readyInstance?.all() ?? []).filter(
    row =>
      row.kind === "favorite" &&
      row.url &&
      !row.refused &&
      !(filterJs && URL.parse(row.url)?.protocol === "javascript:")
  );
}

/** The favorites that match a query, as `UrlbarProviderPlaces` matches. */
export class SvalFavoritesUrlbarProvider extends UrlbarProvider {
  get name() {
    return FAVORITES_PROVIDER;
  }

  get type() {
    return UrlbarUtils.PROVIDER_TYPE.PROFILE;
  }

  /**
   * The query's words, without restriction characters, and which of name and
   * address `#` and `$` limit them to.
   *
   * @param {object} queryContext
   * @returns {{words: string[], title: boolean, url: boolean}}
   */
  static #terms(queryContext) {
    const { TOKEN_TYPE } = lazy.UrlbarShared;
    const tokens = queryContext.tokens ?? [];
    const words = tokens
      .filter(t => !lazy.UrlbarTokenizer.isRestrictionToken(t))
      .map(t => fold(t.value));
    return {
      words,
      title: tokens.some(t => t.type === TOKEN_TYPE.RESTRICT_TITLE),
      url: tokens.some(t => t.type === TOKEN_TYPE.RESTRICT_URL),
    };
  }

  /**
   * Whether the query asks for favorites only: the Favorites search mode, or
   * `*` typed.
   *
   * @param {object} queryContext
   * @returns {boolean}
   */
  static #favoritesOnly(queryContext) {
    const { BOOKMARKS } = UrlbarUtils.RESULT_SOURCE;
    return (
      queryContext.restrictSource === BOOKMARKS ||
      queryContext.searchMode?.source === BOOKMARKS ||
      (queryContext.tokens ?? []).some(
        t => t.type === lazy.UrlbarShared.TOKEN_TYPE.RESTRICT_BOOKMARK
      )
    );
  }

  async isActive(queryContext) {
    if (
      !lazy.SvalFavoritesStore.readyInstance ||
      !queryContext.sources?.includes(UrlbarUtils.RESULT_SOURCE.BOOKMARKS)
    ) {
      return false;
    }
    if (
      !queryContext.trimmedSearchString &&
      queryContext.searchMode?.engineName
    ) {
      return false;
    }
    // An empty query lists favorites where Places would list bookmarks: in
    // the Favorites search mode, after `*`, or as the empty search's default
    // when history is not suggested (`#emptySearchDefaultBehavior`).
    if (!SvalFavoritesUrlbarProvider.#terms(queryContext).words.length) {
      return (
        SvalFavoritesUrlbarProvider.#favoritesOnly(queryContext) ||
        !lazy.UrlbarPrefs.get("suggest.history")
      );
    }
    return true;
  }

  async startQuery(queryContext, addCallback, controller) {
    const instance = this.queryInstance;
    const pins = new Set(
      pinsOf(controller?.browserWindow ?? null).flatMap(guidsOf)
    );
    const { words, title, url } =
      SvalFavoritesUrlbarProvider.#terms(queryContext);
    const matches = candidates().filter(row => {
      const address = matchableUrl(row.url);
      return words.every(word => {
        const inTitle = onBoundary(word, row.name);
        const inUrl = onBoundary(word, address);
        if (title && url) {
          return inTitle && inUrl;
        }
        if (title) {
          return inTitle;
        }
        if (url) {
          return inUrl;
        }
        return inTitle || inUrl;
      });
    });
    if (!matches.length) {
      return;
    }
    const frecencies = await pageFrecencies([
      ...new Set(matches.map(row => row.url)),
    ]);
    if (instance !== this.queryInstance) {
      return;
    }
    const seen = new Set();
    const decay = frecencyDecay();
    const ranked = matches
      .map(row => ({
        row,
        score: scoreOf(row, frecencies, decay),
        pin: pins.has(row.guid),
      }))
      .sort((a, b) => b.pin - a.pin || b.score - a.score);
    for (const { row, score, pin } of ranked) {
      // One row per address, as Places has one per page; a pin's first.
      if (seen.has(row.url)) {
        continue;
      }
      seen.add(row.url);
      if (seen.size > queryContext.maxResults) {
        break;
      }
      const result = new lazy.UrlbarResult({
        type: UrlbarUtils.RESULT_TYPE.URL,
        source: UrlbarUtils.RESULT_SOURCE.BOOKMARKS,
        group: pin ? PINS_GROUP : FAVORITES_GROUP,
        rowLabel: { id: "launcher-section-favorites" },
        payload: {
          url: row.url,
          title: row.name,
          icon:
            lazy.SvalFavoriteIcons.iconFor(row.url) ??
            UrlbarUtils.getIconForUrl(row.url),
          tags: [],
          frecency: score,
        },
        highlights: {
          url: UrlbarUtils.HIGHLIGHT.TYPED,
          title: UrlbarUtils.HIGHLIGHT.TYPED,
          tags: UrlbarUtils.HIGHLIGHT.TYPED,
        },
      });
      favoriteRows.set(result, {
        favorite: { guid: row.guid, url: row.url, name: row.name },
        pin,
      });
      addCallback(this, result);
    }
  }
}

/**
 * Fills a favorite's origin, then its address, into the address bar as
 * `UrlbarProviderAutofill` fills a bookmarked one: on the same conditions,
 * to the same extent (an origin whole, an address to its next slash), and
 * only when that provider found nothing, whose result reaches the group
 * first: it adds its result from the start of `startQuery`, and this one
 * only after a turn, and the group shows one.
 */
export class SvalFavoritesAutofillProvider extends UrlbarProvider {
  #result = null;

  get name() {
    return "SvalFavoritesAutofill";
  }

  get type() {
    return UrlbarUtils.PROVIDER_TYPE.HEURISTIC;
  }

  async isActive(queryContext) {
    this.#result = null;
    if (
      !lazy.SvalFavoritesStore.readyInstance ||
      !lazy.UrlbarPrefs.get("autoFill") ||
      !queryContext.allowAutofill ||
      queryContext.tokens.length !== 1 ||
      queryContext.searchString.length > UrlbarUtils.MAX_TEXT_LENGTH ||
      lazy.UrlUtils.REGEXP_SPACES.test(queryContext.searchString)
    ) {
      return false;
    }
    const { TOKEN_TYPE } = lazy.UrlbarShared;
    if (
      queryContext.tokens.some(
        t =>
          t.type === TOKEN_TYPE.RESTRICT_TAG ||
          t.type === TOKEN_TYPE.RESTRICT_TITLE
      )
    ) {
      return false;
    }
    const { HISTORY, BOOKMARKS } = UrlbarUtils.RESULT_SOURCE;
    if (!queryContext.sources.includes(BOOKMARKS)) {
      return false;
    }
    // With history and adaptive autofill both on, Firefox's queries fill no
    // bookmark for being one (`QUERY_ORIGIN_HISTORY_BOOKMARK`'s
    // `adaptiveAutofillEnabled = 0` clauses).
    if (
      queryContext.sources.includes(HISTORY) &&
      Services.prefs.getBoolPref("places.history.enabled", true) &&
      lazy.UrlbarPrefs.get("autoFill.adaptiveHistory.enabled")
    ) {
      return false;
    }
    const result = await this.#find(queryContext);
    if (!result) {
      return false;
    }
    this.#result = result;
    return true;
  }

  async startQuery(queryContext, addCallback) {
    const instance = this.queryInstance;
    const result = this.#result;
    this.#result = null;
    await null;
    if (result && instance === this.queryInstance) {
      addCallback(this, result);
    }
  }

  cancelQuery() {
    this.#result = null;
  }

  /**
   * @param {object} queryContext
   * @returns {Promise<UrlbarResult|null>}
   */
  async #find(queryContext) {
    let [prefix, rest] = UrlbarUtils.stripURLPrefix(queryContext.searchString);
    prefix = prefix.toLowerCase();
    if (!rest.length) {
      return null;
    }
    const web = candidates().filter(row => /^(https?|ftp):\/\//i.test(row.url));
    if (!web.length) {
      return null;
    }
    if (
      lazy.UrlUtils.looksLikeOrigin(rest, {
        ignoreKnownDomains: true,
        allowPartialNumericalTLDs: true,
      })
    ) {
      return this.#origin(queryContext, prefix, rest, web);
    }
    return this.#address(queryContext, prefix, rest, web);
  }

  /**
   * `rows`, best first: by score, then an https address before another.
   * Only the rows a query can fill are scored, since each score is a lookup
   * in Places.
   *
   * @param {object[]} rows Candidate favorites.
   * @returns {Promise<object[]>}
   */
  static async #ranked(rows) {
    if (!rows.length) {
      return rows;
    }
    const frecencies = await pageFrecencies([
      ...new Set(rows.map(row => row.url)),
    ]);
    const decay = frecencyDecay();
    return rows
      .map(row => ({ row, score: scoreOf(row, frecencies, decay) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.row.url.startsWith("https://") - a.row.url.startsWith("https://")
      )
      .map(({ row }) => row);
  }

  /**
   * An origin: a favorite whose host, or the host without `www.`, starts
   * with what was typed, filled to that host and a slash.
   *
   * @param {object} queryContext
   * @param {string} prefix The scheme typed, lowercased, or "".
   * @param {string} rest What was typed after it.
   * @param {object[]} rows Candidate favorites.
   * @returns {Promise<UrlbarResult|null>}
   */
  async #origin(queryContext, prefix, rest, rows) {
    const typed = (rest.endsWith("/") ? rest.slice(0, -1) : rest).toLowerCase();
    const shownOf = row => {
      const url = URL.parse(row.url);
      if (!url || (prefix && !`${url.protocol}//`.startsWith(prefix))) {
        return null;
      }
      const host = url.host.toLowerCase();
      const fixed = host.replace(/^www\./, "");
      if (host.startsWith(typed)) {
        return { url, host, shown: host };
      }
      if (fixed.startsWith(typed)) {
        return { url, host, shown: fixed };
      }
      return null;
    };
    const ranked = await SvalFavoritesAutofillProvider.#ranked(
      rows.filter(row => shownOf(row))
    );
    for (const row of ranked) {
      const { url, host, shown } = shownOf(row);
      const completed = `${prefix || `${url.protocol}//`}${host}/`;
      const named = lazy.SvalFavoritesStore.readyInstance
        ?.favoritesWithUrl(completed)
        .find(f => f.name)?.name;
      return this.#make(queryContext, rest, `${shown}/`, completed, {
        type: "origin",
        title: named ?? null,
      });
    }
    return null;
  }

  /**
   * An address: a favorite whose address, without its scheme and any user
   * name, starts with what was typed, filled to its next slash.
   *
   * @param {object} queryContext
   * @param {string} prefix The scheme typed, lowercased, or "".
   * @param {string} rest What was typed after it.
   * @param {object[]} rows Candidate favorites.
   * @returns {Promise<UrlbarResult|null>}
   */
  async #address(queryContext, prefix, rest, rows) {
    const host = /^[^/:?]+/.exec(rest)?.[0]?.toLowerCase();
    if (!host) {
      return null;
    }
    let stripped = queryContext.trimmedSearchString;
    if (prefix) {
      stripped = stripped.substr(prefix.length);
    }
    stripped = host + stripped.substr(host.length);
    const bare = url =>
      url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/@]*@/, "");
    const lower = stripped.toLowerCase();
    const matches = row => {
      if (prefix && !row.url.toLowerCase().startsWith(prefix)) {
        return false;
      }
      const ls = bare(row.url).toLowerCase();
      return ls.startsWith(lower) || ls.startsWith(`www.${lower}`);
    };
    const ranked = await SvalFavoritesAutofillProvider.#ranked(
      rows.filter(matches)
    );
    let best = null;
    for (const row of ranked) {
      const s = bare(row.url);
      const ls = s.toLowerCase();
      if (ls === lower || ls === `www.${lower}`) {
        best = { row, s };
        break;
      }
      best ??= { row, s };
    }
    if (!best) {
      return null;
    }
    const { row } = best;
    const strippedUrl = best.s.toLowerCase().startsWith(lower)
      ? stripped
      : `www.${stripped}`;
    if (!UrlbarUtils.canAutofillURL(row.url, strippedUrl, true)) {
      return null;
    }
    const at = row.url.toLowerCase().indexOf(strippedUrl.toLowerCase());
    const start = row.url.substr(0, at);
    const slash = row.url.indexOf("/", at + strippedUrl.length - 1);
    const fixed =
      slash < 0 ? row.url.substr(at) : row.url.substring(at, slash + 1);
    const completed = start + fixed;
    const shown =
      strippedUrl.startsWith("www.") && !rest.startsWith("www.")
        ? fixed.replace(/^www\./i, "")
        : fixed;
    return this.#make(queryContext, rest, shown, completed, {
      type: "url",
      title: completed === row.url ? row.name : null,
    });
  }

  /**
   * The autofill result, as `UrlbarProviderAutofill._processRow` makes one:
   * what was typed, in the case typed, then the rest of `fixed`.
   *
   * @param {object} queryContext
   * @param {string} rest What was typed after any scheme.
   * @param {string} fixed The address as filled, without its scheme.
   * @param {string} url The address the result opens.
   * @param {object} what
   * @param {string} what.type `origin` or `url`.
   * @param {string|null} what.title The favorite's name, when it is the
   *   address filled.
   * @returns {UrlbarResult}
   */
  #make(queryContext, rest, fixed, url, { type, title }) {
    const value = queryContext.searchString + fixed.substring(rest.length);
    let fallbackTitle = title;
    if (!fallbackTitle) {
      const trimHttps = lazy.UrlbarPrefs.getScotchBonnetPref("trimHttps");
      [fallbackTitle] = UrlbarUtils.stripPrefixAndTrim(
        UrlbarUtils.prepareUrlForDisplay(url, { trimURL: false }),
        {
          stripHttp: !trimHttps,
          stripHttps: trimHttps,
          trimEmptyQuery: true,
          trimSlash: !rest.includes("/"),
        }
      );
    }
    return new lazy.UrlbarResult({
      type: UrlbarUtils.RESULT_TYPE.URL,
      source: UrlbarUtils.RESULT_SOURCE.HISTORY,
      heuristic: true,
      autofill: {
        value,
        selectionStart: queryContext.searchString.length,
        selectionEnd: value.length,
        type,
        noVisitAction: !!title,
      },
      payload: {
        url,
        title: fallbackTitle,
        icon:
          lazy.SvalFavoriteIcons.iconFor(url) ?? UrlbarUtils.getIconForUrl(url),
      },
      highlights: {
        url: UrlbarUtils.HIGHLIGHT.TYPED,
        title: UrlbarUtils.HIGHLIGHT.TYPED,
        fallbackTitle: UrlbarUtils.HIGHLIGHT.TYPED,
      },
    });
  }
}

export const SvalFavoritesProvider = {
  /**
   * What a page whose address is a favorite is named in the address bar: the
   * favorite's name, "" for a favorite without one, or null when no favorite
   * has the address. Firefox's providers ask it where they look a page up
   * in `moz_bookmarks` (`favorites-history-rows.patch`), and the view asks
   * it of a switch-to-tab row (`favorites-open-tab-star.patch`), so a
   * favorite's row wears the star as a bookmarked page's does.
   *
   * @param {string} url
   * @returns {string|null}
   */
  nameOf(url) {
    const found =
      lazy.SvalFavoritesStore.readyInstance?.favoritesWithUrl(url) ?? [];
    if (!found.length) {
      return null;
    }
    return found.find(row => row.name)?.name ?? "";
  },

  /**
   * The favorite a row of `SvalFavorites` stands for, pin or not.
   *
   * @param {UrlbarResult} result
   * @returns {{guid: string, url: string, name: string}|null}
   */
  favoriteOf(result) {
    return favoriteRows.get(result)?.favorite ?? null;
  },

  /**
   * Shows the pin a pin row stands for, through the pins row's own select,
   * as a click on the pin does (launcher spec §3), after putting the field
   * back to the address of the tab it was typed in.
   *
   * @param {object} input The `UrlbarInput` the row was picked in.
   * @param {UrlbarResult} result
   * @returns {boolean} Whether the row was a pin the window's row still
   *   shows; otherwise Firefox opens its address.
   */
  pickPin(input, result) {
    const row = favoriteRows.get(result);
    const guid = row?.pin ? row.favorite.guid : null;
    const pins = input.window.SvalPanel?.pins;
    const pin = guid && pins ? pinOf(pins.slots, guid) : null;
    if (!pin) {
      return false;
    }
    input.handleRevert();
    pins.select(pin);
    return true;
  },

  /**
   * Registers both providers on the address bar's providers manager, once
   * for the process, before any window queries it.
   */
  register() {
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    for (const provider of [
      new SvalFavoritesUrlbarProvider(),
      new SvalFavoritesAutofillProvider(),
    ]) {
      if (!manager.getProvider(provider.name)) {
        manager.registerProvider(provider);
      }
    }
  },
};
