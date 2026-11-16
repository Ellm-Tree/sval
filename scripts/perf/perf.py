#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Finds where Sval's own code spends time. scripts/perf.sh runs it.

Sval runs three workloads on a seed profile (first run's blocking level, its
lists downloaded, background tabs, a warm startup cache), each under the
Gecko profiler:

- startup: a launch to a settled window, and timed launches to each of
  Sval's User Timing marks (every mark named `sval-…`);
- pages: a list of real sites, each loaded with the network cache cleared;
- tabs: many tabs opened, switched between, and left while their titles
  change, which is the work the panel and the header do as a person browses;
- memory: what every process holds at rest, with the pages open, and once
  they are closed again, with an about:memory report of each;
- idle: the CPU each process spends while nobody touches the window, with the
  pages open, then again with a tab whose title keeps changing.

For each workload it ranks Sval's functions by the profiler samples that land
in them, across every process, in the threads PROFILER_THREADS names, and saves the profile for
profiler.firefox.com ("Load a profile from file"). A function's own time is
the CPU time of samples where it is the innermost Sval frame, so what it calls
in Gecko counts to it; its total time is every sample with it on the stack.
CPU time, never sample counts: a thread waiting for work is still sampled,
under whatever frame its event loop sits beneath.

Times are read from inside the browser, because Marionette only listens once
idle startup tasks have run (`Marionette` observes
browser-idle-startup-tasks-finished).
"""

import argparse
import contextlib
import gzip
import json
import os
import plistlib
import re
import shutil
import statistics
import subprocess
import sys
import time
from collections import Counter

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "network-contact")
)
from check import Marionette, MarionetteError, free_port  # noqa: E402

# Through user.js, so each launch re-applies them. Marionette's recommended
# prefs are off because they change what Sval does at startup.
PREFS = {
    "remote.prefs.recommended": False,
    "browser.sval.firstRun.enabled": False,
}

# The profiler's thread filter: only threads whose names contain one of these
# are sampled. The worker is where Sval's engine runs.
PROFILER_THREADS = ["GeckoMain", "DOM Worker", "SvalSync"]
PROFILER_FEATURES = ["js", "stackwalk", "cpu"]
PROFILER_INTERVAL_MS = 1
PROFILER_ENTRIES = 1 << 24

# What Sval's code is called by the profiler's frame locations.
SVAL_SOURCE = re.compile(
    r"(chrome://browser/content/sval/|moz-src:///browser/components/sval/)([^:)]+)(?::(\d+))?"
)

WAIT_SETTLED = r"""
const done = arguments[0];
(async () => {
  const deadline = Date.now() + 100000;
  const ready = () => {
    const b = gBrowser.selectedBrowser;
    return (
      b.currentURI.spec != "about:blank" &&
      !b.webProgress.isLoadingDocument &&
      performance.getEntriesByName("sval-panel-ready").length
    );
  };
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("the window never settled");
    }
    await new Promise(r => setTimeout(r, 25));
  }
  const info = Services.startup.getStartupInfo();
  const ms = k => (info[k] ? info[k].getTime() : null);
  const marks = {};
  for (const entry of performance.getEntriesByType("mark")) {
    if (entry.name.startsWith("sval-") && !(entry.name in marks)) {
      marks[entry.name] = performance.timeOrigin + entry.startTime;
    }
  }
  done(JSON.stringify({
    process: ms("process"),
    firstPaint: ms("firstPaint"),
    ...marks,
  }));
})().catch(e => done(JSON.stringify({ error: String(e) })));
"""

SEED = r"""
const [tabs, done] = [%s, arguments[0]];
(async () => {
  await SvalPanel.started;
  // First run's default (SvalFirstRunModel.defaults), which the harness skips.
  const { SvalBlocking } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
  );
  SvalBlocking.setLevel("balanced");
  const { SvalBlockingLists } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
  );
  const { SvalScriptlets } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalScriptlets.sys.mjs"
  );
  let lists = 0;
  for (const id of SvalBlockingLists.enabledIds()) {
    if (await SvalBlockingLists.update(id)) {
      lists++;
    }
  }
  await SvalScriptlets.update();
  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  for (const url of tabs) {
    gBrowser.addTab(url, { triggeringPrincipal: principal, skipAnimation: true });
  }
  done(JSON.stringify({ lists }));
})().catch(e => done(JSON.stringify({ error: String(e) })));
"""

START_PROFILER = r"""
Services.profiler
  .StartProfiler(%d, %d, %s, %s)
  .then(() => arguments[0]("ok"), e => arguments[0](JSON.stringify({ error: String(e) })));
