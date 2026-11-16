<!-- SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
     Copyright 2026 Ellm Tree, Inc. -->

# Memory soaks

How to find out whether Sval's memory grows over hours of use, and where.
Two scripts in `scripts/perf/` do the measuring:

- **`soak.py`** runs Sval for hours as someone who leaves it open would,
  and records every process's memory after each cycle.
- **`pagegrowth.py`** keeps one page open and records what that page holds,
  to tell whether growth the soak found is the page's own.

They need only Python's standard library and run on macOS, Windows and
Linux. `scripts/perf.sh` measures startup, page loads and idle memory over
minutes. These scripts cover the hours.

## How they drive Sval

The scripts never start Marionette or the Remote Agent. Either one makes
`navigator.webdriver` true, and sites answer that with bot checks, which
change what a page does and holds. Each script instead copies
`scripts/perf/soak-channel/` into the app it tests: an autoconfig file that
opens a loopback socket only when the script's port and token are in the
environment, and runs the script's chrome and page scripts.

So give each run a copy of the app made for it. The channel stays in the copy
after the run, and any launch of that copy with the two variables set opens
it. Each run uses its own profile and app data under `--out`, so your own
Sval data is never touched.

Use a packaged build: a release download, or `./mach package` output. The
objdir's app reads chrome from loose files instead of `omni.ja`, which
changes what it holds.

## Where to run them

A soak plays video with sound for hours and moves its window in front, so
run it on a machine nobody is using: a VM, or a spare computer.

- **macOS:** a Tart VM, signed in to the desktop, started with
  `tart run --no-audio` so its sound doesn't play on the host. Never mute
  Sval itself: a muted tab is one more thing that differs from a person's.
- **Windows:** a VM signed in to the desktop, with the script started in
  that session. A window in a session nobody sees reads as hidden, and Gecko
  holds back media and timers in hidden windows.
- **Linux:** any desktop, or a container with Xvfb and Gecko's runtime
  libraries, such as CI's build image:

      docker run -d --name soak --memory 6g --cpus 3 --shm-size 2g \
        -v "$PWD/soak:/soak" <image> sleep infinity
      docker exec -d soak Xvfb :99 -screen 0 1600x1200x24 -ac -noreset
      docker exec -d -e DISPLAY=:99 -w /soak/repo soak sh -c \
        "python3 -I scripts/perf/soak.py --app /soak/sval --out /soak/run > /soak/run.out 2>&1"

  Gecko's processes share memory through `/dev/shm`, and Docker gives a
  container only 64 MB of it unless `--shm-size` says otherwise.

Give the soak the machine to itself, apart from the Firefox run it is
compared with.

## Compare against Firefox

Growth only means something next to stock Firefox ESR of the same Gecko,
run on the same machine at the same time. `upstream.txt` names the ESR
release Sval is built on, and Mozilla's archive at
`https://archive.mozilla.org/pub/firefox/releases/<version>esr/` has it for
each platform. Pass Firefox's install directory, or `Firefox.app`, as
`--app`. The scripts tell it apart by its binary's name and skip Sval's
setup steps.

Growth Firefox shows too is the site's, or Gecko's, and goes to Mozilla.
Growth only Sval shows is Sval's to fix.

## `soak.py`

    python3 -I scripts/perf/soak.py --app <Sval.app or its directory> \
      --out <dir> [--hours 8] [--idle-minutes 8] \
      [--blocking off|balanced|strict] [--pref NAME=JSON]... \
      [--cc-every-cycle] [--smoke]

Seven tabs stay open all along: a YouTube live stream and Twitch's front
page play video, beside Reddit, the Guardian, GitHub, OpenStreetMap and
Wikipedia. Each cycle then:

1. Browses 18 news, shopping, reference and video sites in one tab,
   scrolling each.
2. Plays a video in that tab for three minutes.
3. Opens six tabs in the background, scrolls them and closes them.
4. Minimizes the window for `--idle-minutes`.

