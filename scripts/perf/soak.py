# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

"""Run Sval for hours as someone who leaves it open would, and record what
each process holds in memory as the hours pass.

Tabs that stay open all run long: a live stream and Twitch's front page play
video the whole time, beside news, social, code and map pages. A browsing tab
cycles through news, shopping, reference and video sites, scrolling each,
plays a video in the foreground, opens and closes a handful of tabs, and then
the window sits minimized. After each cycle every process's memory, as the
system monitors show it, and an anonymized about:memory report are recorded.

    python3 -I scripts/perf/soak.py --app <Sval.app or the directory with
        sval or sval.exe> --out <dir> [--hours 8] [--idle-minutes 8]
        [--blocking off|balanced|strict] [--pref NAME=JSON]...

--app may be stock Firefox of the same Gecko instead, for a comparison run.
Writes samples.jsonl, memory-NNN.json.gz and summary.txt to --out, the
summary after every sample, so a run cut short still has one. Needs nothing
beyond Python's standard library, so it runs as is on macOS, Windows and
Linux. docs/memory-soak.md covers where to run it and how to read what it
records.

It drives Sval through soak-channel/, which it installs into the copy of Sval
given as --app, and never starts Marionette or the Remote Agent: either one
makes navigator.webdriver true, and sites answer that with bot checks.
"""

import argparse
import gzip
import json
import os
import re
import secrets
import subprocess
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "network-contact"))
from check import free_port  # noqa: E402
from perf import PREFS, PROC_INFO, SEED, WAIT_SETTLED, by_type  # noqa: E402
from soak_channel import Channel, ChannelError, install  # noqa: E402

# Pages that stay open all night.
KEPT = [
    ("live stream", "https://www.youtube.com/@LofiGirl/live", True),
    ("twitch", "https://www.twitch.tv/", True),
    ("reddit", "https://www.reddit.com/r/videos/", False),
    ("guardian", "https://www.theguardian.com/international", False),
    ("github", "https://github.com/mozilla-firefox/firefox", False),
    ("map", "https://www.openstreetmap.org/#map=13/40.7306/-73.9866", False),
    ("wikipedia", "https://en.wikipedia.org/wiki/Web_browser", False),
]

# What the browsing tab visits each cycle, in turn.
BROWSE = [
    "https://www.cnn.com/",
    "https://www.nytimes.com/",
    "https://www.bbc.com/news",
    "https://www.theverge.com/",
    "https://www.espn.com/",
    "https://www.allrecipes.com/",
    "https://www.youtube.com/",
    "https://vimeo.com/channels/staffpicks",
    "https://www.twitch.tv/directory",
    "https://www.dailymotion.com/",
    "https://www.imdb.com/",
    "https://stackoverflow.com/questions",
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
    "https://news.ycombinator.com/",
    "https://www.weather.gov/",
    "https://www.ebay.com/",
    "https://www.target.com/",
    "https://www.wikihow.com/Main-Page",
]

# Played in the foreground each cycle, one per cycle.
WATCH = [
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    "https://vimeo.com/1084537",
]

# Opened together in background tabs each cycle, then closed.
CHURN = [
    "https://www.theguardian.com/uk",
    "https://www.reuters.com/",
    "https://www.npr.org/",
    "https://www.washingtonpost.com/",
    "https://www.youtube.com/feed/trending",
    "https://github.com/trending",
]

# Sites whose media plays: Sval asks before any site plays media, muted
# included, and a person who watches video there has answered "Always allow".
MEDIA_SITES = ["youtube.com", "twitch.tv", "vimeo.com", "dailymotion.com"]

ALLOW_MEDIA = r"""
const [sites, done] = [%s, arguments[0]];
const { SvalSiteProtections } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
for (const site of sites) {
  SvalSiteProtections.setMedia(site, "allow");
}
done(JSON.stringify(sites.map(site => SvalSiteProtections.mediaFor(site))));
"""