"""

# Gathers the profile from every process and writes it as JSON to the path
# given; stop_profiler reads it back to rank it and gzips it.
STOP_PROFILER = r"""
const [path, done] = [%s, arguments[0]];
(async () => {
  const profile = await Services.profiler.getProfileDataAsync();
  await Services.profiler.StopProfiler();
  const bytes = new TextEncoder().encode(JSON.stringify(profile));
  await IOUtils.write(path, bytes, { compress: false });
  done("ok");
})().catch(e => done(JSON.stringify({ error: String(e) })));
"""

NEW_TAB = r"""
const done = arguments[0];
const tab = gBrowser.addTab("about:blank", {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  skipAnimation: true,
});
gBrowser.selectTabAtIndex(gBrowser.tabs.indexOf(tab));
const { NavigableManager } = ChromeUtils.importESModule(
  "chrome://remote/content/shared/NavigableManager.sys.mjs"
);
done(NavigableManager.getIdForBrowser(tab.linkedBrowser));
"""

CLEAR_CACHE = r"""
Services.cache2.clear();
arguments[0]("ok");
"""

CURRENT_URL = r"""
arguments[0](location.href);
"""

# A page's first contentful paint can be reported after its load event, and a
# navigation entry reads 0 for an event that has not happened yet.
PAGE_TIMING = r"""
const done = arguments[0];
(async () => {
  const deadline = Date.now() + 5000;
  let fcp;
  while (
    !(fcp = performance.getEntriesByName("first-contentful-paint")[0]) &&
    Date.now() < deadline
  ) {
    await new Promise(r => setTimeout(r, 50));
  }
  const nav = performance.getEntriesByType("navigation")[0];
  const at = t => (t > 0 ? t : null);
  done(JSON.stringify({
    fcp: fcp ? fcp.startTime : null,
    load: at(nav?.loadEventEnd),
  }));
})();
"""

# Opens each page in a background tab and waits until none is loading, or a
# minute has passed: some pages never stop loading.
OPEN_PAGES = r"""
const [urls, done] = [%s, arguments[0]];
(async () => {
  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  const tabs = urls.map(url =>
    gBrowser.addTab(url, { triggeringPrincipal: principal, skipAnimation: true })
  );
  const deadline = Date.now() + 60000;
  while (
    tabs.some(t => t.linkedBrowser.webProgress?.isLoadingDocument) &&
    Date.now() < deadline
  ) {
    await new Promise(r => setTimeout(r, 250));
  }
  done(JSON.stringify({ tabs: tabs.length }));
})().catch(e => done(JSON.stringify({ error: String(e) })));
"""

CLOSE_PAGES = r"""
const [count, done] = [%d, arguments[0]];
for (const tab of gBrowser.tabs.slice(-count)) {
  gBrowser.removeTab(tab, { animate: false });
}
done("ok");
"""

# Each process's memory, as the system monitors show it (ProcInfo's
# `memory`), and its CPU time so far, with the parent's per thread. An
# about:memory report goes to the path given, anonymized, so it carries no
# page addresses.
PROC_INFO = r"""
const [path, minimize, done] = [%s, %s, arguments[0]];
(async () => {
  if (path) {
    const dumper = Cc["@mozilla.org/memory-info-dumper;1"].getService(
      Ci.nsIMemoryInfoDumper
    );
    await new Promise(r =>
      dumper.dumpMemoryReportsToNamedFile(path, () => r(), null, true, minimize)
    );
  }
  const info = await ChromeUtils.requestProcInfo();
  done(JSON.stringify({
    parent: {
      memory: info.memory,
      cpu: info.cpuTime,
      threads: info.threads.map(t => [t.name, t.cpuTime]),
    },
    children: info.children.map(c => ({
      pid: c.pid,
      type: c.type,
      memory: c.memory,
      cpu: c.cpuTime,
    })),
  }));
})().catch(e => done(JSON.stringify({ error: String(e) })));
"""

# The tabs workload. Each phase waits for the window to go idle before the
# next starts, so a phase's time includes the panel and header work it set off.
TABS_WORKLOAD = r"""
const [base, count, rounds, idleMs, done] = [%s, %d, %d, %d, arguments[0]];
(async () => {
  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  const idle = () =>
    new Promise(r => ChromeUtils.idleDispatch(r, { timeout: 2000 }));
  const times = {};
  const phase = async (name, work) => {
    const start = Date.now();
    await work();
    await idle();
    times[name] = Date.now() - start;
  };
  const opened = [];
  await phase("open", async () => {
    for (let i = 0; i < count; i++) {
      opened.push(
        gBrowser.addTab(`${base}?tab=${i}`, {
          triggeringPrincipal: principal,
          skipAnimation: true,
        })
      );
      await new Promise(r => setTimeout(r, 20));
    }
  });
  await phase("switch", async () => {
    for (let r = 0; r < rounds; r++) {
      for (const tab of opened) {
        gBrowser.selectTabAtIndex(gBrowser.tabs.indexOf(tab));
        await new Promise(r => setTimeout(r, 30));
      }
    }
  });
  await phase("titles", () => new Promise(r => setTimeout(r, idleMs)));
  await phase("close", async () => {
    for (const tab of opened) {
      gBrowser.removeTab(tab, { animate: false });
      await new Promise(r => setTimeout(r, 20));
    }
  });
  done(JSON.stringify(times));
})().catch(e => done(JSON.stringify({ error: String(e) })));
"""


class Sval:
    def __init__(self, app, work):
        self.app = app
        self.work = work
        if app.endswith(".app"):
            with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
                executable = plistlib.load(f)["CFBundleExecutable"]
            self.binary = os.path.join(app, "Contents", "MacOS", executable)
        else:
            self.binary = os.path.join(app, "sval")
        # Everything Gecko keeps beside its profiles goes here, never into the
        # user's own Application Support (nsXREDirProvider::GetUserDataDirectory).
        self.appdata = os.path.join(work, "appdata")
        os.makedirs(self.appdata, exist_ok=True)
        self.seed = os.path.join(work, "seed")

    @contextlib.contextmanager
    def session(self, profile, env_extra=None):
        """Runs Sval on `profile` and yields its Marionette client. Sval is quit
        on the way out, and killed if it does not quit, so a failed run leaves
        nothing running."""
        port = free_port()
        prefs = dict(PREFS, **{"marionette.port": port})
        with open(os.path.join(profile, "user.js"), "w") as f:
            for name, value in prefs.items():
                f.write(f"user_pref({json.dumps(name)}, {json.dumps(value)});\n")
        env = dict(
            os.environ,
            MOZ_APP_DATA=os.path.join(self.appdata, "data"),
            MOZ_LOCAL_APP_DATA=os.path.join(self.appdata, "local"),
            MOZ_CRASHREPORTER_DISABLE="1",
            **(env_extra or {}),
        )
        with open(os.path.join(self.work, "sval.log"), "a") as log:
            proc = subprocess.Popen(
                [
                    self.binary,
                    "--profile",
                    profile,
                    "--new-instance",
                    "--marionette",
                    "--remote-allow-system-access",
                ],
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        m = None
        try:
            m = Marionette(port)
            yield m
        finally:
            if m:
                try:
                    m.cmd("Marionette:Quit", {"flags": ["eAttemptQuit"]})
                except (ConnectionError, OSError, RuntimeError):
                    pass
            try:
                proc.wait(60 if m else 0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    def clone_seed(self, name):
        path = os.path.join(self.work, name)
        shutil.rmtree(path, ignore_errors=True)
        # APFS clones the copy, so a run costs no disk.
        subprocess.run(["cp", "-cR", self.seed, path], check=True)
        return path


def js(m, source, timeout_ms=120000):
    answer = m.js(source, timeout_ms)
    try:
        value = json.loads(answer)
    except (TypeError, json.JSONDecodeError):
        return answer
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(value["error"])
    return value


def start_profiler(m):
    js(
        m,
        START_PROFILER
        % (
            PROFILER_ENTRIES,
            PROFILER_INTERVAL_MS,
            json.dumps(PROFILER_FEATURES),
            json.dumps(PROFILER_THREADS),
        ),
    )


def stop_profiler(m, out, name):
    path = os.path.join(out, f"{name}.json")
    js(m, STOP_PROFILER % json.dumps(path), 300000)
    with open(path) as f:
        profile = json.load(f)
    with open(path, "rb") as f, gzip.open(path + ".gz", "wb") as g:
        shutil.copyfileobj(f, g)
    os.remove(path)
    return profile


def seed(sval, tabs, settle):
    print("perf: seeding a profile", flush=True)
    shutil.rmtree(sval.seed, ignore_errors=True)
    os.makedirs(sval.seed)
    with sval.session(sval.seed) as m:
        lists = js(m, SEED % json.dumps(tabs), 600000)
        print(f"perf: downloaded {lists['lists']} blocking lists", flush=True)
        js(m, WAIT_SETTLED)
        time.sleep(settle)
    # The warm-up launch fills the startup cache, as any launch after the
    # first finds it.
    with sval.session(sval.seed) as m:
        js(m, WAIT_SETTLED)
        time.sleep(settle)


def since(zero, t):
    return round(t - zero) if t else None


def startup(sval, runs, out):
    results = []
    for i in range(runs):
        with sval.session(sval.clone_seed("startup-run")) as m:
            info = js(m, WAIT_SETTLED)
        zero = info["process"]
        result = {k: since(zero, v) for k, v in info.items() if k != "process"}
        results.append(result)
        print(f"perf: startup {i + 1}/{runs}: {fmt(result)}", flush=True)
    # One more launch under the profiler, from the process's first moment.
    env = {
        "MOZ_PROFILER_STARTUP": "1",
        "MOZ_PROFILER_STARTUP_INTERVAL": str(PROFILER_INTERVAL_MS),
        "MOZ_PROFILER_STARTUP_ENTRIES": str(PROFILER_ENTRIES),
        "MOZ_PROFILER_STARTUP_FEATURES": ",".join(PROFILER_FEATURES),
        "MOZ_PROFILER_STARTUP_FILTERS": ",".join(PROFILER_THREADS),
    }
    with sval.session(sval.clone_seed("startup-profiled"), env) as m:
        js(m, WAIT_SETTLED)
        profile = stop_profiler(m, out, "startup")
    return results, profile


def navigate(m, url):
    try:
        m.cmd("WebDriver:Navigate", {"url": url})
    except MarionetteError as err:
        # A page whose load event never comes still has a first paint worth
        # keeping; its load reads as missing.
        if err.code != "timeout":
            raise


def load_page(m, handle, url):
    js(m, CLEAR_CACHE)
    m.cmd("WebDriver:SwitchToWindow", {"handle": handle, "focus": False})
    m.cmd("Marionette:SetContext", {"value": "content"})
    try:
        m.cmd("WebDriver:Navigate", {"url": "about:blank"})
        navigate(m, url)
        # The first navigation in a new tab can be answered while the tab is
        # still on about:blank, so the page is asked for again.
        if m.js(CURRENT_URL, 10000) == "about:blank":
            navigate(m, url)
        try:
            return json.loads(m.js(PAGE_TIMING, 30000))
        except MarionetteError as err:
            # A page that replaces itself after loading unloads the document
            # the script ran in; the timing is the page that replaced it.
            # Marionette reports that as a JavaScriptError whose message alone
            # names the unload (evaluate.sys.mjs).
            if err.code != "javascript error" or "unloaded" not in str(err):
                raise
            time.sleep(2)
            return json.loads(m.js(PAGE_TIMING, 30000))
    finally:
        m.cmd("Marionette:SetContext", {"value": "chrome"})


def pages(sval, urls, reps, out):
    results = {}
    with sval.session(sval.clone_seed("pages-run")) as m:
        js(m, WAIT_SETTLED)
        m.cmd("WebDriver:SetTimeouts", {"pageLoad": 60000})
        handle = js(m, NEW_TAB)
        start_profiler(m)
        for url in urls:
            samples = []
            for _ in range(reps):
                try:
                    samples.append(load_page(m, handle, url))
                except RuntimeError as err:
                    print(f"perf: {url}: {err}", flush=True)
            results[url] = samples
            print(f"perf: {url}: {fmt_page(samples)}", flush=True)
        profile = stop_profiler(m, out, "pages")
    return results, profile


def tabs(sval, base, count, rounds, idle_ms, out):
    with sval.session(sval.clone_seed("tabs-run")) as m:
        js(m, WAIT_SETTLED)
        start_profiler(m)
        times = js(m, TABS_WORKLOAD % (json.dumps(base), count, rounds, idle_ms), 600000)
        profile = stop_profiler(m, out, "tabs")
    print(f"perf: tabs: {fmt(times)}", flush=True)
    return times, profile


def proc_info(m, path=None, minimize=False):
    return js(m, PROC_INFO % (json.dumps(path), json.dumps(minimize)), 300000)


def by_type(info):
    """Each process type's count and summed memory in MB, the parent first."""
    out = {"parent": [1, info["parent"]["memory"] / 2**20]}
    for c in info["children"]:
        entry = out.setdefault(c["type"], [0, 0.0])
        entry[0] += 1
        entry[1] += c["memory"] / 2**20
    return out