A cycle takes about 20 minutes. Run `--smoke` first: one short cycle that
shows the driver works on that machine before you commit hours to it.

- `--blocking` sets content blocking's level, to tell its memory from the
  rest of Sval's.
- `--pref` writes a pref into the profile's `user.js`, as JSON. Repeat it
  for more than one. Use it to turn a feature off and see whether the
  growth goes with it.
- `--cc-every-cycle` writes GC and CC logs after every cycle, to find the
  cycle in which a page starts holding on. Each set takes minutes and
  hundreds of MB. Without it, the soak writes them after the first cycle
  and at the end.

If Sval exits or stops answering, the soak logs when and starts it again on
the same profile, up to three times.

### What it writes

- **`summary.txt`**, rewritten after every sample, so a run cut short still
  has one. It compares the first sample after warm-up with the latest:
  1. Each process type's memory as the system monitors show it, and how
     fast it grew per hour.
  2. The explicit subtrees of about:memory that grew most, summed over every
     process of a type.
  3. What each site's pages hold, by host.
  4. Ghost windows, pages closed but still in memory, at each sample.
  5. The average change in total memory over each step of a cycle, which
     pins growth on the step that caused it.
  6. Videos that stopped playing, which make a run's numbers lower than a
     person's.
- **`samples.jsonl`**, one sample per cycle, and **`steps.jsonl`**, one
  line per step.
- **`memory-NNN.json.gz`**, an about:memory report per sample, with page
  addresses kept: the sites are public, and a page that leaks can then be
  named. Open about:memory in any build and use **Load…** to read one, or
  **Load and diff…** to compare two.
- **`cc-logs/`**, the GC and CC logs, as `gc-edges.<pid>.<label>.log.gz`
  and `cc-edges.<pid>.<label>.log.gz`.
- **`soak.log`**, what each step did and every step that failed, and
  **`sval.log`**, the browser's own output.

### Reading a run

1. **Is there growth?** In `summary.txt`, a process type's memory that
   keeps rising after the first hour is growth. Memory that rises and falls
   back is caches. Compare it with Firefox's run.
2. **Which page?** The per-site list names the page. Load the first and
   last `memory-NNN.json.gz` with **Load and diff…** and read that page's
   `window-objects/top(...)` subtree. `dom/orphan-nodes` growing means the
   page holds DOM nodes it removed. `js-realm(...)/classes/class(Function)`
   and `class(Call)` growing means closures are holding them.
3. **Is it the page's own?** Run `pagegrowth.py` on that page, Sval and
   Firefox side by side.
4. **What holds it?** Find a leaked object's address in the last
   `gc-edges` log, and ask
   [heapgraph](https://github.com/amccreight/heapgraph)'s `find_roots.py`
   what keeps it alive. Decompress the log first: `find_roots.py` tells GC
   and CC logs apart by the file's name, which must start with `gc` or `cc`.

       gunzip -k cc-logs/gc-edges.1234.end.log.gz
       python3 find_roots.py cc-logs/gc-edges.1234.end.log 0x7f3a1c2d4e80

   The soak's CC logs leave out objects the collector already knows are
   alive, so an object held from JavaScript shows its path in the GC log.

## `pagegrowth.py`

    python3 -I scripts/perf/pagegrowth.py --app <Sval or Firefox> \
      --out <dir> --url <page> [--play] \
      [--state front|background|minimized] \
      [--minutes 60] [--every 5] [--pref NAME=JSON]...

It opens `--url`, and every `--every` minutes writes an about:memory report
and logs three numbers for the page: its total, the DOM nodes it removed
but still holds, and its functions and closures. `--play` allows the page's
media and starts its first video. `--state` sets where the page sits:
its tab in front, another tab in front of it, or its window minimized. A
page grows differently in each, because Gecko throttles timers and
rendering in pages nobody can see. Each log line ends with whether the page
reads itself as hidden.

