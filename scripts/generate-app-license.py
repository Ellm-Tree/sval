#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Write the third-party notices Sval ships: the desktop's block in
about:license, and the data of the iPhone app's Settings › Licenses.

    scripts/generate-app-license.py            # write the desktop's
    scripts/generate-app-license.py --check    # fail if it is out of date
    scripts/generate-app-license.py --ios      # the iPhone app's, likewise
    scripts/generate-app-license.py --ios --check

The desktop's is chrome/browser/base/content/overrides/app-license.html.
about:license opens with this block (APP_LICENSE_BLOCK in Firefox's
browser/base/moz.build). It holds Sval's notice, the texts of Sval's license
and app store permission from LICENSES/, and the license files of every
third-party crate compiled into what Sval ships beside Gecko: the wasm engine
(engine/, for wasm32 with its wasm feature), sval-mcp (tools/sval-mcp/) and
sval-folder (tools/sval-folder/), each on every platform Sval ships. MIT, BSD, ISC and Apache-2.0 all require their
notices to travel with the binary; Firefox's own list covers only Gecko's
crates.

The iPhone app's is mobile/ios/Licenses.json, which Settings › Licenses
lists (`LicensesView.swift`). It holds the texts of Sval's license and app
store permission, every third-party crate compiled into the app's native
library (mobile/sval-mobile, for aarch64-apple-ios) with its license files,
and the fonts and data the app carries. Each license text is stored once,
in "texts", and a component or a font names the texts that cover it by
their index there.

A crate's normal dependencies are followed, with the features a build of it
resolves (`cargo tree`); build dependencies, development dependencies and
proc-macro crates are not, because they run while building and none of their
code reaches the binary. Sval's own crates, the path dependencies, are
followed but not listed. Every LICENSE*, COPYING* and NOTICE* file a crate
ships is reproduced, and crates with identical texts share one copy. A crate
that ships no such file takes the upstream text HAND_WRITTEN names, and a
crate without either fails the run. Each MPL-2.0 crate's listing links its
source repository, which MPL 2.0 section 3.2(a) asks a binary to say.

