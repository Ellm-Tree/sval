#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Write chrome/browser/base/content/overrides/app-license.html.

    scripts/generate-app-license.py            # write it
    scripts/generate-app-license.py --check    # fail if it is out of date

about:license opens with this block (APP_LICENSE_BLOCK in Firefox's
browser/base/moz.build). It holds Sval's notice, the texts of Sval's license
and app store permission from LICENSES/, and the license files of every
third-party crate compiled into what Sval ships beside Gecko: the wasm engine
(engine/, for wasm32 with its wasm feature), sval-mcp (tools/sval-mcp/) and
sval-folder (tools/sval-folder/), each on every platform Sval ships. MIT, BSD, ISC and Apache-2.0 all require their
notices to travel with the binary; Firefox's own list covers only Gecko's
crates.

A crate's normal dependencies are followed; build dependencies, development
dependencies and proc-macro crates are not, because they run while building
and none of their code reaches the binary. Every LICENSE*, COPYING* and
NOTICE* file a crate ships is reproduced, and crates with identical texts
share one copy. A crate without any such file fails the run.

It needs cargo, which fetches any crate source it lacks. CI's engine-checks,
sval-mcp and sval-folder jobs run it with --check, so a Cargo.lock that changes what ships
fails until the block is regenerated.
"""

import html
import json
import os
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "chrome/browser/base/content/overrides/app-license.html"

# The crates each shipped program is built from, and the targets it ships on.
PROGRAMS = [
    ("engine", ["--features", "wasm"], ["wasm32-unknown-unknown"]),
    (
        "tools/sval-mcp",
        [],
        [
            "x86_64-unknown-linux-gnu",
            "x86_64-pc-windows-msvc",
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
        ],
    ),
    (
        "tools/sval-folder",
        [],
        [
            "x86_64-unknown-linux-gnu",
            "x86_64-pc-windows-msvc",
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
        ],
    ),
]
NOTICE_PREFIXES = ("LICEN", "COPYING", "NOTICE")

# Data Sval ships under another license than its own, with what each license
# asks a copy to carry: who made it, where it came from, that Sval changed its
# form, and the license's text.
DATA = [
    (
        "AdGuard's companiesdb",
        "AdGuard Software Ltd and the WhoTracks.me contributors",
        "https://github.com/AdguardTeam/companiesdb",
        "CC-BY-SA-4.0",
        "Reduced to each company's registrable domains and stored as a module.",
    ),
]


def shipped_crates():
    """{(name, version): (license expression, crate directory)} across PROGRAMS."""
    crates = {}
    for directory, features, targets in PROGRAMS:
        for target in targets:
            meta = json.loads(
                subprocess.run(
                    ["cargo", "metadata", "--format-version", "1", "--locked",
                     "--filter-platform", target, *features],
                    cwd=REPO / directory, capture_output=True, text=True, check=True,
                ).stdout
            )
            packages = {p["id"]: p for p in meta["packages"]}
            nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
            members = set(meta["workspace_members"])
            seen, stack = set(), list(members)
            while stack:
                pid = stack.pop()
                if pid in seen:
                    continue
                seen.add(pid)
                for dep in nodes[pid]["deps"]:
                    if not any(k["kind"] is None for k in dep["dep_kinds"]):
                        continue
                    kinds = {k for t in packages[dep["pkg"]]["targets"] for k in t["kind"]}
                    if "proc-macro" in kinds:
                        continue
                    stack.append(dep["pkg"])
            for pid in seen - members:
                p = packages[pid]
                crates[(p["name"], p["version"])] = (
                    p.get("license") or "see its license file",
                    pathlib.Path(p["manifest_path"]).parent,
                )
    return crates


def notices(crates):
    """[(text, [crate names])], one entry per distinct license text."""
    by_text, missing = {}, []
    for (name, _version), (_license, directory) in sorted(crates.items()):
        files = sorted(
            f for f in os.listdir(directory)
            if f.upper().startswith(NOTICE_PREFIXES) and (directory / f).is_file()
        )
        if not files:
            missing.append(name)
        for f in files:
            text = (directory / f).read_text(encoding="utf-8", errors="replace").strip() + "\n"
            names = by_text.setdefault(text, [])
            if name not in names:
                names.append(name)
    if missing:
        sys.exit(f"error: no license file in {', '.join(sorted(set(missing)))}; add its notice by hand")
    return sorted(by_text.items(), key=lambda item: (item[1][0], item[0]))


def render(crates):
    agpl = (REPO / "LICENSES/AGPL-3.0-only.txt").read_text(encoding="utf-8")
    permission = (REPO / "LICENSES/AdditionRef-sval-app-store.txt").read_text(encoding="utf-8")
    esc = lambda s: html.escape(s, quote=False)
    names = sorted({name for name, _ in crates})
    licenses = {}
    for (name, _version), (license, _directory) in crates.items():
        licenses.setdefault(name, set()).add(license)
    listing = "\n".join(
        f"  <li>{esc(n)}: {esc(' / '.join(sorted(licenses[n])))}</li>" for n in names
    )
    data = "\n".join(
        f"  <li>{esc(name)}, by {esc(holder)}, from "
        f'<a href="{esc(url)}">{esc(url)}</a>, under {esc(spdx)}. {esc(change)}</li>'
        for name, holder, url, spdx, change in DATA
    )
    data_texts = "\n".join(
        f'<h3 id="sval-data-{esc(spdx.lower())}">{esc(spdx)}</h3>\n'
        f'<pre>{esc((REPO / "LICENSES" / f"{spdx}.txt").read_text(encoding="utf-8"))}</pre>'
        for spdx in sorted({d[3] for d in DATA})
    )
    texts = "\n".join(
        f'<h3>{esc(", ".join(crate_names))}</h3>\n<pre>{esc(text)}</pre>'
        for text, crate_names in notices(crates)
    )
    return f"""<!-- SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
   - Copyright 2026 Ellm Tree, Inc.
   -
   - Generated by scripts/generate-app-license.py; edit that, not this. -->
