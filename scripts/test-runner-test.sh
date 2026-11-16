#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Checks that scripts/test.sh leaves nothing behind when it is stopped, and
# that a run of mochitests alone closes the browser when it is done.
#
# The harness starts helpers in sessions of their own (mozprocess runs every
# child under `os.setsid`), so stopping the script that started them does not
# reach them, and every child inherits the script's open files. A helper that
# outlives its run would keep the shared test lock, and every worktree's next
# run would wait on a run that is over. This drives test.sh against a fake
# `mach` whose helper does exactly that, and stops it two ways.
#
# Needs bash, git, python3 with fcntl, and ps. It runs from scripts/lint.sh.
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test.sh"
# CI's test jobs set these for their own suites (CI). The fake runs here
# fail on purpose, and would otherwise record their failures as the job's.
unset SVAL_TEST_RESULTS_OUT SVAL_TEST_RETRY_FAILURES

if ! python3 -c 'import fcntl' 2>/dev/null; then
  echo "test-runner-test: no fcntl on this platform; test.sh takes no lock here, so nothing to check"
  exit 0
fi

work="$(mktemp -d)"

# Every process a stopped run started is remembered by its PID and start time,
# in one file per run, and only a process that matches both is stopped: a PID
# whose process has ended may already belong to another.
tree_of() {
  { ps -A -o pid=,ppid= 2>/dev/null || true; } | awk -v root="$1" '
    { parent[$1] = $2 }
    END {
      for (p in parent) {
        q = p
        while (q != root && q in parent && q > 1) q = parent[q]
        if (q == root) print p
      }
    }'
}
remember() {
  local list
  list="$(tree_of "$1" | paste -sd, -)"
  [[ -n "$list" ]] || return 0
  { ps -o pid=,lstart= -p "$list" 2>/dev/null || true; } |
    awk '{ pid = $1; $1 = ""; sub(/^ +/, ""); print pid " " $0 }' >>"$2"
}
# The remembered processes in the files given that still run. A zombie runs
# nothing and holds no files.
survivors() {
  local files=() f
  for f in "$@"; do [[ -s "$f" ]] && files+=("$f"); done
  ((${#files[@]})) || return 0
  cat "${files[@]}" | awk '
    NR == FNR { want[$0]; next }
    { pid = $1; stat = $2; $1 = ""; $2 = ""; sub(/^ +/, "")
      if (stat !~ /^Z/ && (pid " " $0) in want) print pid }' - <(ps -A -o pid=,stat=,lstart= 2>/dev/null || true)
}
stop_survivors() {
  local pids
  pids="$(survivors "$@")"
  [[ -n "$pids" ]] || return 0
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
  for _ in $(seq "$WAIT_TENTHS"); do
    [[ -z "$(survivors "$@")" ]] && return 0
    sleep 0.1
  done
}
# A survivor's process and the run's log, for a failure.
describe() {
  local log="$1" pids
  shift
  pids="$(survivors "$@" | paste -sd, -)"
  {
    echo "  as $(id -un):"
    [[ -n "$pids" ]] && ps -o pid,ppid,pgid,user,stat,command -p "$pids" 2>&1 | sed 's/^/  /'
    echo "  test.sh said:"
    sed 's/^/    /' "$log"
  } >&2
}

cleanup() {
  stop_survivors "$work"/started.*
  # A killed run cannot remove its temporary directory.
  local dir
  for dir in "$work"/helper.*.tmpdir; do
    [[ -s "$dir" ]] && rm -rf "$(cat "$dir")"
  done
  rm -rf "$work"
}
trap cleanup EXIT

repo="$work/repo"
mkdir -p "$repo/scripts" "$repo/build/firefox"
git -C "$repo" init -q
cp "$SCRIPT" "$repo/scripts/test.sh"

# The fake harness: a wait like a long suite, and one helper in a session of
# its own, which inherits every open file. The helper writes its PID once both
# have started.
# With ARGS_FILE set it only records its arguments. With FAIL_PLAN set too,
# its Nth run writes a structured log failing the files the plan's Nth line
# names, separated by commas ("none" fails no file, "-" passes the files it
# was given, "unknown" passes and logs no test, as `mach test` does for a path
# it cannot resolve, "skip" logs the files it was given as SKIP, as a manifest
# condition does, "ran:<id>" passes and logs the test id <id> alone, with "+"
# for a space, "crash:<path>"
# logs a crash against <path>, and
# "quiet:<path>" fails <path> but exits 0, as `mach test` can for a crashtest),
# and fails if it named any but a quiet one.
cat >"$repo/build/firefox/mach" <<'EOF'
#!/usr/bin/env bash
# An unconfigured tree, which has no bundle for test.sh to relabel.
[[ "$1" == environment ]] && exit 1
if [[ -n "${ARGS_FILE:-}" ]]; then
  { printf '%s\n' "$@"; echo "--- end of run"; } >>"$ARGS_FILE"
  [[ -n "${FAIL_PLAN:-}" ]] || exit 0
  run=$(($(grep -c -- '--- end of run' "$ARGS_FILE")))
  plan="$(sed -n "${run}p" "$FAIL_PLAN")"
  [[ -z "$plan" || "$plan" == unknown ]] && exit 0
  if [[ "$plan" == - ]]; then
    for test in "${@:4}"; do
      [[ "$test" == -* ]] && break
      printf '{"action": "test_end", "test": "%s", "status": "PASS"}\n' "$test" >>"$3"
    done
    exit 0
  fi
  if [[ "$plan" == skip ]]; then
    for test in "${@:4}"; do
      [[ "$test" == -* ]] && break
      printf '{"action": "test_end", "test": "%s", "status": "SKIP"}\n' "$test" >>"$3"
    done
    exit 0
  fi
  if [[ "$plan" == ran:* ]]; then
    printf '{"action": "test_end", "test": "%s", "status": "PASS"}\n' "$(tr + ' ' <<<"${plan#ran:}")" >>"$3"
    exit 0
  fi
  [[ "$plan" == none ]] && exit 1
  status=1
  for test in ${plan//,/ }; do
    if [[ "$test" == quiet:* ]]; then
      printf '{"action": "test_end", "test": "%s", "status": "FAIL", "expected": "PASS"}\n' "${test#quiet:}" >>"$3"
      status=0
    elif [[ "$test" == crash:* ]]; then
      printf '{"action": "crash", "test": "%s", "signature": "fake"}\n' "${test#crash:}" >>"$3"
    else
      printf '{"action": "test_end", "test": "%s", "status": "FAIL", "expected": "PASS"}\n' "$test" >>"$3"
    fi
  done
  exit "$status"
fi
printf '%s' "$TMPDIR" >"$HELPER_PIDFILE.tmpdir"
sleep 300 &
python3 -c '
import os, sys, time
os.setsid()
open(sys.argv[1], "w").write(str(os.getpid()))
time.sleep(300)
' "$HELPER_PIDFILE" &
wait
EOF
chmod +x "$repo/build/firefox/mach"

lock="$repo/.git/sval-test.lock"
failures=0

fail() {
  echo "FAIL $1" >&2
  failures=$((failures + 1))
}

lock_is_free() {
  python3 -c '
import fcntl, sys
with open(sys.argv[1], "a") as f:
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(1)
' "$lock"
}

alive() {
  # A stopped helper is re-parented to PID 1, and a container's PID 1 is often
  # no init and never reaps it, so it lingers as a zombie, which `kill -0`
  # still finds. A zombie runs nothing and holds no files.
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
  [[ -n "$state" && "$state" != Z* ]]
}

# How long, in tenths of a second, to wait for the fake harness to start and
# for a stopped run's helper to go. Starting takes several python3 start-ups,
# which on a machine busy with builds and test runs have taken longer than ten
# seconds. Each wait only decides
# whether something happened at all, so a generous bound costs a passing run
# nothing.
WAIT_TENTHS=600

# Starts test.sh, waits for its helper, stops test.sh with `signal`, and
# reports what survived.
run_and_stop() {
  local name="$1" signal="$2"
  local pidfile="$work/helper.$name" started="$work/started.$name"
  HELPER_PIDFILE="$pidfile" "$repo/scripts/test.sh" >"$work/$name.log" 2>&1 &
  local runner=$!
  for _ in $(seq "$WAIT_TENTHS"); do
    [[ -s "$pidfile" ]] && break
    alive "$runner" || break
    sleep 0.1
  done
  remember "$runner" "$started"
  if [[ ! -s "$pidfile" ]]; then
    fail "$name: the fake harness never started"
    cat "$work/$name.log" >&2
    kill -TERM "$runner" 2>/dev/null || true
    wait "$runner" 2>/dev/null || true
    return
  fi
  kill "-$signal" "$runner"
  wait "$runner" 2>/dev/null || true

  if [[ "$signal" == TERM ]]; then
    for _ in $(seq "$WAIT_TENTHS"); do
      [[ -z "$(survivors "$started")" ]] && break
      sleep 0.1
    done
    if [[ -n "$(survivors "$started")" ]]; then
      fail "$name: processes the run started outlived it"
      describe "$work/$name.log" "$started"
    fi
    local run_temp
    run_temp="$(cat "$pidfile.tmpdir" 2>/dev/null)"
    if [[ -z "$run_temp" ]]; then
      fail "$name: the harness was given no TMPDIR"
    elif [[ -e "$run_temp" ]]; then
      fail "$name: the run's temporary directory outlived it"
    fi
  fi
  if ! lock_is_free; then
    fail "$name: the test lock is still held after the run stopped"
  fi
  stop_survivors "$started"
}

# A run stopped the ordinary way takes its whole harness with it.
run_and_stop stopped TERM
# A run killed outright cannot clean up, but must still not hold the lock.
run_and_stop killed KILL

# A run stopped while it waits for another run's lock takes its waiter with
# it.
stop_while_waiting() {
  local started="$work/started.waiting"
  python3 -c '
import fcntl, sys, time
f = open(sys.argv[1], "a")
fcntl.flock(f, fcntl.LOCK_EX)
open(sys.argv[2], "w").write("held")
time.sleep(300)
' "$lock" "$work/held" &
  local holder=$!
  for _ in $(seq "$WAIT_TENTHS"); do
    [[ -s "$work/held" ]] && break
    sleep 0.1
  done
  HELPER_PIDFILE="$work/helper.waiting" "$repo/scripts/test.sh" >"$work/waiting.log" 2>&1 &
  local runner=$!
  for _ in $(seq "$WAIT_TENTHS"); do
    grep -q "waiting for it to finish" "$work/waiting.log" && break
    alive "$runner" || break
    sleep 0.1
  done
  if ! grep -q "waiting for it to finish" "$work/waiting.log"; then
    fail "waiting: test.sh never waited for the lock"
  fi
  remember "$runner" "$started"
  kill -TERM "$runner" 2>/dev/null || true
  wait "$runner" 2>/dev/null || true
  for _ in $(seq "$WAIT_TENTHS"); do
    [[ -z "$(survivors "$started")" ]] && break
    sleep 0.1
  done
  if [[ -n "$(survivors "$started")" ]]; then
    fail "waiting: processes a run stopped while it waited started outlived it"
    describe "$work/waiting.log" "$started"
    stop_survivors "$started"
  fi
  kill -KILL "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
}
stop_while_waiting

# Mozilla's mochitest command keeps the browser open after a single
# mochitest-plain file unless told --keep-open=false, and reports a changed
# pref as a failure only under --compare-preferences. Only that command
# accepts them, so test.sh passes them to a run of mochitests alone, and
# --compare-preferences only to a run of Sval's own files.
expect_flags() {
  local want="$1"
  shift
  local args="$work/args"
  rm -f "$args"
  ARGS_FILE="$args" "$repo/scripts/test.sh" "$@" >"$work/args.log" 2>&1 || true
  if [[ ! -f "$args" ]]; then
    fail "flags: the fake harness never ran for $*"
    cat "$work/args.log" >&2
    return
  fi
  local got=default
  if grep -qxF -- --keep-open=false "$args"; then
    got=closed
    grep -qxF -- --compare-preferences "$args" && got=compared
  elif grep -qxF -- --compare-preferences "$args"; then
    got="compared without --keep-open=false"
  fi
  [[ "$got" == "$want" ]] || fail "flags: $got, not $want, for $*"
}
mkdir -p "$repo/build/firefox/dom/c/browser" "$repo/build/firefox/dom/c/unit"
touch "$repo/build/firefox/dom/c/browser/browser.toml" "$repo/build/firefox/dom/c/unit/xpcshell.toml"
mkdir -p "$repo/build/firefox/browser/components/sval/test/browser"
touch "$repo/build/firefox/browser/components/sval/test/browser/browser.toml"
# A markup file is a mochitest when a manifest beside it lists it; a
# crashtest is listed in a `.list` file, and its suite refuses the flags.
mkdir -p "$repo/build/firefox/dom/a/crashtests"
printf '["test_one.html"]\n' >"$repo/build/firefox/dom/a/mochitest.toml"
printf 'load 1.html\n' >"$repo/build/firefox/dom/a/crashtests/crashtests.list"
expect_flags default dom/a/crashtests/1.html
expect_flags default dom/a/test_one.html dom/a/crashtests/1.html
expect_flags closed dom/a/test_one.html
expect_flags closed --setpref=a=b dom/a/browser_two.js dom/a/test_one.html
expect_flags closed dom/c/browser/
expect_flags default dom/a/test_one.html dom/a/unit/test_three.js
expect_flags default dom/a/unit/test_three.js
expect_flags default dom/c/
expect_flags default dom/c/browser/ dom/c/unit/
expect_flags compared browser/components/sval/test/browser/browser_one.js
expect_flags compared browser/components/sval/test/browser/
expect_flags closed browser/components/sval/test/browser/browser_one.js dom/a/browser_two.js

# A manifest's https tests run in a harness of their own, after the rest,
# because Sval reopens a reused profile's tabs (test.sh says why).
mkdir -p "$repo/build/firefox/dom/b"
cat >"$repo/build/firefox/dom/b/mochitest.toml" <<'EOF'
[DEFAULT]

["test_plain.html"]

["test_secure.html"]
scheme = "https"
EOF
rm -f "$work/args"
ARGS_FILE="$work/args" "$repo/scripts/test.sh" dom/b/test_plain.html dom/b/test_secure.html \
  >"$work/args.log" 2>&1 || true
want="$(printf '%s\n' test --log-raw ../test-raw.log dom/b/test_plain.html \
  --keep-open=false "--- end of run" \
  test --log-raw ../test-raw.log.https dom/b/test_secure.html \
  --keep-open=false "--- end of run")"
if [[ "$(cat "$work/args" 2>/dev/null)" != "$want" ]]; then
  fail "https: the runs were not split by scheme:"
  { sed "s/^/  /" "$work/args" || cat "$work/args.log"; } >&2
fi
# A directory holding https tests would go to the harness whole, which runs
# them in its own second launch, so it is refused before any run.
rm -f "$work/args"
status=0
ARGS_FILE="$work/args" "$repo/scripts/test.sh" dom/b/ >"$work/args.log" 2>&1 || status=$?
if ((status != 2)) || [[ -f "$work/args" ]] || ! grep -q "holds 1 https-scheme test" "$work/args.log"; then
  fail "https: a directory holding https tests was not refused (exit $status)"
  sed "s/^/  /" "$work/args.log" >&2
fi

# With SVAL_TEST_RETRY_FAILURES=1 a failed run re-runs its failed files once,
# alone, with the run's options, and passes if they pass then (test.sh says
# why). `plan` is the fake harness's outcome per run; `want` is the exit
# status, the results test.sh records and the number of runs.
mkdir -p "$repo/build/firefox/x/unit"
touch "$repo/build/firefox/x/unit/xpcshell.toml" "$repo/build/firefox/x/unit/test_a.js" \
  "$repo/build/firefox/x/unit/test_b.js" "$repo/build/firefox/x/unit/test_a.py"
expect_retry() {
  local name="$1" retry="$2" plan="$3" want="$4"
  shift 4
  rm -f "$work/args" "$work/results" "$repo/build/test-raw.log"*
  printf '%s\n' $plan >"$work/plan"
  local status=0
  FAIL_PLAN="$work/plan" ARGS_FILE="$work/args" SVAL_TEST_RETRY_FAILURES="$retry" \
    SVAL_TEST_RESULTS_OUT="$work/results" "$repo/scripts/test.sh" "$@" \
    >"$work/retry.log" 2>&1 || status=$?
  local runs results
  runs="$(grep -c -- '--- end of run' "$work/args" 2>/dev/null || echo 0)"
  results="$(python3 -c '
import json, sys
print(" ".join(r["result"] + (":" + r["file"].rsplit("/", 1)[-1] if "file" in r else "")
               for r in map(json.loads, open(sys.argv[1]))))' "$work/results" 2>/dev/null)" || true
  local got="exit=$((status ? 1 : 0)) results=[$results] runs=$runs"
  [[ "$got" == "$want" ]] || {
    fail "retry $name: $got, not $want"
    sed 's/^/  /' "$work/retry.log" >&2
  }
}
# The plan's lines are separated by spaces here, a run's files by commas.
expect_retry flaky 1 "x/unit/test_a.js -" "exit=0 results=[flaky:test_a.js] runs=2" x/unit/
expect_retry failure 1 "x/unit/test_a.js x/unit/test_a.js" \
  "exit=1 results=[failed:test_a.js] runs=2" x/unit/
expect_retry unattributed 1 "none" "exit=1 results=[unattributed] runs=1" x/unit/
# A crash logged against a manifest, as Mochitest logs the dump of a browser
# it killed for hanging, names no file, so nothing is re-run.
expect_retry manifest-crash 1 "x/unit/test_a.js,crash:x/unit/xpcshell.toml" \
  "exit=1 results=[failed:test_a.js unattributed] runs=1" x/unit/
# A file the re-run logs no result for did not pass.
expect_retry not-run 1 "x/unit/test_a.js unknown" "exit=1 results=[failed:test_a.js] runs=2" \
  x/unit/
# A run that exits 0 without running a file it was named has not passed.
expect_retry first-unknown "" "unknown" "exit=1 results=[failed:test_a.js] runs=1" \
  x/unit/test_a.js
expect_retry first-skip "" "skip" "exit=0 results=[] runs=1" x/unit/test_a.js
SVAL_TEST_REQUIRE_RUN=1 expect_retry first-skip-required "" "skip" \
  "exit=1 results=[failed:test_a.js] runs=1" x/unit/test_a.js
expect_retry first-ran "" "-" "exit=0 results=[] runs=1" x/unit/test_a.js
expect_retry manifest-unknown "" "unknown" "exit=1 results=[failed:xpcshell.toml] runs=1" \
  x/unit/xpcshell.toml
expect_retry directory-ran "" "ran:x/unit/test_b.js" "exit=0 results=[] runs=1" x/unit/
# A test two manifests list, and a Marionette test method, are logged under
# ids that name their file among other things.
expect_retry manifest-id "" "ran:xpcshell-e10s.toml:x/unit/test_a.js" \
  "exit=0 results=[] runs=1" x/unit/test_a.js
expect_retry marionette-id "" "ran:../x/unit/test_a.py+TestA.test_one" \
  "exit=0 results=[] runs=1" x/unit/test_a.py
expect_retry off "" "x/unit/test_a.js" "exit=1 results=[failed:test_a.js] runs=1" x/unit/
# A harness that exits 0 with a failure in its log has failed.
expect_retry quiet "" "quiet:x/unit/test_a.js" "exit=1 results=[failed:test_a.js] runs=1" \
  x/unit/
# The re-run keeps an option's value and swaps the directory for the file,
# which stays ahead of the options: given an option first, `mach test` reads
# the option's value as a test path and hands the option to a harness.
expect_retry options 1 "x/unit/test_b.js -" "exit=0 results=[flaky:test_b.js] runs=2" \
  x/unit/ --threads 8
want="$(printf '%s\n' test --log-raw ../test-raw.log.retry x/unit/test_b.js --threads 8 "--- end of run")"
if [[ "$(sed -n '/^--- end of run$/,$p' "$work/args" | sed 1d)" != "$want" ]]; then
  fail "retry options: the re-run's arguments were:"
  sed 's/^/  /' "$work/args" >&2
fi

# Nothing this script started outlives it, the runs killed outright included.
if [[ -n "$(survivors "$work"/started.*)" ]]; then
  fail "processes this check started are still running"
  ps -o pid,ppid,stat,command -p "$(survivors "$work"/started.* | paste -sd, -)" >&2
fi

if ((failures)); then
  exit 1
fi
echo "test-runner-test: ok"