# Starts the page's first video, with its sound, as a person watching would:
# through the page's own player where it has one, since a player can pause a
# video started behind its back. Answers whether it plays and where it is.
# A VM's sound plays on the machine hosting it, so mute the VM, not Sval.
PLAY = r"""
const done = arguments[0];
(async () => {
  const deadline = Date.now() + 30000;
  let v;
  while (!(v = document.querySelector("video")) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  if (!v) {
    done(JSON.stringify({ video: false }));
    return;
  }
  const player = document.getElementById("movie_player")?.wrappedJSObject;
  if (player?.playVideo) {
    player.playVideo();
  } else {
    await v.play().catch(() => {});
  }
  await new Promise(r => setTimeout(r, 5000));
  // What the player says when it will not play: an error, a sign-in wall.
  const note = (v.parentElement?.parentElement?.innerText || "").slice(0, 160);
  done(JSON.stringify({ video: true, paused: v.paused, at: v.currentTime, note }));
})().catch(e => done(JSON.stringify({ error: String(e) })));
"""

# Play buttons to press, as a person would, when a video will not start
# from script. The video itself is last: most players toggle playback on a click.
PLAY_BUTTONS = [
    ".ytp-large-play-button",
    "button.ytp-play-button",
    "[data-a-target='player-play-pause-button']",
    "button[aria-label='Play']",
    "video",
]

WHERE = r"""
const v = document.querySelector("video");
arguments[0](JSON.stringify(v ? { video: true, paused: v.paused, at: v.currentTime } : { video: false }));
"""

SCROLL = r"""
const [steps, done] = [%d, arguments[0]];
(async () => {
  for (let i = 0; i < steps; i++) {
    window.scrollBy({ top: innerHeight * 0.8, behavior: "smooth" });
    await new Promise(r => setTimeout(r, 1500));
  }
  done("ok");
})().catch(e => done(String(e)));
"""

OPEN_BACKGROUND = r"""
const [urls, done] = [%s, arguments[0]];
const principal = Services.scriptSecurityManager.getSystemPrincipal();
done(JSON.stringify(urls.map(url =>
  gBrowser.addTab(url, { triggeringPrincipal: principal, skipAnimation: true }).linkedBrowser.browserId
)));
"""

CLOSE = r"""
const [ids, done] = [%s, arguments[0]];
let closed = 0;
for (const tab of [...gBrowser.tabs]) {
  if (ids.includes(tab.linkedBrowser.browserId)) {
    gBrowser.removeTab(tab, { animate: false });
    closed++;
  }
}
done(String(closed));
"""

WINDOW = r"""
const [state, done] = [%s, arguments[0]];
if (state == "minimized") {
  window.minimize();
} else {
  window.restore();
  window.focus();
}
done(String(window.windowState));
"""

SELECT = r"""
const [id, done] = [%s, arguments[0]];
const tab = gBrowser.tabs.find(t => t.linkedBrowser.browserId == id);
if (tab) {
  gBrowser.selectedTab = tab;
}
done(String(!!tab));
"""

QUIT = r"""
Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
arguments[0]("quitting");
"""

NEW_TAB = r"""
const done = arguments[0];
const tab = gBrowser.addTab("about:blank", {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  skipAnimation: true,
});
gBrowser.selectedTab = tab;
done(tab.linkedBrowser.browserId);
"""

# The address bar's load: a system-principal load of what was typed, then
# wait for the document to finish, as a person waits for the page.
NAVIGATE = r"""
const [id, url, done] = [%s, %s, arguments[0]];
(async () => {
  const browser = gBrowser.browsers.find(b => b.browserId == id);
  browser.fixupAndLoadURIString(url, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  const deadline = Date.now() + 60000;
  await new Promise(r => setTimeout(r, 1000));
  while (browser.webProgress.isLoadingDocument && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
  }
  done(browser.currentURI.spec);
})().catch(e => done(JSON.stringify({ error: String(e) })));
"""

WEBDRIVER = r"""
arguments[0](JSON.stringify(navigator.webdriver));
"""

# Presses the first visible play button with mouse events the page sees as
# a person's (SvalSoakChild's click).
PRESS = r"""
arguments[0](JSON.stringify(click(%s)));
"""

# The pages are public test sites, so the report keeps their addresses
# (nsIMemoryInfoDumper's aAnonymize): a page that leaks can then be named.
PROC_INFO_NAMED = PROC_INFO.replace("null, true, minimize", "null, false, minimize")
assert PROC_INFO_NAMED != PROC_INFO

