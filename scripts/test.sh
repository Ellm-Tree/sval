#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Run Sval's test suites, one run at a time across every worktree.
#
# Always use this instead of `./mach test` directly. Mozilla's harness asserts
# at the end of every browser-chrome test that the browser has gone idle
# (`ensureVsyncDisabled` in testing/mochitest/browser-test.js), and with two
# runs sharing one machine a browser that would have settled in a second does
# not settle inside the harness's five. The result is a red suite in which no
# Sval assertion failed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"
# Each worktree has its own build tree, but they all share one CPU, so the lock
# lives in the git directory every worktree has in common.
COMMON="$(cd "$REPO_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
LOCK="$COMMON/sval-test.lock"

if [[ ! -f "$SRC/mach" ]]; then
  echo "error: no build tree at $SRC; scripts/build-worktree.sh makes one" >&2
  exit 1
fi

# A test path names a file in the build tree (`browser/components/sval/...`).
# Sval's own files live under chrome/ in the repository and sync-files.sh
# copies them to the same path without the prefix, so a chrome/ path is read
# as the build tree's. A test file that is not there fails the run here,
# before it waits on the lock: `mach test` would only say "UNKNOWN TEST" once
# the lock was its turn.
args=()
missing=()
for arg in "$@"; do
  if [[ "$arg" == chrome/* && -e "$REPO_ROOT/$arg" ]]; then
    arg="${arg#chrome/}"
  fi
  case "$arg" in
    -*) ;;
    *.js | *.toml | *.html | *.xhtml | *.xul)
      [[ -e "$SRC/$arg" || -e "$arg" ]] || missing+=("$arg")
      ;;
  esac
  args+=("$arg")
done
if ((${#missing[@]})); then
  echo "error: no such test file in the build tree ($SRC):" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo "       A new file reaches it through scripts/sync-files.sh." >&2
  exit 1
fi
set -- ${args[@]+"${args[@]}"}

# The engine a run tests is the wasm last staged and synced, which nothing
# rebuilds when engine/ changes: sync-files.sh never overwrites a real
# artifact. build-core-wasm.sh compiles engine/'s tree id at HEAD into it as
# the string engineVersion() returns, with -dirty for a build
# of uncommitted changes, so a wasm that lacks HEAD's id was built from other
# engine code. The wasm holds other 40-digit hex strings, so the check looks
# for the id it expects. sync-files.sh's stub is an empty module, eight bytes
# long, and tests that never load the engine still run on it.
check_engine_tree() {
  local wasm="$1" want
  [[ -f "$wasm" && "$(wc -c <"$wasm" | tr -d ' ')" -gt 8 ]] || return 0
  want="$(git -C "$REPO_ROOT" rev-parse HEAD:engine)"
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no -- engine)" ]]; then
    want="$want-dirty"
  fi
  if ! LC_ALL=C grep -aqF -- "$want" "$wasm" ||
    { [[ "$want" != *-dirty ]] && LC_ALL=C grep -aqF -- "$want-dirty" "$wasm"; }; then
    echo "error: $wasm was built from another engine/ tree than $want." >&2
    echo "       Rebuild the engine: scripts/build-core-wasm.sh, then scripts/sync-files.sh." >&2
    exit 1
  fi
}
check_engine_tree "$REPO_ROOT/chrome/browser/components/sval/sval_core_bg.wasm"
check_engine_tree "$SRC/browser/components/sval/sval_core_bg.wasm"

# A running dev browser competes for the same CPU and GPU as the harness, and
# the lock cannot see it. A test run's own browser starts with -marionette,
# which run.sh never passes, so another worktree's run waiting on the lock
# below is not warned about.
if pgrep -f 'dist/Sval.app/Contents/MacOS/(sval|firefox)( |$)' 2>/dev/null \
  | xargs -I{} ps -o command= -p {} 2>/dev/null | grep -qv -- '-marionette'; then
  echo "warning: a dev browser from scripts/run.sh is running." >&2
  echo "         It competes for CPU with the harness and can make the idle" >&2
  echo "         checks at the end of a browser-chrome test fail spuriously." >&2
  echo "         Quit it if a run fails in ways that mention vsync." >&2
fi

exec 9>"$LOCK"

# `flock` is util-linux and absent on macOS, so the lock is taken through
# Python's fcntl on the inherited descriptor. The lock belongs to the open file
# description, which this shell holds open on fd 9, so it survives the Python
# process exiting and is released when the last process holding fd 9 exits.
# The harness is therefore started with fd 9 closed (below): only this script
# holds the lock, and a harness process that outlives its run cannot keep it.
#
# fcntl is POSIX-only and does not exist in MozillaBuild's Python on Windows.
# There the lock is skipped with a warning: the Windows CI runner executes one
# job at a time, so two runs cannot share it.
if python3 -c 'import fcntl' 2>/dev/null; then
  if ! python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null; then
    echo "another test run holds the lock; waiting for it to finish…" >&2
    # The waiter runs in the background so that a signal reaches this script
    # while it waits, and the trap takes the waiter with it: stopping the
    # script's PID stops everything the run started, a wait included.
    python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX)' &
    waiter=$!
    trap 'kill "$waiter" 2>/dev/null; exit 130' INT
    trap 'kill "$waiter" 2>/dev/null; exit 143' TERM
    wait "$waiter"
    trap - INT TERM
  fi
  have_lock=1
else
  echo "warning: no fcntl on this platform, so concurrent runs are not" >&2
  echo "         prevented. Two at once compete for one machine and" >&2
  echo "         produce red suites in which no sval assertion failed." >&2
fi

# The harness launches the build's bundle, which a launch registers with Launch
# Services, so it gets the dev identity first as run.sh's does
# (give_dev_identity). A tree with no configured objdir has no bundle to launch.
if [[ "$(uname -s)" == Darwin ]] &&
  OBJDIR="$(cd "$SRC" && ./mach environment --format json 2>/dev/null |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["topobjdir"])' 2>/dev/null)"; then
  # shellcheck source=scripts/lib/launch.sh
  source "$REPO_ROOT/scripts/lib/launch.sh"
  APP="$(built_app "$OBJDIR")"
  if [[ -d "$APP" && "$APP" == *.app ]] && ! give_dev_identity "$APP"; then
    echo "error: could not give $APP the dev identity" >&2
    exit 1
  fi
fi

# On macOS the suites run headless unless SVAL_TEST_HEADED=1. A headed
# browser-chrome run raises its window before every test and waits for focus,
# so on a developer's Mac it takes the keyboard from whatever they are typing
# into, and stalls whenever they take it back. Headless Firefox simulates focus
# itself (widget/headless/HeadlessWidget.cpp, RaiseWindow activates the window
# with no OS window behind it), so the focus waits pass. CI is unaffected:
# Linux runs on its own Xvfb display and Windows needs the real desktop
# session.
if [[ "$(uname -s)" == Darwin && "${SVAL_TEST_HEADED:-}" != 1 ]]; then
  export MOZ_HEADLESS=1
fi

# A run stopped by SIGKILL leaves its temporary directory behind (below), and
# on macOS a run that ends normally sometimes leaves an empty one holding
# TemporaryItems. The lock admits one run at a time across every worktree, so
# once this run holds it, every run directory still there is a finished run's,
# and goes before this run makes its own. Without the lock, another run's may
# be in use, so they stay.
if [[ -n "${have_lock:-}" ]]; then
  case "$(uname -s)" in
    Darwin)
      stale=("$(getconf DARWIN_USER_TEMP_DIR)"sval-test-run.*
        "$(getconf DARWIN_USER_CACHE_DIR)"sval-test-run.*
        "$(getconf DARWIN_USER_DIR)"sval-test-run.*)
      ;;
    *) stale=("${TMPDIR:-/tmp}"/sval-test-run.*) ;;
  esac
  chmod -R u+rwx "${stale[@]}" 2>/dev/null || true
  rm -rf "${stale[@]}" 2>/dev/null || true
fi

# Each run has a temporary directory of its own, which the harness, the
# browser and every test write their temporary files into, and which is
# removed when the run ends, however it ends short of SIGKILL. Nothing written
# there reaches another run, and no test has to remove what it made.
#
# The harness's Python finds it through TMPDIR (`tempfile.gettempdir`), and so
# does Gecko on Linux (`OS_TemporaryDirectory` in
# xpcom/io/SpecialSystemDirectory.cpp). On Windows, Gecko asks GetTempPathW,
# which reads TMP, then TEMP; there each gets the path in the mixed form
# (C:/...), which MozillaBuild's shell and native programs both open. On macOS,
# Gecko asks NSTemporaryDirectory (`DarwinFileUtils::GetTemporaryDirectory`),
# which ignores TMPDIR and answers confstr(_CS_DARWIN_USER_TEMP_DIR). libSystem
# appends DIRHELPER_USER_DIR_SUFFIX to that directory, and to
# _CS_DARWIN_USER_CACHE_DIR's and _CS_DARWIN_USER_DIR's, making each on first
# use, so naming the run's directory there points Gecko at it, and the other
# two directories it makes go with the run too. `getconf` reports the directories without the suffix.
case "$(uname -s)" in
  Darwin)
    RUN_TEMP="$(mktemp -d "$(getconf DARWIN_USER_TEMP_DIR)sval-test-run.XXXXXX")"
    export DIRHELPER_USER_DIR_SUFFIX="${RUN_TEMP##*/}"
    RUN_CACHE="$(getconf DARWIN_USER_CACHE_DIR)$DIRHELPER_USER_DIR_SUFFIX"
    RUN_USER_DIR="$(getconf DARWIN_USER_DIR)$DIRHELPER_USER_DIR_SUFFIX"
    ;;
  MSYS_NT* | MINGW*)
    RUN_TEMP="$(cygpath -m "$(mktemp -d -t sval-test-run.XXXXXX)")"
    export TMP="$RUN_TEMP" TEMP="$RUN_TEMP"
    ;;
  *)
    RUN_TEMP="$(mktemp -d -t sval-test-run.XXXXXX)"
    ;;
