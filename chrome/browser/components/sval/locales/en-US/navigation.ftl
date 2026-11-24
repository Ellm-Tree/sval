# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

## The Back button's tooltip on a tab that has no page to go back to, where
## Back closes the tab and shows the tab that opened it.
## Variables:
##   $shortcut (String) - The keyboard shortcut for Back.

sval-navbar-tooltip-back-to-opener =
    .value = Close this tab and go back to the page it came from ({ $shortcut })
