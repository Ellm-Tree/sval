#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Checks that scripts/check-agent-wire.py still flags what it exists for.

A pattern that stops matching passes every file, so each case builds a small
tree in which the two sides agree, differ, or state a value some other way.

    python3 scripts/check-agent-wire-test.py

scripts/lint.sh runs it.
"""

import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "check-agent-wire.py"
spec = importlib.util.spec_from_file_location("check_agent_wire", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

AGREEING = {
    check.SVAL + "SvalAgents.sys.mjs": "const HELLO = 3;\n",
    check.SVAL + "SvalAgentConst.sys.mjs": (
        'export const AGENT_DIR = "sval-agents";\n'
        'export const PORT_FILE = "port.json";\n'
    ),
    check.SVAL + "SvalAgentWire.sys.mjs": "export const MAX_FRAME_BYTES = 1024 * 1024;\n",
    check.SHIM + "bridge.rs": (
        'const HELLO: u64 = 3;\nconst AGENT_DIR: &str = "sval-agents";\n'
        'const PORT_FILE: &str = "port.json";\n'
    ),
    check.SHIM + "frame.rs": "pub const MAX_FRAME_BYTES: usize = 1024 * 1024;\n",
}


def problems(changes=None):
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        for name, text in {**AGREEING, **(changes or {})}.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        return check.problems(root)


class AgentWire(unittest.TestCase):
    def test_two_sides_that_agree_pass(self):
        self.assertEqual(problems(), [])

    def test_a_version_bumped_on_one_side_is_flagged(self):
        name = check.SHIM + "bridge.rs"
        found = problems({name: AGREEING[name].replace("u64 = 3", "u64 = 4")})
        self.assertEqual(len(found), 1)
        self.assertIn("the handshake's version", found[0])

    def test_a_frame_limit_that_differs_is_flagged(self):
        name = check.SVAL + "SvalAgentWire.sys.mjs"
        found = problems({name: "export const MAX_FRAME_BYTES = 2 * 1024 * 1024;\n"})
        self.assertEqual(len(found), 1)
        self.assertIn("the most bytes in a frame", found[0])

    def test_a_value_stated_another_way_is_flagged(self):
        name = check.SVAL + "SvalAgents.sys.mjs"
        found = problems({name: AGREEING[name].replace("const HELLO = 3;", "let HELLO = 3;")})
        self.assertEqual(len(found), 1)
        self.assertIn("not stated once", found[0])

    def test_the_repository_agrees(self):
        self.assertEqual(check.problems(check.REPO), [])


if __name__ == "__main__":
    unittest.main()