# GC and CC logs of every process, which say what keeps a leaked object
# alive (Mozilla's heapgraph tools read them). They go to
# MOZ_CC_LOG_DIRECTORY, which the session sets.
CC_LOGS = r"""
const [label, done] = [%s, arguments[0]];
const dumper = Cc["@mozilla.org/memory-info-dumper;1"].getService(
  Ci.nsIMemoryInfoDumper
);
const logs = [];
dumper.dumpGCAndCCLogsToFile(label, false, true, {
  onDump(gc, cc) {
    logs.push(gc.path, cc.path);
  },
  onFinish() {
    done(JSON.stringify(logs));
  },
});
"""

TAB_COUNT = r"""
arguments[0](JSON.stringify({ tabs: gBrowser.tabs.length }));
"""


# Firefox has no Sval panel to wait for, and asks for nothing at first run
# with these prefs. Audible autoplay is allowed as Sval's media setting
# allows it on the site.
FIREFOX_SETTLE = r"""
const done = arguments[0];
(async () => {
  const deadline = Date.now() + 100000;
  while (!(window.gBrowser?.selectedBrowser && !gBrowser.selectedBrowser.webProgress.isLoadingDocument)) {
    if (Date.now() > deadline) {
      throw new Error("the window never settled");
    }
    await new Promise(r => setTimeout(r, 100));
  }
  done("{}");
})().catch(e => done(JSON.stringify({ error: String(e) })));
"""
FIREFOX_PREFS = {
    "browser.aboutwelcome.enabled": False,
    "browser.startup.homepage_override.mstone": "ignore",
    "datareporting.policy.dataSubmissionPolicyBypassNotification": True,
    "media.autoplay.default": 0,
}

SET_BLOCKING = r"""
const [level, done] = [%s, arguments[0]];
ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
).SvalBlocking.setLevel(level);
done(level);
"""


def pref(text):
    """NAME=JSON, as --pref takes it."""
    name, sep, value = text.partition("=")
    if not sep:
        raise argparse.ArgumentTypeError(f"{text}: expected NAME=JSON")
    try:
        return name, json.loads(value)
    except json.JSONDecodeError:
        raise argparse.ArgumentTypeError(f"{text}: the value is not JSON")


def add_pref_argument(parser):
    parser.add_argument("--pref", type=pref, action="append", default=[], metavar="NAME=JSON",
                        help="a pref for user.js, repeatable: --pref browser.tabs.unloadOnLowMemory=false")


def js(ch, source, timeout_ms=120000):
    """Runs a chrome script; a JSON answer is parsed, and one that reports
    an error raises it."""
    answer = ch.js(source, timeout_ms)
    try:
        value = json.loads(answer)
    except (TypeError, json.JSONDecodeError):
        return answer
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(value["error"])
    return value


def log(out, message):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    print(line, flush=True)
    with open(os.path.join(out, "soak.log"), "a") as f:
        f.write(line + "\n")