esac
export TMPDIR="$RUN_TEMP"
# Sync tests take permissions off files they made, so the run gives them back
# before it removes the directory.
remove_run_temp() {
  local dirs=("$RUN_TEMP" ${RUN_CACHE:+"$RUN_CACHE"} ${RUN_USER_DIR:+"$RUN_USER_DIR"})
  chmod -R u+rwx "${dirs[@]}" 2>/dev/null || true
  rm -rf "${dirs[@]}" 2>/dev/null || true
}
# stop_run, defined below, stops what the run started before its directory
# goes, so nothing writes into it after the removal.
on_exit() {
  if declare -F stop_run >/dev/null; then stop_run || true; fi
  remove_run_temp
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The harness gives each run its own profile, but Gecko keeps crash reports,
# pending pings and the background tasks' profiles beside the profiles, in a
# directory named by the compiled-in identity: Firefox's, in an artifact
# build. MOZ_APP_DATA and MOZ_LOCAL_APP_DATA replace it
# (nsXREDirProvider::GetUserDataDirectory), so a run on a developer's Mac stays
# out of ~/Library/Application Support/Firefox, and each run starts with none
# of an earlier run's. CI machines have no one's Firefox on them, and keep
# Gecko's own layout.
if [[ "$(uname -s)" == Darwin ]]; then
  export MOZ_APP_DATA="${MOZ_APP_DATA:-$RUN_TEMP/appdata}"
  export MOZ_LOCAL_APP_DATA="${MOZ_LOCAL_APP_DATA:-$RUN_TEMP/appdata-local}"
  mkdir -p "$MOZ_APP_DATA" "$MOZ_LOCAL_APP_DATA"
fi

# When a test times out on macOS or Linux, the mochitest harness profiles the
# hung browser for ten seconds through the profiler's SIGUSR1 and SIGUSR2
# handlers, and the profiler writes the result to MOZ_UPLOAD_DIR, falling back
# to the user's Downloads directory (`profiler_find_dump_path` in
# tools/profiler/core/platform.cpp). Each run gets the worktree's own upload
# directory, emptied as the run starts, and the run names any profile left in
# it. Setting it also lets the harness symbolicate those profiles. Windows gets
# no hang profile, and Gecko asserts on the forward slashes of an MSYS path in
# MOZ_UPLOAD_DIR, so it is left alone there.
case "$(uname -s)" in
  Darwin | Linux)
    if [[ -z "${MOZ_UPLOAD_DIR:-}" ]]; then
      export MOZ_UPLOAD_DIR="$REPO_ROOT/build/test-upload"
      rm -rf "$MOZ_UPLOAD_DIR"
    fi
    mkdir -p "$MOZ_UPLOAD_DIR"
    ;;