It needs cargo, which fetches any crate source it lacks. CI's engine-checks,
sval-mcp and sval-folder jobs run it with --check, and the mobile-ios job with
--ios --check, so a Cargo.lock that changes what ships fails until the
notices are regenerated.
"""

import html
import json
import os
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "chrome/browser/base/content/overrides/app-license.html"
IOS_OUT = REPO / "mobile/ios/Licenses.json"

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
IOS_PROGRAMS = [("mobile/sval-mobile", [], ["aarch64-apple-ios"])]
NOTICE_PREFIXES = ("LICEN", "COPYING", "NOTICE")

# The license text of each crate whose published package carries none, from
# scripts/app-license/. flatbuffers' and uniffi-rs's are their repositories'
# LICENSE files at the commit each crate's .cargo_vcs_info.json names.
# seahash's repository has no license file either, so its text is MIT's with
# the authors its Cargo.toml names.
HAND_WRITTEN = {
    "flatbuffers": "flatbuffers/LICENSE",
    "seahash": "seahash/LICENSE",
    "uniffi": "uniffi-rs/LICENSE",
    "uniffi_core": "uniffi-rs/LICENSE",
    "uniffi_pipeline": "uniffi-rs/LICENSE",
}

# Data Sval ships under another license than its own, with what each license
# asks a copy to carry: who made it, where it came from, its copyright
# statement where it has one, what Sval changed in it, and the license's
# text. OFL-1.1 (its FAQ, 1.20) asks for the font's copyright statement, its
# license notice and the license; each font's statement is its name table's.
# MPL-2.0 asks for where the source is, which the address gives.
DATA = [
    (
        "AdGuard's companiesdb",
        "AdGuard Software Ltd and the WhoTracks.me contributors",
        "https://github.com/AdguardTeam/companiesdb",
        "CC-BY-SA-4.0",
        None,
        "Reduced to each company's registrable domains and stored as a module.",
    ),
]
JETBRAINS_MONO = (
    "JetBrains Mono",
    "the JetBrains Mono Project Authors",
    "https://github.com/JetBrains/JetBrainsMono",
    "OFL-1.1",
    "Copyright 2020 The JetBrains Mono Project Authors "
    "(https://github.com/JetBrains/JetBrainsMono)",
    "Sval uses it unmodified.",
)
OUTFIT = (
    "Outfit",
    "the Outfit Project Authors",
    "https://github.com/Outfitio/Outfit-Fonts",
    "OFL-1.1",
    "Copyright 2021 The Outfit Project Authors "
    "(https://github.com/Outfitio/Outfit-Fonts)",
    "Sval uses it unmodified.",
)
FONTS = [
    (
        "Audiowide",
        "Brian J. Bonislawsky DBA Astigmatic (AOETI)",
        "https://github.com/google/fonts/tree/main/ofl/audiowide",
        "OFL-1.1",
        "Copyright (c) 2012 by Brian J. Bonislawsky DBA Astigmatic (AOETI) "
        "(astigma@astigmatic.com), with ReservedFont Name \"Audiowide\"",
        "Sval uses it unmodified.",
    ),
    JETBRAINS_MONO,
    OUTFIT,
]
IOS_DATA = [
    (
        "The Public Suffix List",
        "its contributors",
        "https://github.com/publicsuffix/list",
        "MPL-2.0",
        None,
        "Sval takes its copy from Firefox and leaves out the comments. Sval "
        "writes each rule in lowercase ASCII, in sorted order, with a number "
        "that says whether the rule is a suffix, an exception, or a wildcard. "
        "The psl component builds a second copy into its code.",
    ),
    JETBRAINS_MONO,
    OUTFIT,
]


def shipped_crates(programs):
    """{(name, version): (license expression, crate directory, repository)}
    across programs."""
    crates = {}
    for directory, features, targets in programs:
        run = lambda *args: subprocess.run(
            ["cargo", *args, "--locked", *features],
            cwd=REPO / directory, capture_output=True, text=True, check=True,
        ).stdout
        meta = json.loads(run("metadata", "--format-version", "1"))
        packages = {(p["name"], p["version"]): p for p in meta["packages"]}
        for target in targets:
            tree = run("tree", "--target", target, "-e", "normal,no-proc-macro",
                       "--prefix", "none", "--format", "{p}")
            for line in tree.splitlines():
                name, version = line.split()[:2]
                p = packages[(name, version.removeprefix("v"))]
                if p["source"] is None:
                    continue
                crates[(name, p["version"])] = (
                    p.get("license") or "see its license file",
                    pathlib.Path(p["manifest_path"]).parent,
                    p.get("repository"),
                )
    return crates


def notices(crates):
    """[(text, [crate names])], one entry per distinct license text."""
    by_text, missing = {}, []
    for (name, _version), (_license, directory, _repository) in sorted(crates.items()):
        files = sorted(
            directory / f for f in os.listdir(directory)
            if f.upper().startswith(NOTICE_PREFIXES) and (directory / f).is_file()
        )
        if not files and name in HAND_WRITTEN:
            files = [REPO / "scripts/app-license" / HAND_WRITTEN[name]]
        if not files:
            missing.append(name)
        for f in files:
            text = f.read_text(encoding="utf-8", errors="replace").strip() + "\n"
            names = by_text.setdefault(text, [])
            if name not in names:
                names.append(name)
    if missing:
        sys.exit(f"error: no license file in {', '.join(sorted(set(missing)))}; add its notice by hand")
    return sorted(by_text.items(), key=lambda item: (item[1][0], item[0]))


esc = lambda s: html.escape(s, quote=False)


def components(crates):
    """The list of crates and their license texts, as HTML."""
    licenses, sources = {}, {}
    for (name, _version), (license, _directory, repository) in crates.items():
        licenses.setdefault(name, set()).add(license)
        if "MPL" in license and repository:
            sources[name] = repository
    listing = "\n".join(
        f"  <li>{esc(n)}: {esc(' / '.join(sorted(licenses[n])))}"
        + (f', from <a href="{esc(sources[n])}">{esc(sources[n])}</a>' if n in sources else "")
        + "</li>"
        for n in sorted(licenses)
    )
    texts = "\n".join(
        f'<h3>{esc(", ".join(crate_names))}</h3>\n<pre>{esc(text)}</pre>'
        for text, crate_names in notices(crates)
    )
    return f"<ul>\n{listing}\n</ul>\n{texts}"


def data_notices(data, anchor="sval-data"):
    """The list of data and its license texts, as HTML, each text's id
    starting `anchor`."""
    listing = "\n".join(
        f"  <li>{esc(name)}, by {esc(holder)}, from "
        f'<a href="{esc(url)}">{esc(url)}</a>, under {esc(spdx)}. '
        + (f"{esc(copyright)}. " if copyright else "")
        + f"{esc(change)}</li>"
        for name, holder, url, spdx, copyright, change in data
    )
    texts = "\n".join(
        f'<h3 id="{anchor}-{esc(spdx.lower())}">{esc(spdx)}</h3>\n'
        f'<pre>{esc((REPO / "LICENSES" / f"{spdx}.txt").read_text(encoding="utf-8"))}</pre>'
        for spdx in sorted({d[3] for d in data})
    )
    return f"<ul>\n{listing}\n</ul>\n{texts}"


def sval_licenses():
    agpl = (REPO / "LICENSES/AGPL-3.0-only.txt").read_text(encoding="utf-8")
    permission = (REPO / "LICENSES/AdditionRef-sval-app-store.txt").read_text(encoding="utf-8")
    return f"""<h2 id="sval-agpl">GNU Affero General Public License, version 3</h2>