class Session:
    """Sval on one profile for the whole soak, relaunched on the same
    profile if it exits."""

    def __init__(self, app, out, prefs=()):
        if app.endswith(".app"):
            import plistlib

            with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
                executable = plistlib.load(f)["CFBundleExecutable"]
            self.binary = os.path.join(app, "Contents", "MacOS", executable)
        else:
            # Stock Firefox for a comparison run.
            ext = ".exe" if os.name == "nt" else ""
            binary = os.path.join(app, "sval" + ext)
            self.binary = binary if os.path.exists(binary) else os.path.join(app, "firefox" + ext)
        self.out = out
        self.profile = os.path.join(out, "profile")
        self.appdata = os.path.join(out, "appdata")
        self.cc_logs = os.path.join(out, "cc-logs")
        os.makedirs(self.profile, exist_ok=True)
        os.makedirs(self.cc_logs, exist_ok=True)
        self.proc = None
        self.ch = None
        self.firefox = os.path.basename(self.binary).startswith("firefox")
        self.settle = FIREFOX_SETTLE if self.firefox else WAIT_SETTLED
        self.prefs = dict(FIREFOX_PREFS if self.firefox else {}, **dict(prefs))

    def start(self):
        port = free_port()
        # dump() from the channel reaches sval.log.
        prefs = dict(PREFS, **{"app.update.disabledForTesting": True, "browser.dom.window.dump.enabled": True}, **self.prefs)
        with open(os.path.join(self.profile, "user.js"), "w") as f:
            for name, value in prefs.items():
                f.write(f"user_pref({json.dumps(name)}, {json.dumps(value)});\n")
        token = secrets.token_hex(16)
        env = dict(
            os.environ,
            MOZ_APP_DATA=os.path.join(self.appdata, "data"),
            MOZ_LOCAL_APP_DATA=os.path.join(self.appdata, "local"),
            MOZ_CRASHREPORTER_DISABLE="1",
            MOZ_CC_LOG_DIRECTORY=self.cc_logs,
            SVAL_SOAK_PORT=str(port),
            SVAL_SOAK_TOKEN=token,
        )
        with open(os.path.join(self.out, "sval.log"), "a") as f:
            self.proc = subprocess.Popen(
                [self.binary, "--profile", self.profile, "--new-instance"],
                env=env, stdout=f, stderr=subprocess.STDOUT,
            )
        self.ch = Channel(port, token)
        js(self.ch, self.settle)
        # A window that never comes to the front reads as hidden, and Gecko
        # holds back media and timers in hidden windows.
        js(self.ch, WINDOW % json.dumps("normal"))

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def stop(self):
        if self.ch:
            try:
                self.ch.js(QUIT, 5000)
            except (ConnectionError, OSError, RuntimeError):
                pass
            self.ch.close()
        if self.proc:
            try:
                self.proc.wait(60)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()

    def content(self, handle, source, timeout_ms=60000):
        """Runs `source` in the page of the tab `handle`."""
        try:
            return json.loads(self.ch.content(handle, source, timeout_ms))
        except (TypeError, json.JSONDecodeError):
            return None

    def play(self, handle):
        """Starts the tab's video; presses its play button if it will not
        start from script. Answers where the video is."""
        state = self.content(handle, PLAY, 60000)
        if not state or not state.get("video") or not state.get("paused"):
            return state
        # A person presses play in the tab in front.
        js(self.ch, SELECT % json.dumps(handle))
        pressed = self.content(handle, PRESS % json.dumps(PLAY_BUTTONS), 10000)
        time.sleep(5)
        state = self.content(handle, WHERE, 10000)
        if state is not None:
            state["pressed"] = pressed
        return state

    def navigate(self, handle, url):
        """Loads `url` in the tab as the address bar would, and waits for it
        to finish loading, up to a minute."""
        js(self.ch, NAVIGATE % (json.dumps(handle), json.dumps(url)), 90000)


def guarded(out, what, step):
    """Runs one step of a cycle. A page that misbehaves costs that step,
    never the soak."""
    try:
        return step()
    except (ChannelError, RuntimeError, json.JSONDecodeError) as err:
        log(out, f"{what}: {err}")
        return None


def sample(s, out, n, started, videos, minimize=False):
    path = os.path.join(out, f"memory-{n:03d}.json.gz")
    info = proc_info_safe(s.ch, path, minimize)
    report = memory_report(path)
    playing = {}
    for name, handle in videos.items():
        playing[name] = guarded(out, f"{name} position", lambda h=handle: s.content(h, WHERE, 10000))
    record = {
        "n": n,
        "minutes": round((time.time() - started) / 60, 1),
        "minimized_gc": minimize,
        "by_type": {k: [c, round(mb, 1)] for k, (c, mb) in by_type(info).items()},
        "total_mb": round(sum(mb for _, mb in by_type(info).values()), 1),
        **report,
        "videos": playing,
        "tabs": js(s.ch, TAB_COUNT)["tabs"],
    }
    with open(os.path.join(out, "samples.jsonl"), "a") as f:
        f.write(json.dumps(record) + "\n")
    log(out, f"sample {n} at {record['minutes']} min: total {record['total_mb']} MB, "
        + ", ".join(f"{k} {c}x{mb}" for k, (c, mb) in record["by_type"].items()))
    summarize(out)


