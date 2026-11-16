# Contributing to Sval

## The terms

There is no contributor license agreement to sign, and no sign-off line to
add. By sending a change, you agree that it comes in under the license of the
files it touches, and you keep the copyright in what you wrote.

- **Sval's own files** are licensed under the GNU Affero General Public
  License, version 3 only, with the Sval App Store Permission
  (`LICENSES/AGPL-3.0-only.txt`, `LICENSES/AdditionRef-sval-app-store.txt`).
  A change to them, or a new file of Sval's, comes in under both, the
  permission included. Each file says so in its first lines:

      SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store

  A new file carries that notice with your own copyright line,
  `Copyright <year> <your name>`, or Ellm Tree, Inc.'s if Ellm Tree wrote it.

- **Mozilla's files** and Sval's changes to them stay under the Mozilla
  Public License 2.0: `patches/`, and the MPL files `REUSE.toml` lists. A
  change to them comes in under that license.
- **The docs pages** in `website/src/content/docs/` are licensed under
  Creative Commons Attribution-ShareAlike 4.0 (`LICENSES/CC-BY-SA-4.0.txt`),
  and a change to them comes in under it. The rest of sval.app is not
  published, so a docs change can't be previewed as the site shows
  it. Maintainers check the rendered page before merging.
- **Sval's brand art** is reserved (`branding/sval/LICENSE`). Don't send
  changes to it.

Send only work you have the right to license this way. Code under another
license, someone else's included, needs that license named in the file and
its text in `LICENSES/`. Ask first, because code without the app store
permission cannot ship in Sval's app store builds.

## Why these terms

- **The app store permission** is why Sval can ship through Apple's and
  Google's stores at all. The GPL family forbids the extra restrictions those
  stores' terms impose, so every contributor grants the same permission
  Ellm Tree does. Without it from everyone, one contribution could keep Sval
  out of a store.
- **No contributor license agreement** means nobody, Ellm Tree, Inc. or anyone
  who might one day buy it, can take Sval closed. Relicensing it would need
  every contributor's consent.
- **AGPL** means anyone may use, change and share Sval, and nobody can build a
  closed product or a closed service on it.

Decision records 0111 and 0119 in `docs/decisions/` give the full reasoning,
and `TRADEMARKS.md` covers Sval's name and logo.

## How to contribute

- **Report a problem or ask for a feature** from inside Sval. Help › Send
  Feedback… opens a form that shows everything it would send to
  `feedback.sval.app`. It sends only when you press Send. An issue can also
  go to the tracker at https://gitlab.com/sval-browser/sval/-/issues. A
  security problem goes by email instead, as `SECURITY.md` describes.
- **Send a change** as a merge request against `main` at
  https://gitlab.com/sval-browser/sval. Build and run Sval as `README.md`
  describes, and run the tests for what you changed through
  `scripts/test.sh` and the lint gate through `scripts/lint.sh`. A change to
  a user-facing feature updates `docs/features.md`.

  GitLab's CI runs the lint gate and the engine's tests. Once it passes, a
  maintainer labels the merge request `in review`, reads the change and
  runs it through Sval's full test suite on every platform. The result
  comes back as a comment: the tests that failed and why, or a pass. A
  change that passes is merged. When `main` moves on, maintainers rebase
  your branch themselves, and ask you only when a conflict changes what
  your code does.

- **Design and decisions.** `docs/superpowers/specs/2026-09-24-sval-browser-design.md`
  is the design Sval is built to, and `docs/decisions/` records each decision
  with its reason. A change that alters either says so in the merge request.

The rules below bind every change. `scripts/check-licenses.py` checks every
file's notice, and CI runs it on every merge request.

## Rules every change follows

The sections below are the project's working rules. Code comments cite them as
`CONTRIBUTING.md` rule N or by section name.

### Hard rules

1. **Sval compiles its own Gecko**, because Mozilla's prebuilt Gecko carries
   Firefox's identity. Releases are full builds, and development uses artifact
   builds on Sval's Gecko. Sval changes Gecko's C++ and Rust whenever a feature
   needs it, which moves the Gecko key (`scripts/gecko-key.sh`) that CI
   compiles once. The key hashes each input's bytes, comments included. So a
   key input's comments describe that file and cite no other doc, because a
   stale pointer there costs a compile on every platform. The engine in `engine/`
   reaches the chrome as WASM.
