#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Make the marks an agent's Workspace wears for its app or model
# (SvalAgentBrands.sys.mjs), from LobeHub's monochrome icons:
#
#   npm pack @lobehub/icons-static-svg   # in an empty scratch directory
#   tar xzf lobehub-icons-static-svg-*.tgz
#   python3 -I scripts/generate-agent-brands.py <that directory>/package/icons
#
# Each icon keeps its drawing and viewBox. Its fill becomes the chrome's
# context fill, as agent-robot.svg's is, so one file serves as a menu item's
# image and as a CSS mask, in the theme's colour.

import re
import sys
from pathlib import Path

OUT = (
    Path(__file__).resolve().parent.parent
    / "chrome/browser/components/sval/agent-brands"
)

# SvalAgentBrands.BRAND_SLUGS, each the name of its LobeHub icon.
SLUGS = [
    "amp",
    "claude",
    "claudecode",
    "cline",
    "codex",
    "cohere",
    "cursor",
    "deepseek",
    "gemini",
    "geminicli",
    "gemma",
    "githubcopilot",
    "goose",
    "grok",
    "grokbot",
    "kimi",
    "lmstudio",
    "meta",
    "microsoft",
    "minimax",
    "mistral",
    "muse",
    "nvidia",
    "ollama",
    "openai",
    "opencode",
    "perplexity",
    "qwen",
    "windsurf",
    "zhipu",
]


def normalise(svg: str) -> str:
    svg = re.sub(r"<title>.*?</title>", "", svg, flags=re.S)
    svg = re.sub(r'\s(?:fill|height|width|style)="[^"]*"', "", svg, count=0)
    svg = svg.replace(
        "<svg ",
        '<svg fill="context-fill black" fill-opacity="context-fill-opacity" ',
        1,
    )
    return svg.strip() + "\n"


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <lobehub icons directory>", file=sys.stderr)
        return 1
    src = Path(sys.argv[1])
    OUT.mkdir(exist_ok=True)
    for slug in SLUGS:
        text = (src / f"{slug}.svg").read_text(encoding="utf-8")
        if len(re.findall(r'\sfill="', text)) != 1:
            # A fill of a path's own would be lost to the context fill.
            print(f"{slug}: a fill besides the icon's own", file=sys.stderr)
            return 1
        (OUT / f"{slug}.svg").write_text(normalise(text), encoding="utf-8")
    print(f"wrote {len(SLUGS)} marks to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