def memory_report(path, depth=3, top=25):
    """Explicit MB per process type, and the largest explicit subtrees `depth`
    levels down, summed over every process of a type, from an about:memory
    report."""
    with gzip.open(path) as f:
        reports = json.load(f)["reports"]
    explicit, subtrees = Counter(), Counter()
    for r in reports:
        if r["units"] != 0 or not r["path"].startswith("explicit/"):
            continue
        kind = re.sub(r" \(pid \d+\)", "", r["process"])
        kind = re.sub(r"^Web Content.*", "Web Content", kind)
        explicit[kind] += r["amount"]
        subtrees[(kind, "/".join(r["path"].split("/")[1 : depth + 1]))] += r["amount"]
    return (
        {k: round(v / 2**20, 1) for k, v in explicit.most_common()},
        [(k, p, round(v / 2**20, 1)) for (k, p), v in subtrees.most_common(top)],
    )


def memory(sval, urls, settle, out):
    results = {}
    with sval.session(sval.clone_seed("memory-run")) as m:
        js(m, WAIT_SETTLED)

        def snapshot(name, minimize=False):
            path = os.path.join(out, f"memory-{name}.json.gz")
            info = proc_info(m, path, minimize)
            explicit, subtrees = memory_report(path)
            results[name] = {"by_type": by_type(info), "explicit": explicit, "subtrees": subtrees}
            print(f"perf: memory {name}: " + fmt(
                {k: f"{n}x{round(mb)}MB" for k, (n, mb) in results[name]["by_type"].items()}
            ), flush=True)

        time.sleep(settle)
        snapshot("start")
        js(m, OPEN_PAGES % json.dumps(urls), 120000)
        time.sleep(settle)
        snapshot("pages")
        js(m, CLOSE_PAGES % len(urls))
        time.sleep(settle)
        snapshot("closed", minimize=True)
    return results