2. **Patch Mozilla's files wherever a feature needs it, and keep each patch
   as small as it can be**, with the logic in added files. Never route around
   a patch with a runtime shim, and never let a Gecko compile decide the
   design.
3. **Never use Firefox branding.** Mozilla's trademark policy forbids it.
4. **No telemetry.** Do not enable data reporting prefs.
5. **Base is ESR.** Do not retarget to the rapid release channel.
6. **v1 platforms are macOS, Windows and Linux** (spec §12).
7. **Sval's name and art are Sval's.** The code is open, and a fork renames
   and replaces the art (`TRADEMARKS.md`, decision 0120).
8. **A Sval binary's source is public before the binary ships.** That
   source is this repository, and next to each release the source of the
   release's MPL 2.0 files: Mozilla's code and Sval's modifications of that
   code (`scripts/mpl-source.py`).
9. **Always launch dev builds through `./scripts/run.sh`.** A bare launch
   opens your real Sval data directory, and on Mozilla's Gecko your real
   Firefox profile. `run.sh` passes an explicit `--profile`.
10. **What Sval keeps or sends never says what the user is browsing:**
    `sval-log.txt`, crash and feedback reports, anything that leaves the
    process. The Browser Console and stdout are exempt (decision 0061). Log
    through `SvalLog.sys.mjs` (`browser.sval.loglevel`, default `"Warn"`). A
    call site at any level never interpolates a Workspace, group or tab name,
    a URL, the document key, a pairing code or an emoji. Secret material (an
    agent's secret, the port file's token, a nonce, a proof) is barred from
    every sink. Ids, counts, error names and `describeError` messages are
    enough. `test_sval_log.js` enforces this.
11. **Sval contacts only the hosts it names** (spec §10.9).
    `scripts/network-contact/allowed-hosts.txt` is the list.
    `scripts/network-contact-test.sh` fails on any host outside it, or any
    Remote Settings collection outside `browser.sval.remoteSettings.collections`.
    It runs nightly. Run it locally before merging anything that could contact
    the network. A new contact goes in the list and the spec, with its reason.
12. **Use what exists.** When Gecko or Sval already has a function that answers
    a question, call it and use its answer as is. Call `siteOf` for what a site is,
    `Services.eTLD` for the Public Suffix List and the store's setters for
    policy.
    Never wrap it in a second check, a special case or new state that
    second-guesses it. Don't build a mechanism to enforce a rule nobody stated.
    If the existing answer looks wrong, raise it.

### Comments

