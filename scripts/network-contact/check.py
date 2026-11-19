# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

"""Drive a running Sval and judge every host it contacted.

Run by scripts/network-contact-test.sh, which starts the browser with
Marionette and Gecko's network logging. This file talks to Marionette
directly so that it needs nothing beyond the standard library.

With --capture it judges the iPhone app instead, from the packet capture
scripts/network-contact-ios.sh takes of a simulator session.
"""

import argparse
import glob
import ipaddress
import json
import os
import re
import socket
import struct
import subprocess
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


def read_rules(allowed_file):
    """allowed-hosts.txt as {host: (status, reason)}."""
    rules = {}
    with open(allowed_file) as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if line:
                host, status, reason = line.split(None, 2)
                rules[host] = (status, reason)
    return rules


def judge_hosts(hosts, rules, opt_in_allowed):
    """Prints each host's verdict, in the order `hosts`' values sort, and
    returns the hosts that fail."""
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
    return failures


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

    failures = judge_hosts(hosts, read_rules(allowed_file), opt_in_allowed)

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


# The iPhone app's processes, by executable name, among the simulator's: the
# app and the WebKit processes its web views and their Safe Browsing checks
# run in. The simulator's system daemons are the operating system's, as the
# desktop check leaves out the operating system's own contacts.
DEVICE_PROCESSES = re.compile(r"^(Sval|com\.apple\.WebKit\..+|com\.apple\.Safari\.SafeBrowsing\.Service)$")


def device_pids(processes_file, launchd_pid):
    """{pid: name} for every Sval or WebKit process the simulator ran.

    `processes_file` holds `ps -axo pid=,ppid=,comm=` snapshots taken through
    the session. The simulator's launchd_sim starts each of the device's
    processes, so its children are the device's alone, and another booted
    simulator's WebKit processes, which share these names, are left out.
    """
    found = {}
    with open(processes_file, errors="replace") as f:
        for line in f:
            parts = line.split(None, 2)
            if len(parts) != 3 or parts[1] != str(launchd_pid):
                continue
            name = os.path.basename(parts[2].strip())
            if DEVICE_PROCESSES.match(name):
                found[int(parts[0])] = name
    return found


