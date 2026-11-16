#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Refresh the tracker-owner data Sval ships (decision 1051).

    scripts/update-tracker-owners.py

Writes, under chrome/browser/components/sval/tracker-owners/:

- adguard-companiesdb.mjs: AdGuard's companiesdb, each company's domains
  (CC BY-SA 4.0).
- shared-hosting.mjs: the hosts that hold a public suffix below them
  (amazonaws.com above s3.amazonaws.com), or whose rule is a wildcard, from
  the Public Suffix List (MPL 2.0). SvalTrackerOwners drops them from the
  groups it fetches at runtime, where Services.eTLD can say whether a host is
  a public suffix but not whether one lies below it.

Hosts the Public Suffix List names as shared hosting, or that hold such
hosts, are dropped from companiesdb's groups. Each is a module whose header
gives its source's license, which REUSE.toml records, and says where and when
it came from. Sval's own additions are sval.mjs, edited by hand, which this
leaves alone. SvalTrackerOwners merges them when it builds the owners list.
Run this, review the diff and commit it; nothing fetches these at runtime.
"""

import datetime
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
# The tree's formatter, which lint holds Sval's modules to; scripts/
# fetch-upstream.sh and a build put it there.
PRETTIER = REPO / "build/firefox/node_modules/.bin/prettier"
PRETTIER_CONFIG = REPO / "build/firefox/.prettierrc.js"
OUT = REPO / "chrome/browser/components/sval/tracker-owners"

COMPANIESDB = "https://raw.githubusercontent.com/AdguardTeam/companiesdb/main/dist/trackers.json"
PUBLIC_SUFFIXES = "https://publicsuffix.org/list/public_suffix_list.dat"


def shared_hosting():
    """Hosts that are, or hold, public suffixes: hosting anyone's content
    (cloudfront.net, and amazonaws.com above s3.amazonaws.com). A company may
    own one, but its sites are everyone's, so no group keeps it.

    Returns every such host, and the ones a runtime check of Services.eTLD
    cannot find: all but the exact rules, which it names as suffixes."""
    hosts = set()
    exact = set()
    for line in fetch(PUBLIC_SUFFIXES).splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        rule = line.lstrip("*.!")
        if line == rule:
            exact.add(rule)
        labels = rule.split(".")
        # The rule and each of its parents short of a lone top-level label.
        for i in range(len(labels) - 1):
            hosts.add(".".join(labels[i:]))
    return hosts, sorted(hosts - exact)


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read().decode("utf-8")


def registrable(host):
    """The host without its www., as the sources give registrable domains or
    hosts under them. SvalTrackerOwners matches a domain and its subdomains,
    so a host under a listed domain needs no entry of its own."""
    host = host.strip().lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


SHARED = None


def keep(group):
    """A group without its shared hosting, or None when too little is left."""
    kept = sorted({h for h in group if h not in SHARED})
    return kept if len(kept) > 1 else None


def companiesdb():
    data = json.loads(fetch(COMPANIESDB))
    trackers = data["trackers"]
    by_company = {}
    for domain, tracker in data["trackerDomains"].items():
        company = trackers.get(tracker, {}).get("companyId")
        if company:
            by_company.setdefault(company, set()).add(registrable(domain))
    kept = {c: keep(d) for c, d in sorted(by_company.items())}
    return {c: d for c, d in kept.items() if d}


def write(name, spdx, notice, source, payload, export="OWNERS"):
    body = json.dumps(payload, indent=1)
    text = (
        f"/* SPDX-License-Identifier: {spdx}\n"
        f" * {notice}\n"
        " *\n"
        f" * From {source}, {datetime.date.today().isoformat()}, by\n"
        " * scripts/update-tracker-owners.py; regenerate it, never edit it. */\n\n"
        f"export const {export} = {body};\n"
    )
    (OUT / name).write_text(text, encoding="utf-8")
    subprocess.run(
        [str(PRETTIER), "--config", str(PRETTIER_CONFIG), "--write", str(OUT / name)],
        check=True,
        capture_output=True,
    )
    print(f"==> wrote {(OUT / name).relative_to(REPO)}")


def main():
    # Checked before anything is fetched or written, so a tree without it is
    # left as it was.
    if not PRETTIER.is_file():
        sys.exit(f"error: no {PRETTIER.relative_to(REPO)}; build the tree first, so lint can read what this writes")
    global SHARED
    SHARED, unseen = shared_hosting()
    OUT.mkdir(parents=True, exist_ok=True)
    write(
        "adguard-companiesdb.mjs",
        "CC-BY-SA-4.0",
        "Copyright AdGuard Software Ltd and the WhoTracks.me contributors",
        COMPANIESDB,
        list(companiesdb().values()),
    )
    write(
        "shared-hosting.mjs",
        "MPL-2.0",
        "This Source Code Form is subject to the terms of the Mozilla Public\n"
        " * License, v. 2.0. If a copy of the MPL was not distributed with this\n"
        " * file, You can obtain one at https://mozilla.org/MPL/2.0/.",
        PUBLIC_SUFFIXES,
        unseen,
        export="HOSTS",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
