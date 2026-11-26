# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

## The Launcher: the address bar's rows (launcher spec §5).

# The headings above the address bar's sections, in their default order.
launcher-section-tabs =
    .label = Open tabs
launcher-section-favorites =
    .label = Pins and Favorites
launcher-section-history =
    .label = History
launcher-section-suggestions =
    .label = Search suggestions

# The heading above the tabs the address bar lists while nothing is typed,
# the most recently used first.
launcher-section-recent-tabs =
    .label = Recent tabs

# The heading above the sites the user visits most, which the address bar
# lists under the recent tabs while nothing is typed.
launcher-section-frequent-sites =
    .label = Frequent sites

# An open tab's row as a screen reader names and describes it.
# Variables:
#   $title (String) - the tab's title.
#   $workspace (String) - the workspace the tab is in.
#   $description (String) - the tab's address, then what the row's keys do.
launcher-result-tab-name =
    .aria-label = { $title }, in { $workspace }
    .aria-description = { $description }

## Commands (launcher spec §4). Each `-synonyms` string lists, separated by
## commas, other words a command is found by; they are matched, never shown.

# The heading above the commands the address bar lists.
launcher-section-commands =
    .label = Commands

# A workspace's row: Enter goes to it.
# Variables:
#   $name (String) - the workspace's name.
launcher-command-go-to-workspace = Go to { $name }
launcher-command-go-to-workspace-synonyms = workspace, switch
launcher-command-new-workspace = New Workspace
launcher-command-new-workspace-synonyms = add workspace, create workspace, space
launcher-command-rename-workspace = Rename Workspace
launcher-command-rename-workspace-synonyms = edit workspace, name, colour, color, emoji
launcher-command-move-tab = Move this tab to…
launcher-command-move-tab-synonyms = send tab, workspace
launcher-command-rename-tab = Rename this tab
launcher-command-rename-tab-synonyms = name, title, label
launcher-command-remove-tab-name = Remove this tab’s name
launcher-command-remove-tab-name-synonyms = clear name, reset name, undo rename, page title, use title
launcher-command-pin = Pin this tab
launcher-command-pin-synonyms = keep, stick
launcher-command-pin-here = Pin this tab to this Workspace
launcher-command-pin-here-synonyms = keep, stick, only here, this workspace
launcher-command-unpin = Move this pin to Favorites
launcher-command-unpin-synonyms = unpin, remove pin, favorite
launcher-command-add-favorite = Add to Favorites
launcher-command-add-favorite-synonyms = bookmark, star, favourite, save page
launcher-command-copy-address = Copy address
launcher-command-copy-address-synonyms = url, link, copy link
# Shown in a small confirmation next to the address bar once the address is
# on the clipboard.
launcher-command-copy-address-done = Address copied
launcher-command-copy-clean-address = Copy clean address
launcher-command-copy-clean-address-synonyms = url, link, copy link, clean link, strip, tracking, utm
# Shown in a small confirmation next to the address bar once the address is
# on the clipboard with its tracking parameters taken out.
launcher-command-copy-clean-address-done = Clean address copied
launcher-command-copy-markdown-link = Copy Markdown link
launcher-command-copy-markdown-link-synonyms = md, link, copy link, title
launcher-command-unload-tab = Put this tab to sleep
launcher-command-unload-tab-synonyms = unload, memory, free up, suspend, discard
launcher-command-keep-tab-loaded = Keep this tab awake
launcher-command-keep-tab-loaded-synonyms = keep loaded, never sleep, stay loaded, memory, background
launcher-command-let-tab-unload = Let this tab sleep
launcher-command-let-tab-unload-synonyms = keep awake, keep loaded, sleep, memory, unload
launcher-command-duplicate = Duplicate tab
launcher-command-duplicate-synonyms = copy tab, clone, tab
launcher-command-archive = Archive this tab
launcher-command-archive-synonyms = put away, idle, later
launcher-command-reopen-tab = Reopen closed tab
launcher-command-reopen-tab-synonyms = undo close, restore tab, closed tab
launcher-command-mute = Mute tab
launcher-command-mute-synonyms = sound, audio, silence, quiet
launcher-command-unmute = Unmute tab
launcher-command-unmute-synonyms = sound, audio
launcher-command-reader-view = Reader view
launcher-command-reader-view-synonyms = reading, article, read
launcher-command-split-with = Split with…
launcher-command-split-with-synonyms = tile, side by side, pane, split view
launcher-command-close-split = Close Split
launcher-command-close-split-synonyms = separate, unsplit, end split
launcher-command-swap-panes = Swap panes
launcher-command-swap-panes-synonyms = reverse, flip, split
launcher-command-toggle-panel = Show or hide the Workspace panel
launcher-command-toggle-panel-synonyms = sidebar, panel, workspace panel, tabs
launcher-command-enter-full-screen = Enter full screen
launcher-command-enter-full-screen-synonyms = fullscreen, presentation
launcher-command-exit-full-screen = Exit full screen
launcher-command-exit-full-screen-synonyms = fullscreen, leave, restore
launcher-command-site-privacy = Privacy and Security
launcher-command-site-privacy-synonyms = site, trackers, permissions, shield, protections
launcher-command-site-settings = Site settings
launcher-command-site-settings-synonyms = permissions, camera, microphone, location, notifications, media, autoplay, javascript
launcher-command-style-site = Colorshift this site
launcher-command-style-site-synonyms = colorshift, style, boost, colors, dark mode, font, theme, appearance
launcher-command-clear-site-data = Clear site data
launcher-command-clear-site-data-synonyms = cookies, sign out, forget site
launcher-command-block-javascript = Block JavaScript
launcher-command-allow-javascript = Allow JavaScript
launcher-command-javascript-synonyms = js, scripts, javascript
launcher-command-give-back = Give Workspace back
launcher-command-give-back-synonyms = agent, return control
launcher-command-agent-settings = Agent access settings
launcher-command-agent-settings-synonyms = agents, mcp, pairing
launcher-command-settings-general = General settings
launcher-command-settings-workspaces = Workspaces settings
launcher-command-settings-links = Links settings
launcher-command-settings-sync = Sync and devices settings
launcher-command-settings-appearance = Appearance settings
launcher-command-settings-search = Search and Launcher settings
launcher-command-settings-privacy = Privacy and protection settings
launcher-command-settings-sites = Sites settings
launcher-command-settings-keyboard = Keyboard shortcuts settings
launcher-command-settings-synonyms = preferences, options
launcher-command-downloads = Downloads
launcher-command-downloads-synonyms = files, downloaded
launcher-command-extensions = Extensions
launcher-command-extensions-synonyms = add-ons, addons, plugins
launcher-command-new-peek = New Peek Window
launcher-command-new-peek-synonyms = Peek, throwaway, temporary
launcher-command-private-window = New private window
launcher-command-private-window-synonyms = incognito, private browsing
launcher-command-print = Print
launcher-command-print-synonyms = printer
launcher-command-save-pdf = Save as PDF
launcher-command-save-pdf-synonyms = pdf, export
launcher-command-screenshot = Take a screenshot
launcher-command-screenshot-synonyms = capture, screen shot
launcher-command-translate = Translate page
launcher-command-translate-synonyms = language, translation
launcher-command-refresh = Refresh { -brand-short-name }
launcher-command-refresh-synonyms = reset, clean up
launcher-command-clear-history = Clear history
launcher-command-clear-history-synonyms = delete history, forget, cache, cookies
launcher-command-restart = Restart { -brand-short-name }
launcher-command-restart-synonyms = reboot, relaunch
launcher-command-inspect = Inspect page
launcher-command-inspect-synonyms = devtools, developer tools, inspector
launcher-command-view-source = View page source
launcher-command-view-source-synonyms = source, html
launcher-command-color-picker = Color picker
launcher-command-color-picker-synonyms = colour, eyedropper
launcher-command-history = History
launcher-command-history-synonyms = visited, past pages, archive

