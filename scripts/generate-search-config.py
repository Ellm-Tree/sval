#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

"""Generate Sval's search engine configuration (Sval spec §10.9, §13 item 3).

Writes chrome/browser/components/sval/SvalSearchConfig.sys.mjs, which
sval-search-config.patch hands to Firefox's engine selector in place of
Mozilla's Remote Settings configuration. Re-run after every ESR rebase:

    ./scripts/generate-search-config.py

Every engine but Wikipedia is defined here, with its URLs taken from the
engine's own OpenSearch description rather than Mozilla's configuration,
because Mozilla's carries partner codes and partner tags (Google's client and
channel, Bing's form, Startpage's segment and partner, DuckDuckGo's t). None
carries a code that identifies Sval or credits anyone.

Wikipedia comes from Mozilla's bundled configuration, because it has a
localised engine per language, minus its sourceid tag.

The engine list itself is a product decision: DuckDuckGo by default, then the
order below. Kagi, Brave Search, GitHub and OpenStreetMap are not in Mozilla's
list; their icons are bundled in chrome/browser/components/sval/search-icons/.
YouTube, GitHub and OpenStreetMap are site searches with no suggestion URL, so
Sval contacts them only when the user searches them (spec §10.9).

Each engine's first alias is a short one, such as "g" for Google, and any
long ones follow it. ConfigSearchEngine puts "@" before every alias, so a
search such as "b vitamins" never picks an engine, and the address bar's "@"
list names each engine by its first alias. Wikipedia's short "w" goes before
the aliases Mozilla gives each language's Wikipedia.
"""

import json
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
MOZILLA_CONFIG = REPO / "build/firefox/services/settings/dumps/main/search-config-v2.json"
OUTPUT = REPO / "chrome/browser/components/sval/SvalSearchConfig.sys.mjs"
PRETTIER = REPO / "build/firefox/node_modules/.bin/prettier"
PRETTIER_CONFIG = REPO / "build/firefox/.prettierrc.js"

DEFAULT = "ddg"
ORDER = [
    "ddg",
    "startpage",
    "brave",
    "kagi",
    "google",
    "bing",
    "ecosia",
    "qwant",
    "perplexity",
    "wikipedia*",
    "youtube",
    "github",
    "openstreetmap",
]

ALL = [{"environment": {"allRegionsAndLocales": True}}]


def url(base, term, params=None):
    entry = {"base": base, "searchTermParamName": term}
    if params:
        entry["params"] = [{"name": k, "value": v} for k, v in params.items()]
    return entry


def engine(identifier, name, aliases, search, suggestions=None, classification="general"):
    urls = {"search": search}
    if suggestions:
        urls["suggestions"] = suggestions
    return {
        "recordType": "engine",
        "identifier": identifier,
        "base": {
            "name": name,
            "aliases": aliases,
            "classification": classification,
            "urls": urls,
        },
        "variants": ALL,
    }


ENGINES = [
    engine(
        "ddg",
        "DuckDuckGo",
        ["ddg", "duckduckgo"],
        url("https://duckduckgo.com/", "q"),
        url("https://duckduckgo.com/ac/", "q", {"type": "list"}),
    ),
    engine(
        "startpage",
        "Startpage",
        ["sp", "startpage"],
        url("https://www.startpage.com/sp/search", "query"),
        url("https://www.startpage.com/osuggestions", "q"),
    ),
    engine(
        "brave",
        "Brave Search",
        ["br", "brave"],
        url("https://search.brave.com/search", "q"),
        url("https://search.brave.com/api/suggest", "q"),
    ),
    engine(
        "kagi",
        "Kagi",
        ["kagi"],
        url("https://kagi.com/search", "q"),
        url("https://kagisuggest.com/api/autosuggest", "q"),
    ),
    # Google's suggestion service answers only when told a response format;
    # client=firefox selects the OpenSearch one. It is not a partner code.
    engine(
        "google",
        "Google",
        ["g", "google"],
        url("https://www.google.com/search", "q"),
        url("https://www.google.com/complete/search", "q", {"client": "firefox"}),
    ),
    engine(
        "bing",
        "Bing",
        ["b", "bing"],
        url("https://www.bing.com/search", "q"),
        url("https://www.bing.com/osjson.aspx", "query"),
    ),
    engine(
        "ecosia",
        "Ecosia",
        ["eco", "ecosia"],
        url("https://www.ecosia.org/search", "q"),
        url("https://ac.ecosia.org/autocomplete", "q", {"type": "list"}),
    ),
    engine(
        "qwant",
        "Qwant",
        ["qw", "qwant"],
        url("https://www.qwant.com/", "q"),
        url("https://api.qwant.com/v3/suggest/", "q", {"client": "opensearch"}),
    ),
    # Perplexity publishes no suggestion URL in its OpenSearch description.
    engine(
        "perplexity",
        "Perplexity",
        ["pplx", "perplexity"],
        url("https://www.perplexity.ai/search", "q"),
        classification="unknown",
    ),
]