def memory_report(path, depth=3, top=60):
    """Explicit MB per process type, and the largest explicit subtrees
    `depth` levels down, summed over every process of a type. Each page's
    window entry is named for its page, so they are summed as one: growth
    in what pages hold shows there, and the pages a cycle visits change."""
    with gzip.open(path) as f:
        reports = json.load(f)["reports"]
    explicit, subtrees, pages, ghosts = {}, {}, {}, {}
    # heap-unclassified is not in the report: about:memory derives it as the
    # heap allocated less every heap report (aboutMemory.js, addHeapUnclassifiedNode).
    allocated, classified = {}, {}
    for r in reports:
        kind = re.sub(r" ?\(pid \d+\)|pid \d+, ", "", r["process"])
        kind = re.sub(r"^Web Content.*", "Web Content", kind)
        # A named report gives each content process its site
        # ("webIsolated=https://cnn.com"); a type sums them.
        kind = re.sub(r"=\S*", "", kind)
        if r["path"] == "heap-allocated":
            allocated[r["process"]] = (kind, r["amount"])
        if r["path"] == "ghost-windows":
            ghosts[kind] = ghosts.get(kind, 0) + r["amount"]
        if r["units"] != 0 or not r["path"].startswith("explicit/"):
            continue
        if r["kind"] == 1:
            classified[r["process"]] = classified.get(r["process"], 0) + r["amount"]
        explicit[kind] = explicit.get(kind, 0) + r["amount"]
        parts = [re.sub(r"\(.*", "(pages)", p) for p in r["path"].split("/")[1 : depth + 1]]
        key = (kind, "/".join(parts))
        subtrees[key] = subtrees.get(key, 0) + r["amount"]
        # What each site's pages hold, named by the page's host.
        # A report path writes each "/" in an address as "\\".
        page = re.match(r"explicit/window-objects/top\((?:[\w-]+:\\\\)?([^\\,)]*)", r["path"])
        if page:
            pages[page.group(1)] = pages.get(page.group(1), 0) + r["amount"]
    for process, (kind, amount) in allocated.items():
        unclassified = amount - classified.get(process, 0)
        explicit[kind] = explicit.get(kind, 0) + unclassified
        key = (kind, "heap-unclassified")
        subtrees[key] = subtrees.get(key, 0) + unclassified
    mb = lambda v: round(v / 2**20, 1)  # noqa: E731
    return {
        "explicit": {k: mb(v) for k, v in sorted(explicit.items(), key=lambda kv: -kv[1])},
        "subtrees": [(k, p, mb(v)) for (k, p), v in sorted(subtrees.items(), key=lambda kv: -kv[1])[:top]],
        "pages": {k: mb(v) for k, v in sorted(pages.items(), key=lambda kv: -kv[1])[:top]},
        "ghost_windows": ghosts,
    }


def proc_info_safe(ch, path, minimize):
    return js(ch, PROC_INFO_NAMED % (json.dumps(path), json.dumps(minimize)), 600000)


def mark(s, out, n, step):
    """Each process type's memory after one step of a cycle, so growth can be
    pinned on the step that caused it."""
    info = js(s.ch, PROC_INFO % ("null", "false"), 120000)
    total = round(sum(mb for _, mb in by_type(info).values()), 1)
    record = {
        "cycle": n,
        "step": step,
        "total_mb": total,
        "by_type": {k: [c, round(mb, 1)] for k, (c, mb) in by_type(info).items()},
    }
    with open(os.path.join(out, "steps.jsonl"), "a") as f:
        f.write(json.dumps(record) + "\n")
    return total


def cc_logs(s, out, label):
    """Writes every process's GC and CC logs and compresses them."""
    paths = js(s.ch, CC_LOGS % json.dumps(label), 1800000)
    size = 0
    for path in paths:
        if not os.path.exists(path):
            continue
        with open(path, "rb") as f, gzip.open(path + ".gz", "wb") as g:
            while chunk := f.read(1 << 20):
                g.write(chunk)
        os.remove(path)
        size += os.path.getsize(path + ".gz")
    log(out, f"GC and CC logs {label}: {len(paths)} files, {size / 2**20:.0f} MB compressed")


