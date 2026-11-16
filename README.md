# Sval

The Sval browser: a fork of Firefox ESR with first-class synced Workspaces.
Sval and Ellm Tree are not officially associated with Mozilla or its products.

This repository contains **no Firefox source code**. It holds a patch series, new
chrome files, branding, and build scripts. `scripts/fetch-upstream.sh` clones a
pinned commit of Firefox ESR into `build/`, which is gitignored.

## License

Sval's own code is licensed under the
[GNU Affero General Public License, version 3 only](LICENSES/AGPL-3.0-only.txt),
with the [Sval App Store Permission](LICENSES/AdditionRef-sval-app-store.txt).
The permission lets Sval's code, and works based on it, be distributed through
app stores. Ellm Tree, Inc. holds the copyright in what it wrote, and each
contributor in theirs ([`CONTRIBUTING.md`](CONTRIBUTING.md)).

Mozilla's code stays under the [Mozilla Public License 2.0](LICENSES/MPL-2.0.txt).
The MPL is per-file copyleft, so every Mozilla file Sval modifies, by a patch in
`patches/` or as a copy in `branding/sval/`, remains MPL 2.0. Section 3.3 of the MPL
lets those files sit next to Sval's own in one browser.

Sval's brand art is reserved, and `branding/sval/LICENSE` lists it. Unmodified
copies of Sval may carry the brand art. A modified version must replace the brand
art and must not use Sval's name or marks.

Every file states its license, at its top or in `REUSE.toml`, and
[`LICENSE`](LICENSE) explains the layout. `scripts/check-licenses.py` enforces
it, and `scripts/lint.sh` runs that check.

Sval is not Firefox and is not endorsed by or affiliated with Mozilla. All Firefox
branding is stripped at build time.

## Contributing

There is no contributor license agreement. A contribution comes in under the
license of the files it touches, and you keep its copyright.
[`CONTRIBUTING.md`](CONTRIBUTING.md) sets out the terms and how to send a
change.

## Build

Requires about 60 GB of free disk, Git and Python 3.11 or newer
(`scripts/check-licenses.py` uses `tomllib`). Each platform also needs its own
toolchain:

- **macOS:** Xcode Command Line Tools.
- **Linux:** what `mach bootstrap` installs. `scripts/build.sh` runs it unless
  `SVAL_SKIP_BOOTSTRAP=1` is set. CI's build image,
  `.forgejo/docker/Dockerfile`, lists every package CI builds with.
- **Windows:** MozillaBuild. `mach` runs only inside its shell.

Then:

    ./scripts/fetch-upstream.sh
    ./scripts/apply-patches.sh
    SVAL_MODE=gecko ./scripts/build.sh
    ./scripts/run.sh

`SVAL_MODE=gecko` compiles Gecko from Mozilla's source with Sval's patches
applied, as Sval's releases are built. It downloads its compilers from
Mozilla and is meant to need nothing of Sval's beyond this repository.

**Building outside Sval is untested.** Sval's own builds all have access to
its registry and runners, so nobody has yet built Sval from this repository
alone. Whether it works or fails for you, open an issue at
https://gitlab.com/sval-browser/sval/-/issues and say so: your platform, the command you ran and, on a failure, the
end of the build's output.

Without it, `build.sh` makes an artifact build. That downloads Sval's
precompiled Gecko from Sval's own package registry, which needs Sval's
credentials, and compiles only the front end. Without those credentials it
builds on Mozilla's Gecko instead, which lacks Sval's changes to Gecko's
native code, and says so. Use an artifact build only for front-end work.

A fork can host its own registry for artifact builds. This is untested
too, and reports are as welcome. A full `SVAL_MODE=gecko` build compiles Gecko,
`scripts/stage-gecko.sh` packages it, and `scripts/publish-gecko.sh` uploads
the packages to a Forgejo or Gitea package registry under the key
`scripts/gecko-key.sh` prints. `build.sh` then fetches them from it when
`SVAL_PACKAGES_URL` names that registry and `SVAL_PACKAGES_TOKEN` holds a
token that can read it. Each script's opening comment gives its arguments.

The first artifact build takes 30–90 minutes. Later front-end builds take
seconds.

On macOS, `run.sh` gives every dev build its own identity before launching
it. The app becomes `app.sval.dev`, so macOS keeps its Local Network
permission, keychain access, and other privacy decisions apart from an
installed Sval's. Every dev build shares those decisions, however many run at
once.
The first `run.sh` adds a self-signed "sval dev signing" identity to your
login keychain (`./scripts/dev-signing.sh`) and signs each dev build with it.
Sval keeps its secrets (the sync key, the Kagi session) behind a keychain
item, and macOS asks before an app it does not recognize reads one. With this
identity, choose Always Allow once for every dev build.

### The engine

Sval's sync engine is the Rust crate in `engine/`. `scripts/build-core-wasm.sh`
builds the engine to WASM and stages it for `scripts/sync-files.sh`. Without
that build, `sync-files.sh` puts a stub in the engine's place, and anything
that needs the engine says so. `engine/README.md` describes it.

## Tests

Run tests through `scripts/test.sh`, never `./mach test` directly:

    ./scripts/test.sh browser/components/sval/test/xpcshell/test_sval_log.js

It allows one test run at a time across worktrees, and on macOS it runs headless.
`./scripts/lint.sh` is the lint gate CI runs.

## Docs

- [`docs/fingerprinting-catalogue.md`](docs/fingerprinting-catalogue.md): what
  Sval does about each fingerprinting surface.
- [`docs/acceptance-two-devices.md`](docs/acceptance-two-devices.md): the manual
  two-device sync check.
- [`docs/firefox-assets.md`](docs/firefox-assets.md): what Sval does with each
  piece of Firefox art.
- [`docs/outbound-links.md`](docs/outbound-links.md): each link in Firefox's UI
  that leads to Mozilla or another third party, and what Sval does with it.
- [`docs/webdriver-bidi.md`](docs/webdriver-bidi.md): driving Sval with
  WebDriver BiDi.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): the rules every change follows.
