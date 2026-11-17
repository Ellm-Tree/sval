#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Lint Sval's own code with the upstream tree's linters, check every file's
# license notice and the comments the branch changes. CI runs exactly this.
#
# Run scripts/sync-files.sh first: the linters read the copy in build/firefox.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"

# License notices are checked in the repository itself, over every file, by
# Sval's own check. Mozilla's `license` linter is not in the list below: it
# accepts only the strings in the upstream tree's
# tools/lint/license/valid-licenses.txt, Sval's app store permission is not
# one of them, and adding it would mean patching Mozilla's tree.
license_status=0
python3 "$REPO_ROOT/scripts/check-licenses.py" || license_status=$?

# docs/decisions/README.md's rules, and that every cited decision exists.
decision_status=0
python3 "$REPO_ROOT/scripts/check-decisions.py" || decision_status=$?

# The comment patterns CONTRIBUTING.md bans, on the lines this branch changes, and
# its commit subjects. Both checks diff against origin/main, which CI's build job does not fetch; CI's
# fast checks job runs it with full history instead.
comment_status=0
if git -C "$REPO_ROOT" rev-parse --verify -q origin/main >/dev/null; then
  python3 "$REPO_ROOT/scripts/check-comments.py" || comment_status=$?
  python3 "$REPO_ROOT/scripts/check-commit-msg.py" || comment_status=$?
else
  echo "lint: no origin/main, so the comment check is left to CI's fast checks job" >&2
fi

# A CSS mask draws no part of an icon painted with context paint alone
# (scripts/check-mask-icons.py says why).
mask_status=0
python3 "$REPO_ROOT/scripts/check-mask-icons.py" || mask_status=$?

# docs/writing-style.md's mechanical rules on the docs, with Vale.
prose_status=0
"$REPO_ROOT/scripts/check-prose.sh" || prose_status=$?
# A check whose pattern stops matching passes every file, so the license check
# has a self-test of shapes it must flag and near-misses it must pass. Sval's
# lint rules have theirs below, once the linters are installed.
checker_status=0
python3 "$REPO_ROOT/scripts/check-licenses-test.py" || checker_status=$?
python3 "$REPO_ROOT/scripts/check-comments-test.py" || checker_status=$?
python3 "$REPO_ROOT/scripts/check-decisions-test.py" || checker_status=$?
python3 "$REPO_ROOT/scripts/check-commit-msg-test.py" || checker_status=$?
python3 "$REPO_ROOT/scripts/check-mask-icons-test.py" || checker_status=$?
python3 "$REPO_ROOT/scripts/check-css-tokens-test.py" || checker_status=$?
python3 "$REPO_ROOT/scripts/check-ui-labels-test.py" || checker_status=$?

# The self-tests of any scripts/ci-*.py present.
for test in "$REPO_ROOT"/scripts/ci-*-test.py; do
  [[ -e "$test" ]] || continue
  python3 "$test" || checker_status=$?
done

# scripts/test-runner-test.sh needs no build tree.
runner_status=0
"$REPO_ROOT/scripts/test-runner-test.sh" || runner_status=$?

# A dev build never carries a release's macOS identity (lib/launch.sh's
# sign_dev_bundle). The test skips elsewhere.
identity_status=0
"$REPO_ROOT/scripts/dev-identity-test.sh" || identity_status=$?

# A refused registry credential must stop the build (scripts/fetch-gecko.sh
# says why).
fetch_status=0
"$REPO_ROOT/scripts/fetch-gecko-test.sh" || fetch_status=$?

if [[ ! -f "$SRC/mach" ]]; then
  echo "error: no build tree at $SRC; scripts/build-worktree.sh makes one" >&2
  exit 1
fi

# Every linter that applies to Sval's front-end files. glean-parser and
# gecko-trace cover Glean metrics, which Sval has none of, and Sval's C++ and
# Rust are linted after these. eslint runs prettier as one of its rules. The branding directory is left out because its
# one script is a prefs file, which upstream also keeps out of eslint and
# prettier (browser/branding/**/firefox-branding.js in eslint-ignores.config.mjs).
#
# The paths are Sval's files under chrome/, tracked or new, at their place in the
# tree. The generated engine glue is gitignored, so it is never linted. Given no
# paths, mach lint falls back to whatever git says has changed and can lint
# nothing at all while reporting success, so an empty or failed listing stops
# here, and so does a run that mach reports as linting no files.
if ! files="$(git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard \
  chrome/browser/components/sval chrome/tools/lint/eslint/eslint-plugin-sval)"; then
  echo "error: git could not list Sval's files in $REPO_ROOT" >&2
  exit 1
fi
if [[ -z "$files" ]]; then
  echo "error: git lists none of Sval's files under chrome/" >&2
  exit 1
