# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

"""Drive a private session in a running Sval, and search a profile for it.

Run by scripts/private-browsing-test.sh (private-windows spec). Standard
library only, like scripts/network-contact/check.py, whose Marionette client
this borrows.
"""

import argparse
import json
import os
import struct
import sys
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "network-contact"))
from check import Marionette, share  # noqa: E402

DRIVE = r"""
let done = arguments[0];
(async () => {
  const marks = %(marks)s;
  const permanent = %(permanent)s;
  const until = async (test, what) => {
    for (let i = 0; i < 300; i++) {
      if (await test()) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("timed out waiting for " + what);
  };
  await SvalPanel.started;
  let win = window;
  if (!permanent) {
    // Something for the normal window to sync while the private one is open,
    // marked so the scan can prove it reads inside Sval's sealed files.
    gBrowser.addTrustedTab("about:blank#" + %(normal)s);
    win = OpenBrowserWindow({ private: true });
    await until(() => win.SvalPanel?._started, "the private window");
  }
  await win.SvalPanel.started;
  const panel = win.SvalPanel;
  if (!panel._engine?.isPrivate) throw new Error("the window is not on a private tree");
  for (const mark of marks.slice(0, 3)) {
    win.gBrowser.selectedTab = win.gBrowser.addTrustedTab(
      "data:text/html,<title>" + mark + "</title><p>" + mark + "</p>"
    );
  }
  await until(async () => {
    const nodes = (await panel._engine.tree()).nodes;
    return Object.values(nodes).filter(n => n.kind === "tab" &&
      marks.some(m => n.content?.url?.includes(m))).length === 3;
  }, "the private tabs to be filed");
  panel._promptForNewGroup = async () => ({ name: marks[3], color: null, emoji: null });
  await panel._addGroup();
  await until(async () => Object.values((await panel._engine.tree()).nodes)
    .some(n => n.content?.name === marks[3]), "the group");
  if (!permanent) await SvalPanel.syncNow();
  // The kill that follows must find the session store's file written with
  // the private window open, as a crash would.
  const { SessionSaver } = ChromeUtils.importESModule(
    "resource:///modules/sessionstore/SessionSaver.sys.mjs"
  );
  await SessionSaver.run();
  done(JSON.stringify(Object.keys((await panel._engine.tree()).nodes)));
})().catch(e => done("ERR " + e));
"""

RELAUNCHED = r"""
let done = arguments[0];
(async () => {
  await SvalPanel.started;
  if (!SvalPanel.engine?.isPrivate) await SvalPanel.syncNow();
  const { SessionSaver } = ChromeUtils.importESModule(
    "resource:///modules/sessionstore/SessionSaver.sys.mjs"
  );
  await SessionSaver.run();
  done("ok");
})().catch(e => done("ERR " + e));
"""

# Opens every file Sval sealed under the profile and the shared folder, and
# writes each one's plaintext into `out`, so the scan reads what the files
# hold. It mirrors `seal` in engine/src/crypto.rs: AES-256-GCM under the key
# HKDF-SHA256 expands from the root key with "sval seal v1" and no salt, the
# file being the header, a 12-byte nonce, then the ciphertext and tag, and
# the associated data the header then the file's path under its root. A file
# that starts with the header and opens under neither key is reported, since
# the scan cannot see into it.
OPEN = r"""
let done = arguments[0];
(async () => {
  const out = %(out)s;
  await SvalPanel.started;
  const engine = SvalPanel.engine;
  const { SvalIdentity } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
  );
  const raw = [await SvalIdentity.localKey(), engine.syncKey].filter(Boolean);
  if (raw.length < 2) throw new Error("the relaunched window has no sync key");
  const keys = await Promise.all(raw.map(async bytes => {
    const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(),
        info: new TextEncoder().encode("sval seal v1") },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }));
  const header = new Uint8Array([0x73, 0x76, 0x6c, 1]);
  // The profile's `lock` is a symlink to nothing on Linux, which stat
  // cannot follow, and holds nothing Sval wrote.
  const files = async function* (dir) {
    for (const child of await IOUtils.getChildren(dir)) {
      const type = await IOUtils.stat(child).then(s => s.type, () => null);
      if (type === "directory") yield* files(child);
      else if (type === "regular") yield child;
    }
  };
  let opened = 0;
  const unreadable = [];
  for (const root of [engine.root, engine.sharedRoot]) {
    for await (const file of files(root)) {
      const bytes = await IOUtils.read(file);
      if (bytes.length < 16 || !header.every((b, i) => bytes[i] === b)) continue;
      const path = file.slice(root.length + 1).replaceAll("\\", "/");
      const aad = new Uint8Array([...header, ...new TextEncoder().encode(path)]);
      let plain = null;
      for (const key of keys) {
        try {
          plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes.subarray(4, 16), additionalData: aad },
            key, bytes.subarray(16));
          break;
        } catch {}
      }
      if (!plain) { unreadable.push(file); continue; }
      await IOUtils.write(PathUtils.join(out, `${opened++}.json`), new Uint8Array(plain));
    }
  }
  done(JSON.stringify({ opened, unreadable }));
})().catch(e => done("ERR " + e));
"""


