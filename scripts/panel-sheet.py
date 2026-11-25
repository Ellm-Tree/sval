#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Draw the whole window at a run of Workspace panel widths, into one image.

Runs the built Sval headless on a throwaway profile, sets the panel to each
width in turn, with the panel shown and then hidden, and draws the window at
each. Every drawing is saved on its own, and all of them side by side in
sheet.png, each labelled with its width and state.

    python3 -I scripts/panel-sheet.py
    python3 -I scripts/panel-sheet.py --widths 48,64,120,248,280
    python3 -I scripts/panel-sheet.py --pref browser.sval.toolbar.inPanel=true
    python3 -I scripts/panel-sheet.py --app ../other/build/.../Sval.app

Output goes to build/panel-sheet/<time>/ unless --out names a folder.
"""

import argparse
import contextlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "scripts", "network-contact"))
from check import Marionette, free_port  # noqa: E402

# Every width from 73 to 191 snaps to 48 or 192, so the sheet draws those two.
DEFAULT_WIDTHS = [48, 192] + list(range(200, 401, 20)) + [239, 240, 247, 248, 280]

# Through user.js, so the run starts as a returning person's window would.
PREFS = {
    "remote.prefs.recommended": False,
    "browser.sval.firstRun.enabled": False,
}

DRAW = r"""
const done = arguments[0];
const { widths, out, scale } = %s;
(async () => {
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise(r => requestAnimationFrame(() => r()));
    }
    // The panel's slide and any observer that answers a resize in a task
    // of its own.
    await new Promise(r => setTimeout(r, 900));
  };
  await SvalPanel.started;
  const W = window.innerWidth, H = window.innerHeight;
  const dpr = window.devicePixelRatio;
  const shots = [];
  const draw = async name => {
    await settle();
    const c = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.drawWindow(window, 0, 0, W, H, "magenta");
    const blob = await new Promise(r => c.toBlob(r));
    await IOUtils.write(`${out}/${name}.png`, new Uint8Array(await blob.arrayBuffer()));
    shots.push({ name, canvas: c });
  };
  const container = document.getElementById("sval-panel-container");
  const hidden = () => container.hasAttribute("sval-collapsed");
  for (const w of widths) {
    SvalPanel._setPanelWidth(w);
    if (hidden()) SvalPanel.toggleVisible();
    await draw(`w${String(w).padStart(3, "0")}-shown`);
    SvalPanel.toggleVisible();
    await draw(`w${String(w).padStart(3, "0")}-hidden`);
    SvalPanel.toggleVisible();
  }
  SvalPanel._setPanelWidth(null);

  // The sheet: shown and hidden side by side, one width per row.
  const cw = Math.round(W * scale), ch = Math.round(H * scale), label = 28, gap = 12;
  const sheet = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  sheet.width = 2 * cw + 3 * gap;
  sheet.height = widths.length * (ch + label + gap) + gap;
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = "bold 18px sans-serif";
  shots.forEach((s, i) => {
    const row = Math.floor(i / 2), col = i %% 2;
    const x = gap + col * (cw + gap), y = gap + row * (ch + label + gap);
    ctx.fillStyle = "#000";
    ctx.fillText(s.name, x, y + 20);
    ctx.drawImage(s.canvas, x, y + label, cw, ch);
  });
  const blob = await new Promise(r => sheet.toBlob(r));
  await IOUtils.write(`${out}/sheet.png`, new Uint8Array(await blob.arrayBuffer()));
  done(JSON.stringify({ shots: shots.length }));
})().catch(e => done(JSON.stringify({ error: String(e), stack: e.stack })));
"""


def default_app():
    dist = os.path.join(REPO_ROOT, "build", "firefox")
    for objdir in sorted(os.listdir(dist)) if os.path.isdir(dist) else []:
        for name in ("Sval.app", "sval"):
            path = os.path.join(dist, objdir, "dist", name)
            if objdir.startswith("objdir") and os.path.exists(path):
                return path
    sys.exit("panel-sheet: no built Sval here; pass --app")


def binary_of(app):
    if app.endswith(".app"):
        with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
            executable = plistlib.load(f)["CFBundleExecutable"]
        return os.path.join(app, "Contents", "MacOS", executable)
    return os.path.join(app, "sval")


def pref_value(text):
    if text in ("true", "false"):
        return text == "true"
    try:
        return int(text)
    except ValueError:
        return text


@contextlib.contextmanager
def session(binary, work, prefs, size):
    """Runs Sval headless on a fresh profile in `work` and yields its
    Marionette client. Sval is quit on the way out, and killed if it does not
    quit."""
    profile = os.path.join(work, "profile")
    os.makedirs(profile)
    port = free_port()
    with open(os.path.join(profile, "user.js"), "w") as f:
        for name, value in dict(prefs, **{"marionette.port": port}).items():
            f.write(f"user_pref({json.dumps(name)}, {json.dumps(value)});\n")
    appdata = os.path.join(work, "appdata")
    env = dict(
        os.environ,
        MOZ_HEADLESS="1",
        MOZ_HEADLESS_WIDTH=str(size[0]),
        MOZ_HEADLESS_HEIGHT=str(size[1]),
        # Never the person's own Application Support
        # (nsXREDirProvider::GetUserDataDirectory).
        MOZ_APP_DATA=os.path.join(appdata, "data"),
        MOZ_LOCAL_APP_DATA=os.path.join(appdata, "local"),
        MOZ_CRASHREPORTER_DISABLE="1",
    )
    with open(os.path.join(work, "sval.log"), "w") as log:
        proc = subprocess.Popen(
            [
                binary,
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
            with contextlib.suppress(ConnectionError, OSError, RuntimeError):
                m.cmd("Marionette:Quit", {"flags": ["eAttemptQuit"]})
        try:
            proc.wait(60 if m else 0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--app", help="Sval.app or the folder holding sval")
    parser.add_argument("--out", help="the folder the drawings go to")
    parser.add_argument("--widths", help="comma-separated panel widths in px")
    parser.add_argument("--pref", action="append", default=[], help="name=value")
    parser.add_argument("--size", default="1200x760", help="the window, WxH")
    parser.add_argument("--scale", type=float, default=0.5, help="sheet scale")
    args = parser.parse_args()

    widths = (
        [int(w) for w in args.widths.split(",")]
        if args.widths
        else sorted(set(DEFAULT_WIDTHS))
    )
    prefs = dict(PREFS)
    for item in args.pref:
        name, _, value = item.partition("=")
        prefs[name] = pref_value(value)
    size = tuple(int(n) for n in args.size.split("x"))
    out = os.path.abspath(
        args.out
        or os.path.join(
            REPO_ROOT, "build", "panel-sheet", time.strftime("%Y%m%d-%H%M%S")
        )
    )
    os.makedirs(out, exist_ok=True)
    work = os.path.join(out, "work")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)

    binary = binary_of(os.path.abspath(args.app) if args.app else default_app())
    with session(binary, work, prefs, size) as m:
        params = json.dumps({"widths": widths, "out": out, "scale": args.scale})
        result = json.loads(m.js(DRAW % params, timeout_ms=600_000))
    shutil.rmtree(os.path.join(work, "profile"), ignore_errors=True)
    if "error" in result:
        sys.exit(f"panel-sheet: {result['error']}\n{result.get('stack', '')}")
    print(f"{result['shots']} drawings and the sheet in {out}/sheet.png")


if __name__ == "__main__":
    main()