<p>
  <b>Sval</b> is made by Ellm Tree, Inc. Its own code is Copyright 2026
  Ellm Tree, Inc. and Sval's contributors, and is free software: you may
  redistribute it and modify it under the terms of the
  <a href="about:license#sval-agpl">GNU Affero General Public License,
  version 3</a>, with the
  <a href="about:license#sval-app-store">Sval App Store Permission</a>, both
  below. Sval's sync engine, sval-mcp and sval-folder are built with
  <a href="about:license#sval-components">open-source components</a>, whose
  licenses follow them. The code Sval takes from Mozilla, and Sval's changes
  to it, are under the
  <a href="about:license#mpl">Mozilla Public License 2.0</a>, further down.
  Sval and Ellm Tree are not officially associated with Mozilla or its
  products.
</p>
<p>
  Sval is distributed in the hope that it will be useful, but WITHOUT ANY
  WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
  FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
  details.
</p>
<h2 id="sval-agpl">GNU Affero General Public License, version 3</h2>
<pre>{esc(agpl)}</pre>
<h2 id="sval-app-store">Sval App Store Permission</h2>
<pre>{esc(permission)}</pre>
<h2 id="sval-components">Components of Sval's sync engine, sval-mcp and sval-folder</h2>
<p>
  These are built into Sval's sync engine, into sval-mcp, the program that
  lets an AI app drive Sval, and into sval-folder, the program that reads
  and writes a shared folder, each under the license named. Each
  component's own license and notice files follow the list.
</p>
<ul>
{listing}
</ul>
{texts}
<h2 id="sval-data">Data built into Sval</h2>
<p>
  Sval's map of which company owns which domains includes these, each under
  its own license, whose text follows.
</p>
<ul>
{data}
</ul>
{data_texts}
"""


def main():
    content = render(shipped_crates())
    if "--check" in sys.argv[1:]:
        if not OUT.is_file() or OUT.read_text(encoding="utf-8") != content:
            print(f"error: {OUT.relative_to(REPO)} is out of date; run scripts/generate-app-license.py")
            return 1
        print(f"==> {OUT.relative_to(REPO)} is up to date")
        return 0
    OUT.write_text(content, encoding="utf-8")
    print(f"==> wrote {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
