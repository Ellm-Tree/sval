#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# The channel a release version is published on: X.Y.Z is a release, and
# X.Y.Z-rc.N, a candidate for it, is a beta. A beta goes to the beta update
# feed and repositories alone; a release to the release ones and the beta
# ones, so a user who takes release candidates reaches each release too.
# Every build is on the release update channel; the Release candidates
# setting (browser.sval.update.releaseCandidates) has it read the beta feed.
#
# Any other version is refused. The version is the one Sval displays, and
# Mozilla's code reads a channel into its letters: the webcompat add-on's
# getEffectiveUpdateChannel takes any "a" for Nightly and any "b" for Beta.
#
# Usage: ./scripts/release-channel.sh VERSION
set -euo pipefail

if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo release
elif [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]]; then
  echo beta
else
  echo "error: $1 is not a release version, X.Y.Z or X.Y.Z-rc.N" >&2
  exit 1
fi
