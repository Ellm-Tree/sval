# Sval

Sval is a web browser for macOS, Windows, and Linux. It's built on Firefox
ESR and keeps your tabs in Workspaces. Your Workspaces sync between your
computers through a folder you already use, such as iCloud Drive or Dropbox.
There's no Sval account to create, and everything Sval stores in that folder
is encrypted with a key that only your devices hold.

You can download Sval and read its documentation at https://sval.app.

Ellm Tree, Inc. makes Sval independently of Mozilla. Mozilla doesn't endorse
Sval, and Sval's builds carry none of Firefox's branding.

## What's in this repository

This repository doesn't contain Firefox's source code. Instead it holds the
patches Sval makes to Firefox, Sval's own browser code and branding, and the
scripts that build everything. When you build, `scripts/fetch-upstream.sh`
downloads the exact version of Firefox ESR that Sval is based on into
`build/`, which Git ignores.

## Build Sval

To build Sval you need Git, Python 3.11 or newer, and about 60 GB of free
disk space, along with the usual build tools for your platform:

- **macOS:** the Xcode Command Line Tools.
- **Linux:** the packages that `mach bootstrap` installs. `scripts/build.sh`
  runs it for you unless you set `SVAL_SKIP_BOOTSTRAP=1`.
- **Windows:** MozillaBuild. Run every command from its shell.

Then run these commands from the top of the repository:

    ./scripts/fetch-upstream.sh
    ./scripts/build-core-wasm.sh
    ./scripts/apply-patches.sh
    SVAL_MODE=gecko ./scripts/build.sh
    ./scripts/run.sh

Setting `SVAL_MODE=gecko` compiles Gecko, Firefox's engine, from Mozilla's
source with Sval's changes applied. This is how Sval's releases are built.
The compilers it needs come from Mozilla, so it shouldn't depend on anything
private to Sval.

`build-core-wasm.sh` compiles Sval's sync engine, which is written in Rust
and lives in `engine/`. You'll need Rust and `wasm-bindgen` installed for it.
If you leave this step out, Sval still builds, but anything that depends on
the sync engine tells you it's unavailable. `engine/README.md` has more about
the engine.

**This build hasn't been tested outside Sval's own setup.** Sval's own builds
use a private package registry, so nobody has built Sval from this
repository alone yet. Whether it works for you or not, open an issue at
https://gitlab.com/sval-browser/sval/-/issues and tell us your platform and
the command you ran. If the build failed, include the last part of its
output.

### Faster builds for working on Sval

Once you're working on Sval's browser code, an artifact build is much
quicker. If you run `build.sh` without `SVAL_MODE=gecko`, it downloads a
precompiled Gecko and builds only Sval's browser code on top of it. The first
artifact build takes 30 to 90 minutes, and later ones take seconds.

The precompiled Gecko comes from Sval's private registry. If you can't reach
that registry, `build.sh` falls back to Mozilla's own Gecko and warns you
that it's missing Sval's changes to the engine. That's fine for work on
Sval's browser code, but not for anything that touches Gecko.

You can also host a registry of your own, though nobody has tried this yet:

1. Run a full `SVAL_MODE=gecko` build.
2. Package it with `scripts/stage-gecko.sh`.
3. Upload it to a Forgejo or Gitea package registry with
   `scripts/publish-gecko.sh`.
4. Set `SVAL_PACKAGES_URL` to that registry and `SVAL_PACKAGES_TOKEN` to a
   token that can read it, and `build.sh` downloads your Gecko from there.

Each of these scripts explains its arguments in its opening comment.

### On macOS

`run.sh` signs every development build with a certificate called "sval dev
signing", which it adds to your login keychain the first time you run it.
Because every build shares that certificate, macOS asks only once whether
Sval may read its "Sval secrets" keychain item. Choose **Always Allow** when
it asks.

## Run the tests

Run tests through `scripts/test.sh`, for example:

    ./scripts/test.sh browser/components/sval/test/xpcshell/test_sval_log.js

Only one test run can happen at a time, even across separate checkouts, and
on macOS the browser runs without a window. `scripts/lint.sh` runs the same
checks CI does.

## Contribute

[`CONTRIBUTING.md`](CONTRIBUTING.md) explains how to send a change and the
rules every change follows. There's no contributor license agreement, and you
keep the copyright in what you write. If you find a security problem, report
it privately as [`SECURITY.md`](SECURITY.md) describes.

These pages go deeper into how Sval works:

- [`docs/fingerprinting-catalogue.md`](docs/fingerprinting-catalogue.md)
  covers each way a site can fingerprint a browser and what Sval does about
  it.
- [`docs/acceptance-two-devices.md`](docs/acceptance-two-devices.md) walks
  through checking sync by hand on two computers.
- [`docs/firefox-assets.md`](docs/firefox-assets.md) records what Sval does
  with each piece of Firefox's art.
- [`docs/outbound-links.md`](docs/outbound-links.md) goes through the links
  in Firefox's interface that lead to Mozilla or other companies, and what
  Sval does with each one.
- [`docs/webdriver-bidi.md`](docs/webdriver-bidi.md) explains how to drive
  Sval with WebDriver BiDi.

## License

Sval's own code is licensed under the
[GNU Affero General Public License, version 3 only](LICENSES/AGPL-3.0-only.txt),
with the [Sval App Store Permission](LICENSES/AdditionRef-sval-app-store.txt).
That permission lets anyone distribute Sval, or work based on it, through app
stores. Mozilla's code stays under the
[Mozilla Public License 2.0](LICENSES/MPL-2.0.txt), as do Sval's changes to
it.

Sval's name and brand art are reserved, so a modified version has to use its
own name and art. [`TRADEMARKS.md`](TRADEMARKS.md) explains the details, and
[`LICENSING.md`](LICENSING.md) sets out which license covers which files.