esac

# SVAL_TEST_COVERAGE=<dir> leaves the run's JavaScript line coverage in <dir>,
# as LCOV. SpiderMonkey writes one `.info` file there for each JS runtime as it
# is torn down when JS_CODE_COVERAGE_OUTPUT_DIR is set, in any build
# (`js::coverage::InitLCov`). Files are named by URL (moz-src:///, chrome://,
# resource://), or by path for a test's own scripts. The harnesses'
# --jscov-dir-prefix is not used: in this tree nothing reads what it sets.
if [[ -n "${SVAL_TEST_COVERAGE:-}" ]]; then
  mkdir -p "$SVAL_TEST_COVERAGE"
  JS_CODE_COVERAGE_OUTPUT_DIR="$(cd "$SVAL_TEST_COVERAGE" && pwd -P)"
  export JS_CODE_COVERAGE_OUTPUT_DIR
fi

# On macOS the harness symbolicates a hang profile with mozgeckoprofiler's
# vendored dump_syms_mac (`OSXSymbolDumper`), an x86_64 binary that an arm64
# Mac without Rosetta cannot run. Bootstrap installs Mozilla's dump_syms built
# for the host, which takes the same `-a <arch> <file>` arguments and prints
# the same MODULE line, so it stands in for the vendored one.
# apply-patches.sh's reset restores the original. A tree without the vendored
# one, such as test-runner-test.sh's fake tree, is left as it is.
dump_syms="${MOZBUILD_STATE_PATH:-$HOME/.mozbuild}/dump_syms/dump_syms"
dump_syms_mac="$SRC/testing/mozbase/mozgeckoprofiler/mozgeckoprofiler/dump_syms_mac"
if [[ "$(uname -s)" == Darwin && -x "$dump_syms" && -e "$dump_syms_mac" ]]; then
  ln -sf "$dump_syms" "$dump_syms_mac"
