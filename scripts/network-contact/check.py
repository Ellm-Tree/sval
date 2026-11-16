# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

"""Drive a running Sval and judge every host it contacted.

Run by scripts/network-contact-test.sh, which starts the browser with
Marionette and Gecko's network logging. This file talks to Marionette
directly so that it needs nothing beyond the standard library.
"""

import argparse
import glob
import json
import os
import re
import socket
import sys
import time

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def free_port():
    """A TCP port on 127.0.0.1 that nothing listens on at the moment."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class MarionetteError(RuntimeError):
    """A command Marionette refused, with WebDriver's error code in `code`.

    The code is stable ("timeout", "javascript error"); the message is prose.
    """

    def __init__(self, command, error):
        self.code = error.get("error")
        super().__init__(f"{command}: {error.get('message')}")


class Marionette:
    def __init__(self, port):
        # A connection counts once the server's hello arrives: a socket can be
        # accepted and then reset while the browser is still starting, so the
        # connect and the hello are retried together, as Mozilla's
        # Marionette.raise_for_port does.
        deadline = time.monotonic() + 120
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port))
                # A switch that opens a dialog can leave a call unanswered; a
                # bounded wait turns that into an error instead of a hung CI job.
                self.sock.settimeout(120)
                self.file = self.sock.makefile("rb")
                self._recv()
                break
            except OSError:
                if getattr(self, "sock", None):
                    self.sock.close()
                if time.monotonic() > deadline:
                    sys.exit("network-contact: Marionette never came up")
                time.sleep(1)
        self.id = 0
        self.script_timeout_ms = 30000
        self.cmd("WebDriver:NewSession", {"capabilities": {}})
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def _recv(self):
        length = b""
        while (c := self.file.read(1)) != b":":
            if not c:
                raise ConnectionError("Marionette closed the connection")
            length += c
        return json.loads(self.file.read(int(length)))

    def cmd(self, name, params=None):
        self.id += 1
        body = json.dumps([0, self.id, name, params or {}]).encode()
        self.sock.sendall(str(len(body)).encode() + b":" + body)
        _, _, error, result = self._recv()
        if error:
            raise MarionetteError(name, error)
        return result

    def js(self, source, timeout_ms=30000):
        # Marionette takes a script's timeout from the session alone
        # (`GeckoDriver.#execute` reads `timeouts.script`); a parameter on
        # ExecuteAsyncScript is ignored, leaving every script at 30 s.
        if timeout_ms != self.script_timeout_ms:
            self.cmd("WebDriver:SetTimeouts", {"script": timeout_ms})
            self.script_timeout_ms = timeout_ms
        # Marionette's own timeout error has to arrive before the socket's.
        self.sock.settimeout(max(120, timeout_ms / 1000 + 30))
        return self.cmd(
            "WebDriver:ExecuteAsyncScript", {"script": source, "args": []}
        )["value"]


SHARE = r"""
let done = arguments[0];
(async () => {
  await SvalPanel.started;
  done(JSON.stringify(await SvalPanel.chooseSharedFolder(%s, { mint: true })));
})().catch(e => done(JSON.stringify({ reached: false, message: String(e) })));
"""


def share(m, folder, who):
    """Sets up `folder` as Settings does when a person chooses one.

    Choosing it mints this device's sync key, without which Sval shares
    nowhere, so a folder written into the profile's settings alone is never
    used.
    """
    answer = json.loads(m.js(SHARE % json.dumps(folder), 60000))
    if not answer.get("reached"):
        sys.exit(f"{who}: the shared folder was not set up: {answer.get('message')}")


# Answers first run in the window's dialog (SvalFirstRun.sys.mjs) as a
# person who takes each step's default does, with nothing to import and No to
# Default browser. The introduction moves on by Next through its frames, the
# welcome ends the flow by Start, and every other step by Continue. A step
# takes its button once the task after it has passed (first-run.js ignores a
# press in the same task), and a step still checking something keeps its
# button disabled until it is done.
FIRST_RUN = r"""
let done = arguments[0];
const steps = [];
(async () => {
  const deadline = Date.now() + 100000;
  const tick = () => new Promise(resolve => setTimeout(resolve, 100));
  const until = async (what, test) => {
    while (!test()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await tick();
    }
  };
  const doc = () => gDialogBox.isOpen && gDialogBox.dialog?._frame?.contentDocument;
  const shown = () =>
    [...(doc()?.querySelectorAll?.("main > section") ?? [])].find(s => !s.hidden);
  await until("first run to show", () => shown());
  // The flow's last Continue closes its page, and another dialog can take
  // the box after it.
  const page = doc();
  const ended = () => doc() !== page;
  for (;;) {
    // A step change can leave a moment with no step shown.
    await until("a step to show", () => ended() || shown());
    if (ended()) {
      break;
    }
    const section = shown();
    const step = section.dataset.step;
    if (steps.at(-1) !== step) {
      steps.push(step);
    }
    await new Promise(resolve => doc().defaultView.setTimeout(resolve, 0));
    // The import step lists the machine's own browsers, all ticked; the
    // run imports none of them, and CI's runners have none.
    if (step === "import") {
      for (const box of section.querySelectorAll('input[type="checkbox"]:checked')) {
        box.click();
      }
    }
    // Default browser is left out where Sval already is the default.
    section
      .querySelector('[data-setting="defaultBrowser"] input[type="radio"][value="false"]')
      ?.click();
    const frame = section.dataset.frame;
    const next = section.querySelector(".sval-fr-next, .sval-fr-start, .sval-fr-continue");
    await until(`the button on ${step}`, () => next && !next.disabled);
    next.click();
    await until(
      `the step after ${step}`,
      () => ended() || shown() !== section || section.dataset.frame !== frame
    );
  }
  done(JSON.stringify({ steps, after: doc()?.documentURI ?? null }));
})().catch(e => done(JSON.stringify({ error: String(e), steps })));
"""


def answer_first_run(m):
    answer = json.loads(m.js(FIRST_RUN, 110000))
    if "error" in answer:
        sys.exit(
            f"network-contact: first run was not answered after "
            f"{', '.join(answer['steps']) or 'no step'}: {answer['error']}"
        )
    print(f"network-contact: first run answered: {', '.join(answer['steps'])}", flush=True)
    if answer["after"]:
        sys.exit(f"network-contact: first run left a dialog open: {answer['after']}")


def drive(port, profile, page, idle_seconds, shared_folder=None, untrusted_page=None,
          first_run=False):
    m = Marionette(port)
    # Another browser on this machine may own a Marionette port, and driving
    # it would test the wrong browser.
    actual = m.js("arguments[0](PathUtils.profileDir)")
    if os.path.realpath(actual) != os.path.realpath(profile):
        sys.exit(f"network-contact: Marionette answered for {actual}, not {profile}")
    if first_run:
        answer_first_run(m)
    if shared_folder:
        share(m, shared_folder, "network-contact")

    load = (
        "gBrowser.selectedBrowser.loadURI(Services.io.newURI(%s), "
        "{triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});"
    )
    steps = [("load a local page", load % json.dumps(page))]
    if untrusted_page:
        steps.append(
            ("load a page whose certificate has an unknown issuer",
             load % json.dumps(untrusted_page))
        )
    steps += [
        ("type in the address bar", 'gURLBar.focus(); gURLBar.search("weather");'),
        ("type a shopping query", 'gURLBar.search("amazon");'),
        ("close the address bar", "gURLBar.view.close(); gURLBar.blur();"),
        ("open a new tab", "BrowserCommands.openTab();"),
        ("open settings", 'openPreferences("paneGeneral");'),
        ("open the add-ons manager", 'BrowserAddonUI.openAddonsMgr("addons://list/extension");'),
    ]
    collections = m.js(
        'arguments[0](Services.prefs.getStringPref("browser.sval.remoteSettings.collections", ""))'
    )
    for label, source in steps:
        print(f"network-contact: step: {label}", flush=True)
        # A step that throws contacted nothing, and the run would pass on the
        # other steps' contacts alone. A slow one still did its work.
        try:
            m.js(f"let done = arguments[0]; {source} setTimeout(done, 8000);", 20000)
        except MarionetteError as e:
            if e.code != "timeout":
                sys.exit(f"network-contact: step {label!r} failed: {e}")
            print(f"network-contact: step did not finish ({e}); continuing", flush=True)
        except (OSError, ConnectionError) as e:
            sys.exit(f"network-contact: step {label!r} lost the browser: {e}")

    print(f"network-contact: idle for {idle_seconds}s", flush=True)
    time.sleep(idle_seconds)

    try:
        m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
    except (OSError, ConnectionError, RuntimeError):
        pass
    # An entry may name the boolean pref it syncs under ("name@pref"); the
    # collection is listed either way.
    return {c.split("@")[0].strip() for c in collections.split(",") if c.strip()}


REQUEST = re.compile(r"E/nsHttp uri=(\S+)")
RESOLVE = re.compile(r"Resolving host \[([^\]]+)\]")
SOCKET = re.compile(r"nsSocketTransport::Init \[this=\S+ host=(\S+?):\d+ ")
CHANGESET = re.compile(r"/buckets/([^/]+)/collections/([^/?]+)")
ATTACHMENT = re.compile(r"^https://firefox-settings-attachments\.cdn\.mozilla\.net/([^/]+)/([^/]+)/")


def judge(log_dir, allowed_file, collections, opt_in_allowed=False):
    hosts = {}
    synced = set()
    # Each pattern sees contacts the others can miss, so a log line Gecko
    # renamed would blind the check to them; every one must match at least once.
    matched = set()
    for path in glob.glob(os.path.join(log_dir, "*")):
        with open(path, errors="replace") as f:
            for line in f:
                for pattern in (REQUEST, RESOLVE, SOCKET):
                    match = pattern.search(line)
                    if not match:
                        continue
                    matched.add(pattern)
                    value = match.group(1)
                    host = value.split("://", 1)[1].split("/", 1)[0] if pattern is REQUEST else value
                    host = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
                    host = host.rstrip(".").lower()
                    if host and host not in LOCAL_HOSTS:
                        hosts.setdefault(host, line[:26])
                    if pattern is REQUEST:
                        for rx in (CHANGESET, ATTACHMENT):
                            found = rx.search(value)
                            if found and found.group(1) not in ("monitor", "bundles"):
                                synced.add(found.group(2))
                    break

    rules = {}
    with open(allowed_file) as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if line:
                host, status, reason = line.split(None, 2)
                rules[host] = (status, reason)

    failures = []
    for host, first in sorted(hosts.items(), key=lambda kv: kv[1]):
        status, reason = rules.get(host, (None, None))
        if status == "allowed":
            print(f"network-contact: ok       {host}")
        elif status == "pending":
            print(f"network-contact: PENDING  {host} — {reason}")
        elif status == "opt-in" and opt_in_allowed:
            print(f"network-contact: opt-in   {host} — {reason}")
        else:
            print(f"network-contact: FAIL     {host} (first at {first})")
            failures.append(host)

    for collection in sorted(synced - collections):
        print(f"network-contact: FAIL     Remote Settings collection {collection} is not in browser.sval.remoteSettings.collections")
        failures.append(collection)

    if not hosts:
        failures.append("<nothing logged>")
        print("network-contact: FAIL     no network activity was logged at all, so nothing was tested")
    for name, pattern in (("REQUEST", REQUEST), ("RESOLVE", RESOLVE), ("SOCKET", SOCKET)):
        if pattern not in matched:
            failures.append(f"<no {name} line>")
            print(f"network-contact: FAIL     no log line matched {name} ({pattern.pattern}), so the contacts it sees were not checked")
    return failures


def collect_switches(port, profile):
    """Every boolean a person can turn on from Sval's UI.

    Settings registers each control's pref with `Preferences` as its pane
    loads, so visiting every pane yields every settings switch. The new tab's
    switches are its PREFS_CONFIG entries, less the `system.` ones, which are
    region and experiment gates rather than controls. The address bar's are
    its `suggest.` prefs.

    "Always use private browsing mode" is left out. It makes every window
    private, and a private window gets Firefox's tab strip and no Sval panel,
    so Sval would never start and the run would measure none of it.
    """
    m = Marionette(port)
    actual = m.js("arguments[0](PathUtils.profileDir)")
    if os.path.realpath(actual) != os.path.realpath(profile):
        sys.exit(f"network-contact: Marionette answered for {actual}, not {profile}")
    m.js('openPreferences("paneGeneral"); setTimeout(arguments[0], 5000);', 15000)
    found = set()
    # The panes are the nav's buttons as Sval leaves them, its own included
    # and Firefox's emptied ones removed (`arrangeNav` in settings-pane.js).
    # gotoPref settles once the pane has shown, and shows the default pane in
    # place of one it cannot show, so a pane that did not show fails the
    # collection rather than leaving its switches out.
    panes = m.js(
        "arguments[0]([...gBrowser.selectedBrowser.contentDocument"
        ".querySelectorAll('moz-page-nav-button[view]')]"
        ".filter(b => b.checkVisibility()).map(b => b.getAttribute('view')))"
    )
    if not panes:
        sys.exit("network-contact: settings showed no panes")
    for pane in panes:
        shown = m.js(
            "let done = arguments[0]; let pane = %s;"
            "let w = gBrowser.selectedBrowser.contentWindow;"
            "w.gotoPref(pane).then(() => done({ shown: w.gLastCategory.category,"
            " prefs: w.Preferences.getAll().filter(p => p.type == 'bool').map(p => p.id) }),"
            " e => done({ error: String(e) }));" % json.dumps(pane),
            15000,
        )
        if "error" in shown:
            sys.exit(f"network-contact: settings pane {pane} failed: {shown['error']}")
        if shown["shown"] != pane:
            sys.exit(f"network-contact: settings showed {shown['shown']} for {pane}")
        found.update(shown["prefs"])
    found.update(m.js(
        "let done = arguments[0];"
        "const { PREFS_CONFIG } = ChromeUtils.importESModule('resource://newtab/lib/ActivityStream.sys.mjs');"
        "const branch = 'browser.newtabpage.activity-stream.';"
        "done([...PREFS_CONFIG.keys()].filter(k => !k.startsWith('system.'))"
        ".map(k => branch + k)"
        ".filter(n => Services.prefs.getPrefType(n) == Services.prefs.PREF_BOOL));"
    ))
    found.update(m.js(
        "arguments[0](Services.prefs.getChildList('browser.urlbar.suggest.')"
        ".concat(['browser.search.suggest.enabled'])"
        ".filter(n => Services.prefs.getPrefType(n) == Services.prefs.PREF_BOOL));"
    ))
    try:
        m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
    except (OSError, ConnectionError, RuntimeError):
        pass
    found.discard("browser.privatebrowsing.autostart")
    return sorted(found)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--collect-switches", metavar="OUT")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--log-dir", required=True)
    parser.add_argument("--page")
    parser.add_argument("--untrusted-page")
    parser.add_argument("--allowed")
    parser.add_argument("--idle", type=int, default=150)
    parser.add_argument("--opt-in-allowed", action="store_true")
    parser.add_argument("--shared-folder")
    parser.add_argument("--first-run", action="store_true")
    args = parser.parse_args()

    if args.collect_switches:
        switches = collect_switches(args.port, args.profile)
        with open(args.collect_switches, "w") as f:
            f.write("\n".join(switches) + "\n")
        print(f"network-contact: {len(switches)} switches found")
        return 0

    collections = drive(
        args.port, args.profile, args.page, args.idle, args.shared_folder,
        args.untrusted_page, args.first_run,
    )
    time.sleep(3)
    failures = judge(args.log_dir, args.allowed, collections, args.opt_in_allowed)
    if failures:
        print(f"network-contact: {len(failures)} unexpected contact(s); see spec §10.9")
        return 1
    print("network-contact: every contact is on the list")
    return 0


if __name__ == "__main__":
    sys.exit(main())