def cpu_ms(before, after):
    """CPU ms each process type, and each parent thread, spent between two
    proc_info readings. A process that started or ended between them is
    counted for the part both readings saw."""
    out = Counter({"parent": (after["parent"]["cpu"] - before["parent"]["cpu"]) / 1e6})
    seen = {c["pid"]: c for c in before["children"]}
    for c in after["children"]:
        out[c["type"]] += (c["cpu"] - seen.get(c["pid"], {"cpu": c["cpu"]})["cpu"]) / 1e6
    threads = Counter()
    then = Counter()
    for name, t in before["parent"]["threads"]:
        then[name] += t
    for name, t in after["parent"]["threads"]:
        threads[name] += t
    threads.subtract(then)
    return (
        {k: round(v) for k, v in out.most_common()},
        {k: round(v / 1e6) for k, v in threads.most_common(12) if v > 0},
    )


def idle(sval, urls, tab_page, seconds, settle, out):
    """CPU spent while the window sits untouched: first read without the
    profiler, whose sampling costs CPU of its own, then profiled to say whose
    it was."""
    results, profiles = {}, {}
    with sval.session(sval.clone_seed("idle-run")) as m:
        js(m, WAIT_SETTLED)
        js(m, OPEN_PAGES % json.dumps(urls), 120000)
        for name, extra in (("idle", []), ("idle-title", [f"{tab_page}?tab=idle"])):
            if extra:
                js(m, OPEN_PAGES % json.dumps(extra), 120000)
            time.sleep(settle)
            before = proc_info(m)
            time.sleep(seconds)
            processes, threads = cpu_ms(before, proc_info(m))
            results[name] = {"seconds": seconds, "processes": processes, "parent_threads": threads}
            print(f"perf: {name}, CPU ms in {seconds} s: {fmt(processes)}", flush=True)
            start_profiler(m)
            time.sleep(seconds)
            profiles[name] = stop_profiler(m, out, name)
    return results, profiles