fi
# The importers' fixtures are left out: they are files the browsers wrote,
# kept byte for byte.
paths=()
while IFS= read -r file; do
  [[ "$file" == chrome/browser/components/sval/test/xpcshell/data/import/* ]] && continue
  paths+=("${file#chrome/}")
done <<<"$files"
echo "==> Linting ${#paths[@]} of Sval's files"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

cd "$SRC"
status=0
# Warnings are shown without failing the run, so sval/stale-baseline's request
# to lower a baseline entry is seen.
./mach lint \
  --warnings=soft \
  -l eslint \
  -l stylelint \
  -l file-whitespace \
  -l file-perm \
  -l test-manifest-toml \
  -l trojan-source \
  -l codespell \
  -l rejected-words \
  "$@" \
  "${paths[@]}" 2>&1 | tee "$log" || status=$?

if grep -q "no files linted" "$log"; then
  echo "error: mach lint linted no files" >&2
  exit 1
fi

# Sval's C++ and Rust in Gecko, at their place in the tree. The cssparser copy
# under chrome/build/rust is a vendored crate, kept as its authors wrote it.
if ! native="$(git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard \
  'chrome/*.cpp' 'chrome/*.h' 'chrome/*.mm' 'chrome/*.rs' \
  | grep -v '^chrome/build/rust/')"; then
  echo "error: git lists none of Sval's C++ or Rust files under chrome/" >&2
  exit 1
fi
native_paths=()
while IFS= read -r file; do
  native_paths+=("${file#chrome/}")
done <<<"$native"
./mach lint -l clang-format -l rustfmt "${native_paths[@]}" || status=$?

# Every pull request that adds a test adds a section to a suite manifest. Kept
# alphabetical, those additions land in different places and do not conflict.
# Mozilla's test-manifest-toml linter checks the order but reports it only as a
# warning, so the suite manifests are linted again with warnings failing.
manifests=(
  browser/components/sval/test/browser/browser.toml
  browser/components/sval/test/xpcshell/xpcshell.toml
)
manifest_status=0
./mach lint --warnings -l test-manifest-toml "${manifests[@]}" || manifest_status=$?
if [[ "$manifest_status" -ne 0 ]]; then
  echo "error: a test manifest has a warning above. For \"not in alphabetical order\"," >&2
  echo "       move the new [\"<test file>\"] section, with its keys and comments," >&2
  echo "       to its alphabetical place in the manifest under chrome/." >&2
  exit "$manifest_status"
fi
# Sval's own eslint rules (tools/lint/eslint/eslint-plugin-sval) ran with the
# rest above; this is their self-test, which needs the tree's eslint.
./mach node tools/lint/eslint/eslint-plugin-sval/tests/run.mjs || checker_status=$?
# A custom property Sval's CSS sets for Firefox is one the tree's Firefox
# reads (scripts/check-css-tokens.py says why).
tokens_status=0
python3 "$REPO_ROOT/scripts/check-css-tokens.py" || tokens_status=$?
# Every control a docs page names, against Sval's strings and the tree's
# Firefox strings.
labels_status=0
python3 "$REPO_ROOT/scripts/check-ui-labels.py" || labels_status=$?

if [[ "$license_status" -ne 0 ]]; then
  echo "error: scripts/check-licenses.py found files without the right license notice" >&2
  exit "$license_status"
fi
if [[ "$decision_status" -ne 0 ]]; then
  echo "error: scripts/check-decisions.py found a record or citation that breaks docs/decisions/README.md" >&2
  exit "$decision_status"
fi
if [[ "$comment_status" -ne 0 ]]; then
  echo "error: scripts/check-comments.py or check-commit-msg.py found what CONTRIBUTING.md's \"Comments\" or \"Commit messages\" section bans" >&2
  exit "$comment_status"
fi
if [[ "$labels_status" -ne 0 ]]; then
  echo "error: scripts/check-ui-labels.py found a docs page naming a control Sval does not show" >&2
  exit "$labels_status"
fi
if [[ "$prose_status" -ne 0 ]]; then
  echo "error: scripts/check-prose.sh found what docs/writing-style.md bans" >&2
  exit "$prose_status"
fi
if [[ "$tokens_status" -ne 0 ]]; then
  echo "error: scripts/check-css-tokens.py found a custom property that nothing reads" >&2
  exit "$tokens_status"
fi
if [[ "$mask_status" -ne 0 ]]; then
  echo "error: scripts/check-mask-icons.py found a mask on an icon it cannot draw" >&2
  exit "$mask_status"
fi
if [[ "$checker_status" -ne 0 ]]; then
  echo "error: a checker's self-test above failed; the check no longer finds what it is for" >&2
  exit "$checker_status"
fi
if [[ "$fetch_status" -ne 0 ]]; then
  echo "error: scripts/fetch-gecko-test.sh found fetch-gecko.sh falling back on a refused credential" >&2
  exit "$fetch_status"
fi
if [[ "$identity_status" -ne 0 ]]; then
  echo "error: scripts/dev-identity-test.sh found a dev build keeping a release's macOS identity" >&2
  exit "$identity_status"
fi
if [[ "$runner_status" -ne 0 ]]; then
  echo "error: scripts/test-runner-test.sh found scripts/test.sh leaving a run behind" >&2
  exit "$runner_status"
fi
exit "$status"