# Site searches: each searches one site, and the first-run step leaves them
# out of the engines it offers as the default (SITE_SEARCHES).
SITES = [
    engine(
        "youtube",
        "YouTube",
        ["yt", "youtube"],
        url("https://www.youtube.com/results", "search_query"),
        classification="unknown",
    ),
    engine(
        "github",
        "GitHub",
        ["gh", "github"],
        url("https://github.com/search", "q"),
        classification="unknown",
    ),
    engine(
        "openstreetmap",
        "OpenStreetMap",
        ["maps", "openstreetmap"],
        url("https://www.openstreetmap.org/search", "query"),
        classification="unknown",
    ),
]


def wikipedia(mozilla):
    """Mozilla's Wikipedia engines, without the parameter that tags the search
    as Mozilla's."""
    records = []
    for record in mozilla:
        if record.get("recordType") != "engine":
            continue
        if not record["identifier"].startswith("wikipedia"):
            continue
        record = {k: v for k, v in record.items() if k not in ("id", "last_modified", "schema")}
        record["base"]["aliases"] = ["w"] + record["base"].get("aliases", [])
        for kind in record["base"]["urls"].values():
            kind["params"] = [p for p in kind.get("params", []) if p["name"] != "sourceid"]
            if not kind["params"]:
                del kind["params"]
        records.append(record)
    if not records:
        sys.exit("generate-search-config: no Wikipedia engines in Mozilla's configuration")
    return records


def main():
    mozilla = json.loads(MOZILLA_CONFIG.read_text())["data"]
    locales = next(r for r in mozilla if r.get("recordType") == "availableLocales")
    locales = {k: v for k, v in locales.items() if k not in ("id", "last_modified", "schema")}

    wiki = wikipedia(mozilla)

    config = ENGINES + SITES + wiki + [
        {"recordType": "defaultEngines", "globalDefault": DEFAULT, "specificDefaults": []},
        {"recordType": "engineOrders", "orders": [{"environment": {"allRegionsAndLocales": True}, "order": ORDER}]},
        locales,
    ]

    OUTPUT.write_text(
        "/* This Source Code Form is subject to the terms of the Mozilla Public\n"
        " * License, v. 2.0. If a copy of the MPL was not distributed with this\n"
        " * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n\n"
        "// Generated by scripts/generate-search-config.py. Do not edit by hand;\n"
        "// change the script and re-run it.\n\n"
        "export const SvalSearchConfig = {\n"
        "  /**\n"
        "   * Sval's search engine configuration, in the schema of Mozilla's\n"
        "   * search-config-v2 Remote Settings collection.\n"
        "   */\n"
        f"  SEARCH_CONFIG: {json.dumps(config)},\n\n"
        "  /**\n"
        "   * Icons for engines Mozilla's bundled icon set does not cover.\n"
        "   */\n"
        "  SEARCH_ICONS: {\n"
        '    brave: "chrome://browser/content/sval/search-icons/brave.png",\n'
        '    kagi: "chrome://browser/content/sval/search-icons/kagi.png",\n'
        '    github: "chrome://browser/content/sval/search-icons/github.png",\n'
        '    openstreetmap: "chrome://browser/content/sval/search-icons/openstreetmap.png",\n'
        "  },\n\n"
        "  /**\n"
        "   * The engines that search one site, which first run does not offer\n"
        "   * as the default engine.\n"
        "   */\n"
        f"  SITE_SEARCHES: {json.dumps([site['identifier'] for site in SITES])},\n"
        "};\n"
    )
    subprocess.run(
        [str(PRETTIER), "--config", str(PRETTIER_CONFIG), "--write", str(OUTPUT)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    print(f"generate-search-config: {len(ENGINES)} engines, {len(SITES)} site searches, {len(wiki)} Wikipedia records -> {OUTPUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