def threads_of(profile):
    """Every thread of `profile` and of the processes it gathered."""
    for thread in profile.get("threads", []):
        if isinstance(thread, str):
            thread = json.loads(thread)
        yield thread
    for sub in profile.get("processes", []):
        if isinstance(sub, str):
            sub = json.loads(sub)
        yield from threads_of(sub)


def rank(profile):
    """Own and total CPU milliseconds of each Sval function, and each thread's
    CPU milliseconds, all and in Sval."""
    own, total, per_thread = Counter(), Counter(), Counter()
    for thread in threads_of(profile):
        strings = thread["stringTable"]
        frames = thread["frameTable"]
        stacks = thread["stackTable"]
        samples = thread["samples"]
        f_loc = frames["schema"]["location"]
        s_prefix, s_frame = stacks["schema"]["prefix"], stacks["schema"]["frame"]
        sample_stack = samples["schema"]["stack"]
        # The `cpu` feature's per-sample CPU time, in microseconds
        # (meta.sampleUnits.threadCPUDelta). A row omits trailing nulls.
        cpu_col = samples["schema"].get("threadCPUDelta")
        frame_fn = {}
        for i, row in enumerate(frames["data"]):
            loc = strings[row[f_loc]]
            match = SVAL_SOURCE.search(loc)
            if match:
                fn = loc.split(" (")[0] if " (" in loc else "(top level)"
                frame_fn[i] = f"{fn} {match.group(2)}:{match.group(3) or '?'}"
        chain_cache = {}

        def chain(stack):
            if stack in chain_cache:
                return chain_cache[stack]
            names = []
            s = stack
            while s is not None:
                fn = frame_fn.get(stacks["data"][s][s_frame])
                if fn:
                    names.append(fn)
                s = stacks["data"][s][s_prefix]
            chain_cache[stack] = names
            return names

        process = {"default": "parent", "tab": "content"}.get(
            thread.get("processType"), thread.get("processType")
        )
        key = f"{process} {thread.get('name')}"
        for row in samples["data"]:
            stack = row[sample_stack]
            if stack is None:
                continue
            cpu = row[cpu_col] if cpu_col is not None and cpu_col < len(row) else None
            ms = (cpu or 0) / 1000
            per_thread[(key, "all")] += ms
            names = chain(stack)
            if names:
                per_thread[(key, "sval")] += ms
                own[names[0]] += ms
                for fn in set(names):
                    total[fn] += ms
    return own, total, per_thread