def connect(port, profile):
    m = Marionette(port)
    actual = m.js("arguments[0](PathUtils.profileDir)")
    if os.path.realpath(actual) != os.path.realpath(profile):
        sys.exit(f"private-browsing: Marionette answered for {actual}, not {profile}")
    return m


def drive(args):
    marks = [f"svalmark{uuid.uuid4().hex}" for _ in range(4)]
    normal = f"svalnormal{uuid.uuid4().hex}"
    m = connect(args.port, args.profile)
    if args.shared:
        share(m, args.shared, "private-browsing")
    result = m.js(
        DRIVE
        % {
            "marks": json.dumps(marks),
            "normal": json.dumps(normal),
            "permanent": json.dumps(args.permanent),
        },
        120000,
    )
    if result.startswith("ERR"):
        sys.exit(f"private-browsing: driving the session failed: {result}")
    ids = json.loads(result)
    with open(args.out, "w") as f:
        json.dump({"private": marks + ids, "normal": normal}, f)
    print(f"private-browsing: drove a private session ({len(ids)} private nodes)", flush=True)
    return 0


def relaunched(args):
    m = connect(args.port, args.profile)
    result = m.js(RELAUNCHED, 120000)
    if result != "ok":
        sys.exit(f"private-browsing: the relaunch failed: {result}")
    if args.open:
        os.makedirs(args.open, exist_ok=True)
        result = m.js(OPEN % {"out": json.dumps(args.open)}, 120000)
        if result.startswith("ERR"):
            sys.exit(f"private-browsing: opening Sval's files failed: {result}")
        answer = json.loads(result)
        for path in answer["unreadable"]:
            print(f"private-browsing: FAIL cannot open the sealed file {path}")
        if answer["unreadable"] or not answer["opened"]:
            sys.exit("private-browsing: the scan cannot see into every file Sval sealed")
        print(f"private-browsing: opened {answer['opened']} sealed file(s)", flush=True)
    try:
        m.cmd("Marionette:Quit", {"flags": ["eAttemptQuit"]})
    except (OSError, ConnectionError, RuntimeError):
        pass
    return 0


def lz4_block(src, size):
    """Decompresses one LZ4 block, the format inside Firefox's mozLz4 files."""
    out = bytearray()
    i = 0
    while i < len(src):
        token = src[i]
        i += 1
        literal = token >> 4
        if literal == 15:
            while True:
                b = src[i]
                i += 1
                literal += b
                if b != 255:
                    break
        out += src[i:i + literal]
        i += literal
        if i >= len(src):
            break
        offset = src[i] | (src[i + 1] << 8)
        i += 2
        match = (token & 15) + 4
        if (token & 15) == 15:
            while True:
                b = src[i]
                i += 1
                match += b
                if b != 255:
                    break
        start = len(out) - offset
        for k in range(match):
            out.append(out[start + k])
    return bytes(out[:size])


def texts_of(path):
    with open(path, "rb") as f:
        data = f.read()
    texts = [data, data.replace(b"\0", b"")]
    if data.startswith(b"mozLz40\0"):
        (size,) = struct.unpack("<I", data[8:12])
        try:
            texts.append(lz4_block(data[12:], size))
        except IndexError:
            texts.append(b"")
    return texts


def scan(args):
    with open(args.markers) as f:
        markers = json.load(f)
    marks = [m.encode() for m in markers["private"]]
    normal = markers["normal"].encode()
    seen_normal = False
    found = []
    for root in args.roots:
        for dirpath, _, names in os.walk(root):
            for name in names:
                path = os.path.join(dirpath, name)
                if os.path.islink(path) or not os.path.isfile(path):
                    continue
                opened = args.opened and path.startswith(args.opened + os.sep)
                for text in texts_of(path):
                    seen_normal = seen_normal or (opened and normal in text)
                    for mark in marks:
                        if mark in text:
                            found.append(f"{path}: {mark.decode()}")
    if args.opened and not seen_normal:
        print(
            "private-browsing: FAIL the normal window's tab is in none of Sval's "
            "opened files, so the scan cannot see into them"
        )
        return 1
    found = sorted(set(found))
    for line in found:
        print(f"private-browsing: FOUND {line}")
    if found:
        print(f"private-browsing: FAIL {len(found)} trace(s) of the private session on disk")
        return 1
    print("private-browsing: no trace of the private session anywhere")
    return 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="what", required=True)
    d = sub.add_parser("drive")
    d.add_argument("--port", type=int, required=True)
    d.add_argument("--profile", required=True)
    d.add_argument("--out", required=True)
    d.add_argument("--permanent", action="store_true")
    d.add_argument("--shared", help="a shared folder for the normal window to sync to")
    r = sub.add_parser("relaunched")
    r.add_argument("--port", type=int, required=True)
    r.add_argument("--profile", required=True)
    r.add_argument("--open", help="a directory for the plaintext of Sval's sealed files")
    s = sub.add_parser("scan")
    s.add_argument("--markers", required=True)
    s.add_argument(
        "--opened",
        help="the plaintext of Sval's sealed files, which must hold the normal window's tab",
    )
    s.add_argument("roots", nargs="+")
    args = parser.parse_args()
    return {"drive": drive, "relaunched": relaunched, "scan": scan}[args.what](args)


if __name__ == "__main__":
    sys.exit(main())