## A command that picks (launcher design, "A command that picks").

# The field's placeholder while the workspaces to move a tab to are listed.
launcher-choose-workspace =
    .placeholder = Choose a Workspace
# The field's placeholder while the tabs to split with are listed.
launcher-choose-tab =
    .placeholder = Choose a tab
# The heading above the workspaces a tab can move to.
launcher-section-workspaces =
    .label = Workspaces
# The heading above the tabs a split can take.
launcher-section-tabs-to-split =
    .label = Tabs
# Beside the workspace the tab is in, which cannot be chosen.
launcher-choice-current = Current
launcher-choice-new-workspace = New Workspace…
# Variables:
#   $name (String) - what was typed, the new workspace's name.
launcher-choice-new-workspace-named = New Workspace “{ $name }”…
# The chip's button that goes back to the first list.
launcher-chip-back =
    .aria-label = Back
    .title = Back

## What Enter does on the selected row, beside its key (launcher design,
## "Teaching").

launcher-hint-open = Open
launcher-hint-search = Search
# On a pin, where a page of another site opens in a new tab.
launcher-hint-open-new-tab = Open in new tab
launcher-hint-search-new-tab = Search in new tab
launcher-hint-switch-tab = Switch to tab
# Variables:
#   $workspace (String) - the workspace the tab is in, or the agent whose
#   workspace it is.
launcher-hint-switch-to = Switch to { $workspace }
launcher-hint-pin = Go to pin
launcher-hint-favorite = Go to Favorite
launcher-hint-run = Run
launcher-hint-choose = Choose
launcher-hint-move-here = Move here
launcher-hint-split = Split
launcher-hint-create = Create