def summarize(out):
    """Each process type's memory and the largest explicit subtrees, at the
    first sample after the warm-up and at the latest, and how much each grew."""
    with open(os.path.join(out, "samples.jsonl")) as f:
        samples = [json.loads(line) for line in f if line.strip()]
    regular = [s for s in samples if not s["minimized_gc"]]
    if len(regular) < 2:
        return
    first, last = regular[1] if len(regular) > 2 else regular[0], regular[-1]
    hours = (last["minutes"] - first["minutes"]) / 60 or 1
    lines = [f"from sample {first['n']} ({first['minutes']} min) to {last['n']} ({last['minutes']} min)",
             "", "memory as the system monitors show it, MB (count x MB):"]
    for kind in sorted(set(first["by_type"]) | set(last["by_type"])):
        a = first["by_type"].get(kind, [0, 0])
        b = last["by_type"].get(kind, [0, 0])
        lines.append(f"  {kind:24} {a[0]}x{a[1]:>8} -> {b[0]}x{b[1]:>8}   {b[1] - a[1]:+.1f} ({(b[1] - a[1]) / hours:+.1f}/h)")
    lines.append(f"  {'total':24} {first['total_mb']:>10} -> {last['total_mb']:>10}")
    lines += ["", "explicit subtrees that grew most, MB:"]
    then = {(k, p): v for k, p, v in first["subtrees"]}
    now = {(k, p): v for k, p, v in last["subtrees"]}
    growth = sorted(((now.get(key, 0) - then.get(key, 0), key) for key in set(then) | set(now)), reverse=True)
    for delta, (kind, p) in growth[:15]:
        lines.append(f"  {delta:+8.1f}  {kind}: {p} ({then.get((kind, p), 0)} -> {now.get((kind, p), 0)})")
    lines += ["", "what each site's pages hold, MB, the largest at the last sample:"]
    for host, now_mb in list(last.get("pages", {}).items())[:12]:
        lines.append(f"  {host:40} {first.get('pages', {}).get(host, 0):>8} -> {now_mb:>8}")
    lines += ["", "ghost windows (pages closed but still in memory), per sample: "
              + " ".join(str(sum((s.get("ghost_windows") or {}).values())) for s in regular)]
    steps_path = os.path.join(out, "steps.jsonl")
    if os.path.exists(steps_path):
        with open(steps_path) as f:
            steps = [json.loads(line) for line in f if line.strip()]
        grew = {}
        for before, after in zip(steps, steps[1:]):
            grew.setdefault(after["step"], []).append(after["total_mb"] - before["total_mb"])
        lines += ["", "average change in total MB over each step of a cycle:"]
        for step, deltas in grew.items():
            lines.append(f"  {step:12} {sum(deltas) / len(deltas):+8.1f}  over {len(deltas)} cycles")
    lines += ["", "total MB per sample: " + " ".join(f"{s['total_mb']:.0f}" for s in regular)]
    stalled = [name for name, v in (last.get("videos") or {}).items()
               if not v or v.get("paused") or not v.get("video")]
    if stalled:
        lines.append(f"videos not playing at the last sample: {', '.join(stalled)}")
    with open(os.path.join(out, "summary.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")


def cycle(s, out, n, browse_handle, videos, idle_minutes, smoke=False):
    def step(name):
        guarded(out, f"mark {name}", lambda: mark(s, out, n, name))

    step("restore")
    # YouTube pauses its player in every other tab when one starts, as the
    # cycle's own video does; someone listening would start it again.
    for name, handle in videos.items():
        guarded(out, f"resume {name}", lambda h=handle: s.play(h))
    for url in BROWSE[:2] if smoke else BROWSE:
        guarded(out, f"browse {url}", lambda u=url: s.navigate(browse_handle, u))
        guarded(out, f"scroll {url}", lambda: s.content(browse_handle, SCROLL % 8, 60000))
    step("browse")
    watch = WATCH[n % len(WATCH)]
    guarded(out, f"watch {watch}", lambda: s.navigate(browse_handle, watch))
    played = guarded(out, f"play {watch}", lambda: s.play(browse_handle))
    log(out, f"watch {watch}: {played}")
    time.sleep(20 if smoke else 180)
    step("watch")
    churn = guarded(out, "open churn tabs", lambda: js(s.ch, OPEN_BACKGROUND % json.dumps(CHURN)))
    time.sleep(10 if smoke else 60)
    for handle in churn or []:
        guarded(out, "scroll churn tab", lambda h=handle: s.content(h, SCROLL % 4, 60000))
    guarded(out, "close churn tabs", lambda: js(s.ch, CLOSE % json.dumps(churn or [])))
    time.sleep(10)
    step("churn")
    guarded(out, "minimize", lambda: js(s.ch, WINDOW % json.dumps("minimized")))
    time.sleep(idle_minutes * 60)
    step("minimized")
    guarded(out, "restore", lambda: js(s.ch, WINDOW % json.dumps("normal")))
    time.sleep(30)


def open_kept(s, out):
    handles, videos = {}, {}
    for name, url, video in KEPT:
        handle = js(s.ch, NEW_TAB)
        guarded(out, f"open {name}", lambda h=handle, u=url: s.navigate(h, u))
        handles[name] = handle
        if video:
            played = guarded(out, f"play {name}", lambda h=handle: s.play(h))
            log(out, f"{name}: {played}")
            videos[name] = handle
    browse = js(s.ch, NEW_TAB)
    return handles, videos, browse


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--hours", type=float, default=8)
    parser.add_argument("--idle-minutes", type=float, default=8)
    # One short cycle of each step, to check the driver works before a run.
    parser.add_argument("--smoke", action="store_true")
    # GC and CC logs after every cycle, to find the cycle in which a page
    # starts holding on.
    parser.add_argument("--cc-every-cycle", action="store_true")
    # Content blocking's level, to tell its memory from the rest of Sval's.
    parser.add_argument("--blocking", choices=["off", "balanced", "strict"], default="balanced")
    add_pref_argument(parser)
    args = parser.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    # The channel goes into the copy of Sval under test; the copy is the
    # soak's own, never one a person uses.
    install(os.path.abspath(args.app))
    s = Session(os.path.abspath(args.app), out, args.pref)
    started = time.time()
    deadline = started + args.hours * 3600
    log(out, f"soak: {args.hours} h on {s.binary}")
    s.start()
    if not s.firefox:
        lists = js(s.ch, SEED % json.dumps([]), 600000)
        js(s.ch, SET_BLOCKING % json.dumps(args.blocking))
        log(out, f"blocking at {args.blocking}, {lists['lists']} lists downloaded")
        log(out, f"media allowed on {MEDIA_SITES}: {js(s.ch, ALLOW_MEDIA % json.dumps(MEDIA_SITES))}")
    handles, videos, browse = open_kept(s, out)
    seen = guarded(out, "webdriver flag", lambda: s.content(handles["reddit"], WEBDRIVER, 10000))
    log(out, f"a page sees navigator.webdriver: {seen}")
    time.sleep(10 if args.smoke else 120)
    n = 0
    sample(s, out, n, started, videos)
    restarts = 0
    while time.time() < deadline:
        n += 1
        try:
            cycle(s, out, n, browse, videos, args.idle_minutes, args.smoke)
            sample(s, out, n, started, videos)
            if args.cc_every_cycle:
                label = f"c{n:02d}"
                guarded(out, "GC and CC logs", lambda: cc_logs(s, out, label))
            elif n == 1:
                guarded(out, "GC and CC logs", lambda: cc_logs(s, out, "warm"))
        except (ConnectionError, OSError) as err:
            # Sval quit or stopped answering: say when, and go on from the
            # session it restores, as a person would after a crash.
            code = s.proc.poll()
            log(out, f"Sval stopped answering in cycle {n} (exit {code}): {err}")
            if restarts >= 3:
                break
            restarts += 1
            s.stop()
            s.start()
            handles, videos, browse = open_kept(s, out)
    guarded(out, "GC and CC logs", lambda: cc_logs(s, out, "end"))
    n += 1
    guarded(out, "final sample", lambda: sample(s, out, n, started, videos, minimize=True))
    s.stop()
    log(out, "soak: done")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