fi

# Mozilla's mochitest command leaves the browser open after a run of one
# mochitest-plain file unless it is told otherwise or given --headless
# (`run_mochitest_general` in testing/mochitest/mach_commands.py), and
# MOZ_HEADLESS is not --headless. No one is there to close it, so the
# harness waits out its 370 s output timeout and fails a run whose test
# passed. `--keep-open=false` closes it.
#
# `--compare-preferences` makes the harness fail a file for each pref it left
# changed (`checkPreferencesAfterTest` in testing/mochitest/browser-test.js),
# which without it is only a todo. Prefs one file leaves changed are the
# state the next file runs in, so a leftover is a failure in Sval's own files.
# Mozilla's suites run as Mozilla's CI runs them, without it: its mochitest
# jobs never pass the flag, and its files leave prefs Firefox itself writes.
#
# Only the mochitest command accepts these flags, and `mach test` hands its
# extra arguments to every suite it runs, so they go only to a run whose
# every test is a mochitest: a markup or browser-chrome file, or a directory
# holding a browser-chrome manifest and no xpcshell one.
mochitests_only=false
sval_only=true
for arg in "$@"; do
  case "$arg" in
    -* | browser/components/sval/*) ;;
    *) sval_only=false ;;
  esac
done
# A markup file is a mochitest when a mochitest manifest beside it lists
# it; a crashtest or reftest is listed in a `.list` file instead, and its
# suite refuses the mochitest flags.
listed_mochitest() {
  local dir="$SRC/$(dirname "$1")" name
  name="$(basename "$1")"
  grep -qsF -- "[\"$name\"]" "$dir"/*.toml
}
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    */browser_*.js | browser_*.js) mochitests_only=true ;;
    *.html | *.xhtml | *.xul)
      if listed_mochitest "$arg"; then
        mochitests_only=true
      else
        mochitests_only=false
        break
      fi
      ;;
    *)
      dir="$SRC/${arg%/}"
      if [[ -d "$dir" ]] && compgen -G "$dir/browser*.toml" >/dev/null \
        && [[ -z "$(find "$dir" -name 'xpcshell*.toml' -print -quit)" ]]; then
        mochitests_only=true
      else
        mochitests_only=false
        break
      fi
      ;;
  esac
done
if [[ "$mochitests_only" == true ]]; then
  set -- "$@" --keep-open=false
  if [[ "$sval_only" == true ]]; then
    set -- "$@" --compare-preferences
  fi
fi

