#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""sval launched through a path with a symlink in it starts a utility process.

macOS only. A sandboxed child that resolves a path through a symlink needs
file-read-metadata on the link, and SandboxPolicyUtility grants none, so a
utility process launched by a path that passes through one never connects
and its launch never settles. Utility processes decode audio, so a page with
a video that has an audio track would never fire load. mktemp's /var/folders
and /tmp are both links into /private, and a user's own link is no different.

The script links the app's directory from a fresh temporary directory,
launches Sval through the link on a throwaway profile, and asks it to start a
utility process (nsIUtilityProcessTest, which artifact and test builds carry).
It fails when the launch has not settled in LAUNCH_SECONDS, or is rejected.

Usage: scripts/symlink-launch-test.py <path to Sval.app>
"""

import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "network-contact"))
from check import Marionette, free_port  # noqa: E402

# A utility process connects in well under a second on a developer's Mac.
LAUNCH_SECONDS = 30

START_UTILITY = """
let done = arguments[0];
let test = Cc["@mozilla.org/utility-process-test;1"]?.createInstance(
  Ci.nsIUtilityProcessTest
);
if (!test) {
  done(JSON.stringify({ error: "this build has no nsIUtilityProcessTest" }));
} else {
  let timer = setTimeout(
    () => done(JSON.stringify({ error: "the utility process never connected" })),
    %d
  );
  test.startProcess().then(
    pid => {
      clearTimeout(timer);
      test.stopProcess();
      done(JSON.stringify({ pid }));
    },
    e => {
      clearTimeout(timer);
      done(JSON.stringify({ error: "the launch was rejected: " + e }));
    }
  );
}
""" % (LAUNCH_SECONDS * 1000)


def main():
    if len(sys.argv) != 2 or not sys.argv[1].endswith(".app"):
        sys.exit("usage: symlink-launch-test.py <path to Sval.app>")
    if sys.platform != "darwin":
        sys.exit("symlink-launch-test: macOS only")
    app = os.path.realpath(sys.argv[1])
    work = tempfile.mkdtemp(prefix="sval-symlink-launch.")
    proc = None
    try:
        link = os.path.join(work, "link")
        os.symlink(os.path.dirname(app), link)
        with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
            executable = plistlib.load(f)["CFBundleExecutable"]
        binary = os.path.join(link, os.path.basename(app), "Contents", "MacOS", executable)
        profile = os.path.join(work, "profile")
        os.makedirs(profile)
        port = free_port()
        prefs = {
            "marionette.port": port,
            "remote.prefs.recommended": False,
            "browser.sval.firstRun.enabled": False,
        }
        with open(os.path.join(profile, "user.js"), "w") as f:
            for name, value in prefs.items():
                f.write(f"user_pref({json.dumps(name)}, {json.dumps(value)});\n")
        # Everything Gecko keeps beside its profiles stays in the work
        # directory, never in the user's own Application Support.
        env = dict(
            os.environ,
            MOZ_APP_DATA=os.path.join(work, "appdata"),
            MOZ_LOCAL_APP_DATA=os.path.join(work, "localappdata"),
            MOZ_CRASHREPORTER_DISABLE="1",
        )
        log_path = os.path.join(work, "sval.log")
        with open(log_path, "w") as log:
            proc = subprocess.Popen(
                [
                    binary,
                    "--profile",
                    profile,
                    "--new-instance",
                    "--headless",
                    "--marionette",
                    "--remote-allow-system-access",
                ],
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        try:
            m = Marionette(port)
            # Another browser on this machine may own the port, and driving it
            # would test the wrong browser.
            actual = m.js("arguments[0](PathUtils.profileDir)")
            if os.path.realpath(actual) != os.path.realpath(profile):
                result = {"error": f"Marionette answered for {actual}, not {profile}"}
            else:
                result = json.loads(m.js(START_UTILITY, (LAUNCH_SECONDS + 30) * 1000))
            try:
                m.cmd("Marionette:Quit", {"flags": ["eAttemptQuit"]})
            except (ConnectionError, OSError, RuntimeError):
                pass
            try:
                proc.wait(60)
            except subprocess.TimeoutExpired:
                pass
        except (ConnectionError, OSError, RuntimeError, SystemExit, ValueError) as e:
            result = {"error": f"driving sval failed: {e}"}
        if "error" in result:
            with open(log_path) as log:
                sys.stderr.write(log.read()[-4000:])
            sys.exit(f"symlink-launch-test: FAIL: {result['error']}")
        print(f"symlink-launch-test: ok, utility process {result['pid']} started through {link}")
    finally:
        if proc and proc.poll() is None:
            proc.kill()
            proc.wait()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