A comment earns its line: without it, a reader of this file would get
something wrong. Say why the present code is as it is: the invariant it keeps,
the outside constraint, or the hazard the code hides. Cite Mozilla by symbol,
the spec by section and decisions by number. State only what you verified.
Later readers take comments as fact. Never restate the code or tell the
history or incident behind it. Never use words that need a diff ("now", "no
longer") or cite plans or tasks. Never write hedges, contrasts of the form
`X, not Y`, or counts that drift. Reasoning shared by
several places lives once, here or in the spec. `scripts/check-comments.py`
enforces the mechanical bans (em dashes, issue and PR numbers, line numbers,
intensifiers) and runs first in CI.

### Commit messages

The subject is an imperative verb and its object, naming the change ("Fix the
sync row's label"), never the state it leaves ("Pins are left out of the
menus"). An area prefix is optional (`ci-image.sh: prune ...`). One change per
commit: a subject that needs "and" is two. The body says what was wrong and why
this is the fix, wrapped at 72, never restating the diff, and is left out when
the subject says it all. A merge request's title follows the same rules: it
becomes the merge commit's subject. `scripts/check-commit-msg.py` checks the
verb, the 72-character limit and the trailing period, as the `commit-msg` hook
and in CI. A real imperative verb missing from its `VERBS` list belongs
there.

### License notices

Sval's own files are AGPL-3.0-only with the Sval App Store Permission
(decisions 0111 and 0119). Mozilla's files and Sval's modifications of them
stay MPL 2.0. `LICENSING.md` explains the layout. A file Sval writes starts, after
any shebang or XML declaration, with `SPDX-License-Identifier: AGPL-3.0-only
WITH AdditionRef-sval-app-store` and `Copyright 2026 Ellm Tree, Inc.` in its
own comment syntax. A file copied from Mozilla keeps its MPL header exactly and
is listed as MPL-2.0 in `REUSE.toml`, which also lists files that cannot carry
a comment. Brand art is reserved (`branding/sval/LICENSE`).
`scripts/check-licenses.py` enforces this in CI and `lint.sh`.

### Layout

- `patches/`: patches to Mozilla's code, ordered by `patches/series`.
- `chrome/`: new files copied into the tree. Sval's UI code lives here.
- `branding/`: copied to `browser/branding/sval`. `branding/sval/README.md`
  describes the art.
- `mozconfig`: Sval's identity, shared by every build. `mozconfig.artifact` and
  `mozconfig.gecko` are the modes `scripts/build.sh` appends. Identity options
  go in `mozconfig` alone, because an artifact build must match its Gecko's.
- `scripts/`: fetch, patch, sync, build, test, package.
- `engine/`: the sync engine, a Rust crate built to WASM (`engine/CLAUDE.md`).
- `tools/sval-mcp/`: the MCP server AI apps use to drive Sval.
- `tools/sval-folder/`: the helper that reads and writes the shared folder
  (decision 1437).
- `packaging/linux/`: templates for the .deb and .rpm.
- `docs/`: the design specs, the decision records, the engine's host
  contract, CI, the fingerprinting catalogue and other references.
- `build/`: the upstream checkout, one per worktree. Gitignored. Disposable.

### Commands

    ./scripts/fetch-upstream.sh     # clone the pinned ESR commit into build/
    ./scripts/apply-patches.sh      # sync files and apply the patch series
    ./scripts/sync-files.sh         # copy chrome/ and branding/ into build/firefox
    ./scripts/build.sh              # artifact build
    SVAL_SKIP_BOOTSTRAP=1 SVAL_FASTER=1 ./scripts/build.sh # fast front-end rebuild
    ./scripts/run.sh                # launch the built browser
    ./scripts/test.sh <paths>       # run tests
    ./scripts/lint.sh               # the lint gate CI runs, license check included; sync-files.sh first
    ./scripts/network-contact-test.sh # every host Sval contacts is on the list
    ./scripts/new-worktree.sh [--no-build] <topic> # a worktree with its own build; warns when the disk is low
    ./scripts/build-worktree.sh     # give a --no-build worktree its build tree
    ./scripts/reclaim-dev.sh        # list merged worktrees, stale ~/.mozbuild state and gone builds macOS still opens links in; --apply removes them
    ./scripts/perf.sh               # profile startup, page loads and tabs; rank Sval's functions by CPU time
    ./scripts/perf-panel.sh         # time the Workspace panel's steps with thousands of tabs
    python3 -I scripts/perf/soak.py # run Sval for hours and record its memory (docs/memory-soak.md)

**The everyday loop:** edit the file in `chrome/` or `branding/`, then
`sync-files.sh`, fast rebuild, `run.sh`. Never edit the copy in
`build/firefox/` or keep work only there: `apply-patches.sh` resets that tree.
A branding change needs a full configure, so drop `SVAL_FASTER=1`.

### Patch workflow

To modify one of Mozilla's own files:

1. `./scripts/apply-patches.sh`: start from a clean, patched tree.
2. Edit the file in `build/firefox/`, then fast rebuild and `run.sh`.
3. `./scripts/make-patch.sh <name> <path...>` captures your diff against the
   applied series. A new patch needs a header above its first `diff` line:
   `Sval: <what>`, a blank line, then why. `make-patch.sh` keeps the header.
4. Add `<name>.patch` to `patches/series`, and prove it applies from pristine
   with `./scripts/apply-patches.sh`.

A new file goes in `chrome/`, mirroring the upstream layout, never in a patch.

**A defect in Mozilla's code goes in `docs/upstream-candidates.md`**, in the
merge request whose patch fixes or works around it, whether or not Mozilla has
a bug for it. Sval contributes those fixes back. A Sval-only behavior
change does not belong there.

**Firefox's own pages take Sval's design through `SvalPageStyle.sys.mjs`.** A
page listed there gets `sval-page.css`, Firefox's design tokens at Sval's
values, then its own sheet under `chrome/browser/components/sval/pages/`.
Restyle another page by adding it there, never by patching its CSS.