<pre>{esc(agpl)}</pre>
<h2 id="sval-app-store">Sval App Store Permission</h2>
<pre>{esc(permission)}</pre>"""


WARRANTY = """<p>
  Sval is distributed in the hope that it will be useful, but WITHOUT ANY
  WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
  FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
  details.
</p>"""


def render(crates):
    return f"""<!-- SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
   - Copyright 2026 Ellm Tree, Inc.
   -
   - Generated by scripts/generate-app-license.py; edit that, not this. -->
<p>
  <b>Sval</b> is made by Ellm Tree, Inc. Sval's code is Copyright 2026
  Ellm Tree, Inc. and Sval's contributors, and is free software: you may
  redistribute and modify Sval under the terms of the
  <a href="about:license#sval-agpl">GNU Affero General Public License,
  version 3</a>, with the
  <a href="about:license#sval-app-store">Sval App Store Permission</a>, both
  below. Sval's sync engine, sval-mcp and sval-folder are built with
  <a href="about:license#sval-components">open-source components</a>, listed
  below with the components' licenses. The code Sval takes from Mozilla, and
  Sval's changes to Mozilla's code, are under the
  <a href="about:license#mpl">Mozilla Public License 2.0</a>, further down.
  Sval and Ellm Tree are not officially associated with Mozilla or its
  products.
</p>
{WARRANTY}
{sval_licenses()}
<h2 id="sval-components">Components of Sval's sync engine, sval-mcp and sval-folder</h2>
<p>
  These are built into Sval's sync engine, into sval-mcp, the program that
  lets an AI app drive Sval, and into sval-folder, the program that reads
  and writes a shared folder, each under the license named. Each
  component's own license and notice files follow the list.
</p>
{components(crates)}
<h2 id="sval-data">Data built into Sval</h2>
<p>
  Sval's map of which company owns which domains includes these. The license for
  each follows the list.
</p>
{data_notices(DATA)}
<h2 id="sval-fonts">Fonts built into Sval</h2>
<p>
  Sval shows some of its text in these typefaces. The license for each follows the
  list.
</p>
{data_notices(FONTS, "sval-fonts")}
"""


def render_ios(crates):
    texts, index = [], {}

    def text_id(text):
        if text not in index:
            index[text] = len(texts)
            texts.append(text)
        return index[text]

    covering = {}
    for text, crate_names in notices(crates):
        for name in crate_names:
            covering.setdefault(name, []).append(text_id(text))
    components = []
    for (name, version), (license, _directory, repository) in sorted(crates.items()):
        component = {"name": name, "version": version, "license": license, "texts": covering[name]}
        if "MPL" in license and repository:
            component["source"] = repository
        components.append(component)
    license_text = lambda spdx: (REPO / "LICENSES" / f"{spdx}.txt").read_text(encoding="utf-8")
    data = [
        {
            "name": name, "source": url, "license": spdx,
            **({"copyright": copyright} if copyright else {}),
            "description": change, "texts": [text_id(license_text(spdx))],
        }
        for name, _holder, url, spdx, copyright, change in IOS_DATA
    ]
    sval = [
        {"name": "GNU Affero General Public License, version 3",
         "texts": [text_id(license_text("AGPL-3.0-only"))]},
        {"name": "Sval App Store Permission",
         "texts": [text_id(license_text("AdditionRef-sval-app-store"))]},
    ]
    return json.dumps(
        {"sval": sval, "components": components, "data": data, "texts": texts},
        indent=1, ensure_ascii=False,
    ) + "\n"


def main():
    args = sys.argv[1:]
    if "--ios" in args:
        out, content = IOS_OUT, render_ios(shipped_crates(IOS_PROGRAMS))
        command = "scripts/generate-app-license.py --ios"
    else:
        out, content = OUT, render(shipped_crates(PROGRAMS))
        command = "scripts/generate-app-license.py"
    if "--check" in args:
        if not out.is_file() or out.read_text(encoding="utf-8") != content:
            print(f"error: {out.relative_to(REPO)} is out of date; run {command}")
            return 1
        print(f"==> {out.relative_to(REPO)} is up to date")
        return 0
    out.write_text(content, encoding="utf-8")
    print(f"==> wrote {out.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
