/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The engine an `@` word picks (spec §13 item 3), for Tab, which completes
 * the word (`UrlbarProviderTokenAliasEngines`), and for Space, which ends it
 * (`UrlbarProviderAliasEngines`), so the two keys pick the same engine. A
 * word that is an engine's keyword picks that engine, so `@b` is Bing even
 * though Brave Search's `@br` comes first in the engines' order. Any other
 * word picks the first engine with a keyword it begins, as `@k` picks Kagi.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarSearchUtils:
    "moz-src:///browser/components/urlbar/UrlbarSearchUtils.sys.mjs",
  UrlUtils: "resource://gre/modules/UrlUtils.sys.mjs",
});

export const SvalSearchKeywords = {
  /**
   * The engines in the order a word is matched against them: the engine
   * whose keyword the word is, if any, first, with that keyword first, then
   * the rest in their own order. The first keyword the word begins picks.
   *
   * @param {{engine: object, tokenAliases: string[]}[]} engines
   *   `UrlbarSearchUtils.tokenAliasEngines()`, in its order.
   * @param {string} word The `@` word typed, lower-cased.
   * @returns {{engine: object, tokenAliases: string[]}[]}
   */
  ordered(engines, word) {
    const exact = engines.find(({ tokenAliases }) =>
      tokenAliases.includes(word)
    );
    if (!exact) {
      return engines;
    }
    return [
      {
        ...exact,
        tokenAliases: [word, ...exact.tokenAliases.filter(a => a !== word)],
      },
      ...engines.filter(entry => entry !== exact),
    ];
  },

  /**
   * The engine an `@` word picks once a space ends it.
   *
   * @param {string} word The query's first word.
   * @param {string} searchString The whole query.
   * @returns {Promise<object|null>} The engine, or null for a word that
   *   picks none, or that the query does not start with and a space follow.
   */
  async engineBegun(word, searchString) {
    if (
      !word?.startsWith("@") ||
      !searchString.startsWith(word) ||
      !lazy.UrlUtils.REGEXP_SPACES_START.test(searchString.slice(word.length))
    ) {
      return null;
    }
    const lower = word.toLocaleLowerCase();
    const engines = await lazy.UrlbarSearchUtils.tokenAliasEngines();
    return (
      this.ordered(engines, lower).find(({ tokenAliases }) =>
        tokenAliases.some(alias => alias.startsWith(lower))
      )?.engine ?? null
    );
  },
};
