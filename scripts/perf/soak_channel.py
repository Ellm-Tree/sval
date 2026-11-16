# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

"""The soak's client for soak-channel/sval-soak.cfg, which drives Sval
without Marionette, so pages never see navigator.webdriver."""

import itertools
import json
import os
import shutil
import socket
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CHANNEL = os.path.join(HERE, "soak-channel")


class ChannelError(RuntimeError):
    """A script that threw, timed out or had no page to run in."""


def gre_dir(app):
    """Where autoconfig reads from: the install directory, which in a macOS
    bundle is Contents/Resources."""
    if app.endswith(".app"):
        return os.path.join(app, "Contents", "Resources")
    return app


def install(app):
    """Copies the channel into the copy of Sval under test."""
    gre = gre_dir(app)
    os.makedirs(os.path.join(gre, "defaults", "pref"), exist_ok=True)
    shutil.copy(os.path.join(CHANNEL, "autoconfig.js"), os.path.join(gre, "defaults", "pref", "autoconfig.js"))
    for name in ("sval-soak.cfg", "SvalSoakParent.sys.mjs", "SvalSoakChild.sys.mjs"):
        shutil.copy(os.path.join(CHANNEL, name), os.path.join(gre, name))


class Channel:
    def __init__(self, port, token, ready_timeout=120):
        self.token = token
        self.ids = itertools.count(1)
        deadline = time.monotonic() + ready_timeout
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise ConnectionError("the soak channel never came up")
                time.sleep(1)
        self.file = self.sock.makefile("rb")
        # The window may still be opening when the socket is.
        while True:
            try:
                self.js("arguments[0](String(!!gBrowser))", 5000)
                break
            except ChannelError:
                if time.monotonic() > deadline:
                    raise ConnectionError("Sval never opened a window")
                time.sleep(1)

    def _call(self, request, timeout_ms):
        request = dict(request, token=self.token, id=next(self.ids), timeout_ms=timeout_ms)
        self.sock.settimeout(timeout_ms / 1000 + 30)
        self.sock.sendall((json.dumps(request) + "\n").encode())
        while True:
            line = self.file.readline()
            if not line:
                raise ConnectionError("Sval closed the soak channel")
            answer = json.loads(line)
            if answer.get("id") == request["id"]:
                break
        if "error" in answer:
            raise ChannelError(answer["error"])
        return answer.get("value")

    def js(self, source, timeout_ms=30000):
        """Runs `source` in the browser window; arguments[0] answers."""
        return self._call({"script": source}, timeout_ms)

    def content(self, tab, source, timeout_ms=30000):
        """Runs `source` in the page of the tab with browserId `tab`."""
        return self._call({"script": source, "tab": tab}, timeout_ms)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