## The line under the rows, which follows the selected row: each item is a
## key and what it does there.

launcher-foot-choose = Choose
launcher-foot-open = Open
launcher-foot-new-tab = New tab
launcher-foot-new-peek = New Peek
launcher-foot-new-window = New window
launcher-foot-split = Split
launcher-foot-split-with-tab = Split with this tab
launcher-foot-remove = Remove
launcher-foot-runs-anywhere = Runs it from anywhere
launcher-foot-no-shortcut = No shortcut
launcher-foot-opens-list = Opens a list
launcher-foot-back = Back
launcher-foot-close = Close

# An agent's tab as a screen reader names and describes it.
# Variables:
#   $title (String) - the tab's title.
#   $agent (String) - the agent whose workspace the tab is in.
#   $description (String) - the tab's address, then what the row's keys do.
launcher-result-agent-tab-name =
    .aria-label = { $title }, in { $agent }’s Workspace
    .aria-description = { $description }

## Discoverability (launcher spec §8).

# The placeholder of the address bar and of the home page's field. A key cap
# beside it names the key that opens the Launcher.
launcher-placeholder =
    .placeholder = Search, go to a tab, or run a command

## Settings › Keyboard shortcuts: the Launcher's group (launcher spec §8).

launcher-keys-group = Launcher
launcher-keys-open = Open the Launcher
launcher-keys-new-tab = Open in a new tab
launcher-keys-new-window = Open in a new window
launcher-keys-split = Open next to this tab in a Split

## The first-run tour's one mention of the Launcher.

# Variables:
#   $key (String) - the Launcher's key, as "⌘L" or "Ctrl+L".
launcher-tour-tip = Tip: Press <kbd>{ $key }</kbd> to search, switch tabs, or run a command.

## Settings › Search and Launcher › Launcher sections (launcher spec §5).

launcher-settings-heading = Launcher sections
launcher-settings-note = Choose which sections the Launcher shows, their order, and how many rows each one shows.
# Variables:
#   $section (String) - the section's heading, as "Open tabs".
launcher-settings-rows =
    .aria-label = Rows of { $section }
launcher-settings-none = None
# Variables:
#   $section (String) - the section's heading.
launcher-settings-move-up = Move up
    .aria-label = Move { $section } up
# Variables:
#   $section (String) - the section's heading.
launcher-settings-move-down = Move down
    .aria-label = Move { $section } down
# Beside a section the address bar does not list.
launcher-settings-not-shown = Not shown
# Variables:
#   $section (String) - the section's heading.
launcher-settings-show = Show
    .aria-label = Show { $section }
# Variables:
#   $section (String) - the section's heading.
launcher-settings-hide = Hide
    .aria-label = Hide { $section }