def median(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values)) if values else None


def fmt(result):
    return "  ".join(f"{k}={'-' if v is None else v}" for k, v in result.items())


def fmt_page(samples):
    return "  ".join(f"{k}={median([s[k] for s in samples])}" for k in ("fcp", "load"))


def report_profile(name, profile, top):
    own, total, per_thread = rank(profile)
    lines = [f"{name}: CPU ms by thread (all / in sval code)"]
    for key in sorted({k for k, _ in per_thread}, key=lambda k: -per_thread[(k, "sval")])[:8]:
        lines.append(f"  {key:40}{per_thread[(key, 'all')]:>9.0f}{per_thread[(key, 'sval')]:>9.0f}")
    lines.append(f"{name}: sval functions by own CPU ms (total ms)")
    for fn, ms in own.most_common(top):
        lines.append(f"  {ms:>7.1f} ({total[fn]:>6.1f})  {fn}")
    return lines


def report(results, top):
    lines = []
    if results.get("startup"):
        lines.append("startup, median ms from process creation: " + fmt(
            {k: median([r.get(k) for r in results["startup"]]) for k in results["startup"][0]}
        ))
    if results.get("pages"):
        lines.append("pages, median ms from navigation start (FCP / load):")
        for url, samples in results["pages"].items():
            lines.append(f"  {median([s['fcp'] for s in samples])} / {median([s['load'] for s in samples])}  {url}")
    if results.get("tabs"):
        lines.append("tabs, ms per phase: " + fmt(results["tabs"]))
    for name, snap in (results.get("memory") or {}).items():
        lines.append(f"memory {name}, processes x MB as the system monitors show it:")
        lines.append("  " + fmt({k: f"{n}x{mb:.0f}" for k, (n, mb) in snap["by_type"].items()}))
        lines.append("  explicit MB: " + fmt(snap["explicit"]))
        for kind, path, mb in snap["subtrees"][:15]:
            lines.append(f"  {mb:>7.1f}  {kind}: {path}")
    for name, idle_run in (results.get("idle") or {}).items():
        lines.append(f"{name}, CPU ms in {idle_run['seconds']} s by process: " + fmt(idle_run["processes"]))
        lines.append("  parent threads: " + fmt(idle_run["parent_threads"]))
    for name, profile in results["profiles"].items():
        lines.append("")
        lines += report_profile(name, profile, top)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True, help="sval's packaged app")
    parser.add_argument("--work", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--pages", required=True, help="a file of page addresses")
    parser.add_argument("--tab-page", required=True, help="the tabs workload's page")
    parser.add_argument("--only", choices=["startup", "pages", "tabs", "memory", "idle"])
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--tabs", type=int, default=60)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--title-seconds", type=int, default=15)
    parser.add_argument("--settle", type=int, default=20)
    parser.add_argument("--top", type=int, default=30)
    parser.add_argument("--idle-seconds", type=int, default=120)
    parser.add_argument(
        "--pref", action="append", default=[], metavar="NAME=JSON",
        help="a pref for every launch, its value as JSON, to compare a setting",
    )
    args = parser.parse_args()
    for pref in args.pref:
        name, value = pref.split("=", 1)
        PREFS[name] = json.loads(value)

    with open(args.pages) as f:
        urls = [l.strip() for l in f if l.strip() and not l.startswith("#")]
    os.makedirs(args.out, exist_ok=True)
    sval = Sval(args.app, args.work)
    seed(sval, urls[:5], args.settle)

    results = {"load": os.getloadavg(), "profiles": {}}
    if args.only in (None, "startup"):
        results["startup"], results["profiles"]["startup"] = startup(sval, args.runs, args.out)
    if args.only in (None, "pages"):
        results["pages"], results["profiles"]["pages"] = pages(sval, urls, args.reps, args.out)
    if args.only in (None, "tabs"):
        results["tabs"], results["profiles"]["tabs"] = tabs(
            sval, args.tab_page, args.tabs, args.rounds, args.title_seconds * 1000, args.out
        )
    if args.only in (None, "memory"):
        results["memory"] = memory(sval, urls, args.settle, args.out)
    if args.only in (None, "idle"):
        results["idle"], idle_profiles = idle(
            sval, urls[:5], args.tab_page, args.idle_seconds, args.settle, args.out
        )
        results["profiles"].update(idle_profiles)

    summary = report(results, args.top)
    results["ranked"] = {}
    for name, profile in results.pop("profiles").items():
        own, total, _ = rank(profile)
        results["ranked"][name] = {
            "own": [(fn, round(ms, 1)) for fn, ms in own.most_common()],
            "total": [(fn, round(ms, 1)) for fn, ms in total.most_common()],
        }
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    with open(os.path.join(args.out, "summary.txt"), "w") as f:
        f.write(summary + "\n")
    print("\n" + summary)
    print(f"\nperf: results and profiles in {args.out}")


if __name__ == "__main__":
    main()