# Mozilla's mochitest runs a manifest's `scheme = "https"` tests in a second
# launch of the same profile, after its http ones (`runTests` in
# testing/mochitest/runtests.py). Sval reopens a profile's tabs at launch, so
# that launch reopens the first one's test page, which runs its tests again
# and quits the browser while the harness is still installing its add-ons.
# So the https tests run in a harness, and a profile, of their own.
#
# plan_runs <args> sets https_tests, first_run and https_run for run_harness.
# A re-run of failed files (below) plans again with its own arguments.
#
# Every Python here whose lines bash reads ends them with "\n" alone. On
# Windows, Python's text-mode stdout writes "\r\n", `read -r` keeps the "\r"
# in the path, and `mach test` answers such a path with UNKNOWN TEST, runs
# nothing for it, and exits 0.
plan_runs() {
https_tests=()
while IFS= read -r test; do
  [[ -n "$test" ]] && https_tests+=("$test")
done < <(python3 - "$SRC" "$@" <<'PY'
import pathlib, sys, tomllib
sys.stdout.reconfigure(newline="\n")
src = pathlib.Path(sys.argv[1])
def https_in(manifest):
    try:
        data = tomllib.loads(manifest.read_text())
    except (OSError, tomllib.TOMLDecodeError):
        return []
    default = data.get("DEFAULT", {}).get("scheme")
    return [
        name
        for name, entry in data.items()
        if name != "DEFAULT"
        and isinstance(entry, dict)
        and entry.get("scheme", default) == "https"
    ]

for arg in sys.argv[2:]:
    if arg.startswith("-"):
        continue
    path = src / arg
    # A directory goes to the harness whole, which runs its https tests in
    # its own second launch, so it is refused: its files are named instead.
    if path.is_dir():
        held = [
            f"{manifest.parent.relative_to(src)}/{name}"
            for manifest in sorted(path.rglob("*.toml"))
            for name in https_in(manifest)
        ]
        if held:
            print(
                f"test.sh: {arg} holds {len(held)} https-scheme test(s), "
                "which must run in a launch of their own; name its files "
                f"instead, for example {held[0]}",
                file=sys.stderr,
            )
            print("!refused")
            sys.exit()
        continue
    if not arg.endswith((".html", ".xhtml")):
        continue
    for manifest in sorted(path.parent.glob("*.toml")):
        try:
            data = tomllib.loads(manifest.read_text())
        except (OSError, tomllib.TOMLDecodeError):
            continue
        entry = data.get(path.name)
        if entry is None:
            continue
        default = data.get("DEFAULT", {})
        if entry.get("scheme", default.get("scheme")) == "https":
            print(arg)
            break
PY
)
# bash cannot see the exit status of a process substitution, so a refusal
# is a line of its own.
if [[ " ${https_tests[*]-} " == *" !refused "* ]]; then
  exit 2
fi
first_run=()
https_run=()
for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    first_run+=("$arg")
    https_run+=("$arg")
  elif printf '%s\n' "${https_tests[@]+"${https_tests[@]}"}" | grep -qxF -- "$arg"; then
    https_run+=("$arg")
  else
    first_run+=("$arg")
  fi
done
if ((${#https_tests[@]})); then
  if [[ " ${https_run[*]} " != *" --keep-open=false "* ]]; then
    https_run+=(--keep-open=false)
  fi
  # A first run that is only options has no tests of its own to run.
  only_options=true
  for arg in "${first_run[@]}"; do
    [[ "$arg" == -* ]] || only_options=false
  done
  if [[ "$only_options" == true ]]; then
    first_run=()
  fi
fi
}
plan_runs "$@"

# Runs the harness once, or twice when https tests run apart, and exits with
# the first failure's status. The second run's log is not budget-reported:
# it holds markup tests only.
run_harness() {
  local result=0
  if ((${#first_run[@]})) || ! ((${#https_tests[@]})); then
    ./mach test --log-raw "$RAW_LOG" "${first_run[@]+"${first_run[@]}"}" || result=$?
  fi
  if ((${#https_tests[@]})); then
    ./mach test --log-raw "$RAW_LOG.https" "${https_run[@]}" || {
      local https_status=$?
      ((result)) || result=$https_status
    }
  fi
  # `mach test` can exit 0 from a crashtest or reftest run whose structured
  # log records unexpected results, so the log has the last word.
  if ((result == 0)) && [[ -n "$(failed_files "$RAW_LOG" "$RAW_LOG.https")" ]]; then
    result=1
  fi
  return "$result"
}

# With SVAL_TEST_RETRY_FAILURES=1, CI's setting, a run that fails runs the
# files that failed once more, alone, and passes if they all pass then. Such a
# file is flaky: it is named as one, and recorded as one for CI to report,
# which opens an issue for it. A failure the
# structured log cannot pin on a test file (a crash after the tests, the dump
# of a browser killed for hanging), or more than
# three failed files, is not re-run: that many at once is a real break, and
# the re-run would only cost time.
#
# SVAL_TEST_RESULTS_OUT=<file> gets one JSON line per failed file:
# {"file": <path>, "result": "flaky" | "failed"}, or {"result": "unattributed"}
# for a failure the log does not pin on a file.
record() {
  [[ -n "${SVAL_TEST_RESULTS_OUT:-}" ]] || return 0
  python3 -c 'import json, sys; print(json.dumps({k: v for k, v in zip(("result", "file"), sys.argv[1:])}))' \
    "$@" >>"$SVAL_TEST_RESULTS_OUT"
}

# The files the run's structured logs record an unexpected result for, one per
# line, as the tree names them. Exits 1 if a failure names no file in the tree.
failed_files() {
  python3 - "$@" <<'PY'
import json
import os
import sys

sys.stdout.reconfigure(newline="\n")
failed, unattributed = [], False
for path in sys.argv[1:]:
    try:
        log = open(path, encoding="utf-8")
    except OSError:
        continue
    with log:
        for line in log:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            action = event.get("action")
            unexpected = (
                action in ("test_end", "test_status") and "expected" in event
            ) or action == "crash"
            if not unexpected:
                continue
            test = event.get("test")
            # A crash outside a test, such as the dump of a browser the
            # harness killed for hanging, is logged against the manifest that
            # was running (Mochitest.runApp), and a manifest names no one
            # file: re-run, it runs every test it lists.
            if (
                isinstance(test, str)
                and os.path.isfile(test)
                and not test.endswith(".toml")
            ):
                if test not in failed:
                    failed.append(test)
            else:
                unattributed = True
print("\n".join(failed))
sys.exit(1 if unattributed or not failed else 0)
PY
}

# The files the run's structured logs record a test_end for, one per line, as
# the tree names them.
ran_files() {
  python3 - "$@" <<'PY'
import json
import sys

sys.stdout.reconfigure(newline="\n")
ran = set()
for path in sys.argv[1:]:
    try:
        log = open(path, encoding="utf-8")
    except OSError:
        continue
    with log:
        for line in log:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("action") == "test_end" and isinstance(event.get("test"), str):
                ran.add(event["test"])
print("\n".join(sorted(ran)))
PY
}

# Of the test paths in the arguments after "--", those the logs before it
# record no result for, one per line: `mach test` exits 0 for a path it
# cannot resolve. A manifest condition that skips a test logs its test_end as
# SKIP (`logPreamble` in testing/mochitest/runtests.py,
# `XPCShellTests.runTests`), which is a result, since the manifest decided
# it; with SVAL_TEST_REQUIRE_RUN=1 it is not, for a run whose every named
# test must check something on this platform. A directory or manifest passes
# when any test under it has a result.
unrun_paths() {
  python3 - "$@" <<'PY'
import json
import os
import sys

sys.stdout.reconfigure(newline="\n")
require_run = os.environ.get("SVAL_TEST_REQUIRE_RUN") == "1"
split = sys.argv.index("--")
logs, args = sys.argv[1:split], sys.argv[split + 1 :]

def norm(path):
    return os.path.normpath(path.replace("\\", "/")).replace("\\", "/")

# The path a log's test id names. XPCShell ids a test listed in two manifests
# "<manifest>:<path>" (`XPCShellTests.normalizeTest`), and Marionette ids
# each test method "<path> <class>.<method>" (`CommonTestCase.test_name`),
# its path relative to the harness's working directory, the objdir inside the
# tree (`CommonTestCase._fix_test_path`), so it starts with "../".
def test_path(test):
    test = test.split(" ", 1)[0]
    manifest, sep, path = test.partition(":")
    path = norm(path if sep and manifest.endswith(".toml") else test)
    while path.startswith("../"):
        path = path[3:]
    return path

ran = set()
for path in logs:
    try:
        log = open(path, encoding="utf-8")
    except OSError:
        continue
    with log:
        for line in log:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            test = event.get("test")
            if (
                event.get("action") == "test_end"
                and isinstance(test, str)
                and not (require_run and event.get("status") == "SKIP")
            ):
                ran.add(test_path(test))
for arg in args:
    if arg.startswith("-") or not os.path.exists(arg):
        continue
    path = norm(arg)
    if os.path.isdir(arg) or arg.endswith(".toml"):
        under = norm(os.path.dirname(path)) if arg.endswith(".toml") else path
        if not any(test.startswith(under + "/") for test in ran):
            print(arg)
    elif path not in ran:
        print(arg)
PY
}

# run_harness, and on a failure with SVAL_TEST_RETRY_FAILURES=1, the re-run.
# Its arguments are the run's own, so the re-run keeps every option (and an
# option's value, such as --threads 8): only a test path is swapped for the
# files that failed. The files go first, as in the run's own arguments:
# `mach test` takes its test paths before the harness's options, and an
# option ahead of them leaves its value read as a test path and the option
# handed to whichever harness that path resolves to.
run_with_retry() {
  local status=0
  run_harness || status=$?
  if ((status == 0)); then
    local unrun path
    unrun="$(unrun_paths "$RAW_LOG" "$RAW_LOG.https" -- "$@")"
    [[ -z "$unrun" ]] && return 0
    while IFS= read -r path; do
      record failed "$path"
      echo "NOT RUN: $path was named, and the run's log has no result for it." >&2
    done <<<"$unrun"
    return 1
  fi
  local files=() file files_out
  if ! files_out="$(failed_files "$RAW_LOG" "$RAW_LOG.https")"; then
    while IFS= read -r file; do [[ -n "$file" ]] && record failed "$file"; done <<<"$files_out"
    record unattributed
    return "$status"
  fi
  while IFS= read -r file; do files+=("$file"); done <<<"$files_out"
  if [[ "${SVAL_TEST_RETRY_FAILURES:-}" != 1 ]] || ((${#files[@]} > 3)); then
    for file in "${files[@]}"; do record failed "$file"; done
    return "$status"
  fi
  local args=() arg
  for arg in "$@"; do
    [[ -e "$arg" ]] || args+=("$arg")
  done
  echo "" >&2
  echo "Re-running the ${#files[@]} failed file(s) once, alone, to tell a flake from a failure:" >&2
  printf '  %s\n' "${files[@]}" >&2
  # Local, so budget_report still reads the first run's log.
  local RAW_LOG="$RAW_LOG.retry"
  rm -f "$RAW_LOG" "$RAW_LOG.https"
  plan_runs "${files[@]}" "${args[@]+"${args[@]}"}"
  local retry_status=0
  run_harness || retry_status=$?
  local still="" ran=""
  still="$(failed_files "$RAW_LOG" "$RAW_LOG.https")" || true
  ran="$(ran_files "$RAW_LOG" "$RAW_LOG.https")" || true
  for file in "${files[@]}"; do
    # A file the re-run's log has no test_end for did not run, so it did not
    # pass: `mach test` exits 0 for a path it cannot resolve.
    if ! grep -qxF -- "$file" <<<"$ran"; then
      record failed "$file"
      echo "NOT RE-RUN: $file failed, and the re-run's log has no result for it." >&2
      ((retry_status)) || retry_status=$status
    elif ((retry_status)) && { [[ -z "$still" ]] || grep -qxF -- "$file" <<<"$still"; }; then
      record failed "$file"
    else
      record flaky "$file"
      echo "FLAKY: $file failed, then passed when re-run alone." >&2
    fi
  done
  return "$retry_status"
}

cd "$SRC"

# After a browser-chrome run, each file's time against its limit: 45 seconds
# times the largest `requestLongerTimeout` factor the file asks for. The
# harness fails a file that stops logging, never one that runs long, so the
# limit is a yardstick here: the report marks a file over 75% as slow, for a
# reader to split if its own work is what takes the time. It reads the run's structured log, which `--log-raw` writes
# beside the harness's usual output and which names each file as the tree
# holds it, so a run of one file and a run of the suite report alike. The path
# is relative because MozillaBuild's Python on Windows cannot open a POSIX
# one.
#
# The report only informs: a file's time swings with the runner's load, so
# failing a run over it would add a flake of its own. With SVAL_BUDGET_OUT
# set, the rows are also written there as JSON lines, which the daily run on
# main collects to file an issue for a file that stays over 75%.
RAW_LOG="../test-raw.log"
rm -f "$RAW_LOG" "$RAW_LOG.https"
budget_report() {
  [[ -s "$RAW_LOG" ]] || return 0
  python3 - "$RAW_LOG" "${SVAL_BUDGET_OUT:-}" <<'PY' || true
import json
import os
import re
import sys

LIMIT_S = 45
FLAG = 0.75
started = {}
rows = []
with open(sys.argv[1], encoding="utf-8") as log:
    for line in log:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        test = event.get("test")
        if not isinstance(test, str) or not os.path.basename(test).startswith("browser_"):
            continue
        if event.get("action") == "test_start":
            started[test] = event["time"]
        elif event.get("action") == "test_end" and test in started:
            rows.append((test, (event["time"] - started.pop(test)) / 1000))
if not rows:
    sys.exit(0)


def factor(test):
    try:
        with open(test, encoding="utf-8") as source:
            found = re.findall(r"requestLongerTimeout\(\s*(\d+(?:\.\d+)?)\s*\)", source.read())
    except OSError:
        return 1
    return max([1.0] + [float(f) for f in found])


report = []
for test, seconds in rows:
    limit = LIMIT_S * factor(test)
    report.append((seconds / limit, seconds, limit, os.path.basename(test)))
report.sort(reverse=True)
print("")
print(f"Each browser-chrome file's time against its limit ({LIMIT_S} s x its requestLongerTimeout factor):")
for share, seconds, limit, name in report:
    mark = "  slow" if share > FLAG else ""
    print(f"  {share:4.0%}  {seconds:6.1f} s of {limit:3.0f} s  {name}{mark}")
if sys.argv[2]:
    with open(sys.argv[2], "a", encoding="utf-8") as out:
        for share, seconds, limit, name in report:
            out.write(json.dumps({"file": name, "seconds": round(seconds, 1), "limit": limit}) + "\n")
PY
}

# Without the lock there is nothing for a stray process to hold, and the
# cleanup below relies on POSIX `ps`, so the harness runs with nothing to stop
# after it.
if ! python3 -c 'import fcntl' 2>/dev/null; then
  status=0
  run_with_retry "$@" || status=$?
  budget_report
  exit "$status"
fi

# A run is stopped with everything it started. The harness puts its children
# in sessions of their own (mozprocess runs them under `os.setsid`), so neither
# a process group nor the process tree reaches all of them once their parent
# is gone. Each run instead marks its harness with a token in the environment,
# which every descendant inherits, and the processes still carrying it are
# stopped when this script exits, however it exits short of SIGKILL. A SIGKILL
# leaves them running, but with fd 9 closed they cannot hold the lock.
#
# The token cannot be read from every process, so the harness's process tree
# is stopped with it. The subshell that runs the harness is forked without an
# exec, so the environment the kernel reports for it is this script's, which
# has no token; and macOS 26 `ps -E` shows no environment for a platform
# binary such as /bin/bash or /bin/sleep.
RUN_TOKEN="$$-$(date +%s)-$RANDOM"

run_pids() {
  local token="SVAL_TEST_RUN=$RUN_TOKEN"
  if [[ -d /proc/self ]]; then
    # Linux: each process's environment, one NUL-separated entry per variable.
    # Only this user's processes are readable, which are the only ones a run
    # starts. The others make grep exit 2, which is not a failure here.
    { grep -lzx -- "$token" /proc/[0-9]*/environ 2>/dev/null || true; } |
      awk -F/ -v self="$$" '$3 != self { print $3 }'
  else
    # macOS: `-E` appends each process's environment to its command. awk
    # gets the token in two parts, so its own command line, which `ps` also
    # lists, never carries the whole of it.
    { ps -axwwE -o pid=,command= 2>/dev/null || true; } |
      awk -v run="$RUN_TOKEN" -v self="$$" \
        'index($0, "SVAL_TEST_RUN=" run) && $1 != self { print $1 }'
  fi
}

# The harness subshell and its descendants. `harness` is set only while the
# subshell is unreaped, so its PID cannot belong to another process.
harness_tree() {
  [[ -n "${harness:-}" ]] || return 0
  { ps -A -o pid=,ppid= 2>/dev/null || true; } | awk -v root="$harness" '
    { parent[$1] = $2 }
    END {
      for (p in parent) {
        q = p
        while (q != root && q in parent && q > 1) q = parent[q]
        if (q == root) print p
      }
    }'
}

# Of the PIDs given, one per line, those still running. A zombie runs nothing
# and holds no files.
running() {
  local list
  list="$(paste -sd, -)"
  [[ -n "$list" ]] || return 0
  { ps -o pid=,stat= -p "$list" 2>/dev/null || true; } | awk '$2 !~ /^Z/ { print $1 }'
}

stop_run() {
  # The tree is read before anything is stopped: a stopped parent's children
  # are re-parented and drop out of it.
  local started pids
  started="$({ run_pids; harness_tree; } | sort -u)"
  [[ -z "$started" ]] && return 0
  # shellcheck disable=SC2086
  kill -TERM $started 2>/dev/null || true
  for _ in $(seq 50); do
    pids="$({ printf '%s\n' "$started"; run_pids; } | sort -u | running)"
    [[ -z "$pids" ]] && return 0
    sleep 0.1
  done
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
}

(
  export SVAL_TEST_RUN="$RUN_TOKEN"
  run_with_retry "$@"
) 9>&- &
harness=$!
status=0
wait "$harness" || status=$?
harness=

budget_report

hang_profiles="$(find "${MOZ_UPLOAD_DIR:-/nonexistent}" -maxdepth 1 -name 'profile_*.json' 2>/dev/null)"
if [[ -n "$hang_profiles" ]]; then
  echo "" >&2
  echo "A test timed out. Profiles of the hung browser, for profiler.firefox.com:" >&2
  sed 's/^/  /' <<<"$hang_profiles" >&2
fi

exit "$status"
