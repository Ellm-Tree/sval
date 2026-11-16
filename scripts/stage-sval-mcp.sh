#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Build sval-mcp for the tree's target and stage it for packaging. The work is
# scripts/stage-program.py, run through mach for the build's configuration.
#
# Usage: ./scripts/stage-sval-mcp.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/build/firefox"
exec ./mach python "$REPO_ROOT/scripts/stage-program.py" sval-mcp
