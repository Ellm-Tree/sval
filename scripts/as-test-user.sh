#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Run a command as an unprivileged user, for CI.
#
# A browser is never run as root, and Sval has sync tests that prove the
# difference: they provoke failures by removing file permissions, which root
# ignores, so as root those tests assert nothing. CI's container starts
# as root because that is how Forgejo creates the workspace, so the suites are
# handed down to `node`, an unprivileged user the base Node image carries,
# before they run.
#
# Outside a container this is a no-op, so the same command works on a
# developer's machine.
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  exec "$@"
fi

USER_NAME="${SVAL_TEST_USER:-node}"
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  echo "error: no such user '$USER_NAME' to drop privileges to" >&2
  exit 1
fi

# setpriv rather than su or runuser: neither of those starts a login shell
# without also replacing the environment, and the harness needs DISPLAY and
# DBUS_SESSION_BUS_ADDRESS to survive. --clear-groups drops root's supplementary
# groups, which would otherwise travel into the child.
exec setpriv --reuid "$USER_NAME" --regid "$USER_NAME" --clear-groups \
  env HOME="/home/$USER_NAME" "$@"