def capture_packets(path):
    """Yields (link type, bytes) for each packet of a pcapng or pcap file."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] in (b"\xd4\xc3\xb2\xa1", b"\xa1\xb2\xc3\xd4"):
        e = "<" if data[:4] == b"\xd4\xc3\xb2\xa1" else ">"
        link = struct.unpack_from(e + "I", data, 20)[0]
        off = 24
        while off + 16 <= len(data):
            length = struct.unpack_from(e + "I", data, off + 8)[0]
            yield link, data[off + 16:off + 16 + length]
            off += 16 + length
        return
    e, links, off = "<", [], 0
    while off + 12 <= len(data):
        kind = struct.unpack_from(e + "I", data, off)[0]
        if kind == 0x0A0D0D0A:
            e = "<" if data[off + 8:off + 12] == b"\x4d\x3c\x2b\x1a" else ">"
            links = []
        length = struct.unpack_from(e + "I", data, off + 4)[0]
        if length < 12:
            sys.exit(f"network-contact: {path} is not a capture this check can read")
        body = off + 8
        if kind == 1:
            links.append(struct.unpack_from(e + "H", data, body)[0])
        elif kind == 6:
            iface, _, _, caplen = struct.unpack_from(e + "IIII", data, body)
            yield links[iface], data[body + 20:body + 20 + caplen]
        off += length


def ip_layer(link, frame):
    """The IP packet in a frame of the given link type, or None."""
    if link in (0, 108):  # NULL and LOOP: a 4-byte address family
        return frame[4:]
    if link == 1:  # Ethernet
        kind, start = struct.unpack_from("!H", frame, 12)[0], 14
        if kind == 0x8100:
            kind, start = struct.unpack_from("!H", frame, 16)[0], 18
        return frame[start:] if kind in (0x0800, 0x86DD) else None
    if link in (12, 14, 101, 228, 229):  # raw IP
        return frame
    if link in (149, 258):  # PKTAP: its header, then the frame it carries
        header, inner = struct.unpack_from("<I", frame, 0)[0], struct.unpack_from("<I", frame, 8)[0]
        return ip_layer(inner, frame[header:])
    return None


def transport(packet):
    """(protocol, source, destination, source port, destination port, payload,
    whether the packet opens a TCP connection)."""
    if not packet:
        return None
    version = packet[0] >> 4
    if version == 4 and len(packet) >= 20:
        start, proto = (packet[0] & 15) * 4, packet[9]
        end = struct.unpack_from("!H", packet, 2)[0]
        src, dst = ipaddress.ip_address(packet[12:16]), ipaddress.ip_address(packet[16:20])
    elif version == 6 and len(packet) >= 40:
        start, proto = 40, packet[6]
        end = 40 + struct.unpack_from("!H", packet, 4)[0]
        src, dst = ipaddress.ip_address(packet[8:24]), ipaddress.ip_address(packet[24:40])
        while proto in (0, 43, 60) and start + 8 <= len(packet):
            proto, start = packet[start], start + (packet[start + 1] + 1) * 8
    else:
        return None
    body = packet[start:end]
    if proto == 6 and len(body) >= 20:
        sport, dport = struct.unpack_from("!HH", body)
        opens = body[13] & 0x12 == 0x02  # SYN without ACK
        return "tcp", src, dst, sport, dport, body[(body[12] >> 4) * 4:], opens
    if proto == 17 and len(body) >= 8:
        sport, dport = struct.unpack_from("!HH", body)
        return "udp", src, dst, sport, dport, body[8:], False
    return None


def dns_name(msg, off):
    labels, jumps = [], 0
    while off < len(msg):
        n = msg[off]
        if n == 0:
            return ".".join(labels), off + 1
        if n & 0xC0 == 0xC0:
            if jumps > 20 or off + 1 >= len(msg):
                return None, None
            jumps += 1
            name, _ = dns_name(msg, ((n & 0x3F) << 8) | msg[off + 1])
            return (".".join(labels + [name]) if name is not None else None), off + 2
        labels.append(msg[off + 1:off + 1 + n].decode("ascii", "replace"))
        off += 1 + n
    return None, None


def dns_message(msg):
    """(the names asked, [(name asked, address answered)]) of a DNS message."""
    try:
        qd, an = struct.unpack_from("!HH", msg, 4)
        off, names, answers = 12, [], []
        for _ in range(qd):
            name, off = dns_name(msg, off)
            if name is None:
                return [], []
            names.append(name)
            off += 4
        for _ in range(an):
            _, off = dns_name(msg, off)
            if off is None:
                break
            kind, _, _, length = struct.unpack_from("!HHIH", msg, off)
            rdata = msg[off + 10:off + 10 + length]
            off += 10 + length
            if names and ((kind == 1 and length == 4) or (kind == 28 and length == 16)):
                answers.append((names[0], ipaddress.ip_address(rdata)))
        return names, answers
    except (struct.error, ValueError):
        return [], []


def client_hello_name(stream):
    """The server name a TLS ClientHello at the start of `stream` asks for;
    None when there is none, and "" while the hello is still incomplete."""
    if len(stream) < 5 or stream[0] != 0x16:
        return None
    if len(stream) < 5 + struct.unpack_from("!H", stream, 3)[0]:
        return ""
    try:
        if stream[5] != 1:
            return None
        off = 5 + 4 + 2 + 32
        off += 1 + stream[off]
        off += 2 + struct.unpack_from("!H", stream, off)[0]
        off += 1 + stream[off]
        end = off + 2 + struct.unpack_from("!H", stream, off)[0]
        off += 2
        while off + 4 <= end:
            kind, length = struct.unpack_from("!HH", stream, off)
            if kind == 0:
                size = struct.unpack_from("!H", stream, off + 7)[0]
                return stream[off + 9:off + 9 + size].decode("ascii", "replace")
            off += 4 + length
    except (struct.error, IndexError):
        pass
    return None


HTTP_HOST = re.compile(rb"^[A-Z]+ \S+ HTTP/1\.[01]\r\n(?:.*\r\n)*?host:\s*([^\s:]+)", re.I)


def remote(address):
    return not (address.is_loopback or address.is_link_local or address.is_multicast
                or address.is_unspecified)


def judge_capture(capture, processes_file, launchd_pid, allowed_file, opt_in_allowed):
    pids = device_pids(processes_file, launchd_pid)
    names = sorted(set(pids.values()))
    print(f"network-contact: {len(pids)} processes measured: {', '.join(names) or 'none'}")
    if "Sval" not in names:
        print("network-contact: FAIL     the capture names no Sval process, so nothing was tested")
        return ["<no Sval process>"]

    # The device resolves through the Mac's mDNSResponder, which asks on the
    # app's behalf, so its queries carry the app as their effective process
    # (tcpdump's `epid`). The answers to any process tie an address to the
    # names it was looked up by.
    answered = {}
    for link, frame in capture_packets(capture):
        found = transport(ip_layer(link, frame))
        if found and found[0] == "udp" and found[3] == 53:
            for name, address in dns_message(found[5])[1]:
                answered.setdefault(address, set()).add(name.rstrip(".").lower())

    ours = capture + ".device"
    expression = " or ".join(f"pid={p} or epid={p}" for p in sorted(pids))
    subprocess.run(["tcpdump", "-r", capture, "-Q", f"({expression}) and dir=out", "-w", ours],
                   check=True, stderr=subprocess.DEVNULL)

    hosts, flows, streams, named, settled, hellos = {}, {}, {}, set(), set(), 0
    # The TCP connections whose opening packet is in the capture. One that
    # was already open when the capture began had its lookup and server
    # name before it.
    opened = set()
    for index, (link, frame) in enumerate(capture_packets(ours)):
        found = transport(ip_layer(link, frame))
        if not found:
            continue
        proto, _, dst, sport, dport, payload, opens = found
        first = f"packet {index:07d}"
        if proto == "udp" and dport == 53:
            for name in dns_message(payload)[0]:
                hosts.setdefault(name.rstrip(".").lower(), first)
            continue
        if not remote(dst) or (proto == "udp" and dport == 5353):
            continue
        flow = (proto, sport, dst, dport)
        if flow not in flows and opens:
            opened.add(flow)
        flows.setdefault(flow, first)
        if proto != "tcp" or flow in settled or not payload:
            continue
        stream = streams.get(flow, b"") + payload
        streams[flow] = stream[:65536]
        name = client_hello_name(stream)
        if name:
            hellos += 1
        elif name is None:
            match = HTTP_HOST.match(stream)
            name = match.group(1).decode("ascii", "replace") if match else None
        if name:
            hosts.setdefault(name.rstrip(".").lower(), first)
            named.add(flow)
        if name != "":
            settled.add(flow)
            streams.pop(flow, None)

    rules = read_rules(allowed_file)
    failures = []
    for flow, first in sorted(flows.items(), key=lambda kv: kv[1]):
        if flow in named:
            continue
        candidates = answered.get(flow[2], set())
        # An address several names share, as a CDN's are, counts as the
        # listed ones: the session's own lookups are among them.
        listed = {n for n in candidates if n in rules}
        for name in listed or candidates:
            hosts.setdefault(name, first)
        if not candidates:
            if flow[0] == "tcp":
                state = "opened in the capture" if flow in opened else "open before the capture began"
                state = f", {state}"
            else:
                state = ""
            print(f"network-contact: FAIL     {flow[0]} to {flow[2]} port {flow[3]}, an address no "
                  f"lookup or server name in the capture explains{state} (first at {first})")
            failures.append(str(flow[2]))
    failures += judge_hosts(hosts, rules, opt_in_allowed)
    if not flows:
        failures.append("<no contact>")
        print("network-contact: FAIL     the app's processes sent nothing, so nothing was tested")
    if not hellos:
        failures.append("<no server name>")
        print("network-contact: FAIL     no TLS server name was read, so the names were not checked")
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
    parser.add_argument("--port", type=int)
    parser.add_argument("--profile")
    parser.add_argument("--log-dir")
    parser.add_argument("--capture", help="a pktap capture of the iPhone simulator, in pcapng")
    parser.add_argument("--processes", help="ps snapshots taken during the capture")
    parser.add_argument("--launchd-pid", type=int, help="the simulator's launchd_sim")
    parser.add_argument("--page")
    parser.add_argument("--untrusted-page")
    parser.add_argument("--allowed")
    parser.add_argument("--idle", type=int, default=150)
    parser.add_argument("--opt-in-allowed", action="store_true")
    parser.add_argument("--shared-folder")
    parser.add_argument("--first-run", action="store_true")
    args = parser.parse_args()

    if args.capture:
        failures = judge_capture(args.capture, args.processes, args.launchd_pid,
                                 args.allowed, args.opt_in_allowed)
        if failures:
            print(f"network-contact: {len(failures)} unexpected contact(s); see spec §10.9")
            return 1
        print("network-contact: every contact is on the list")
        return 0
    if args.port is None or args.profile is None or args.log_dir is None:
        parser.error("--port, --profile and --log-dir are required without --capture")

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
