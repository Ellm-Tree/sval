# 0049. Sval owns the tabs

**Status:** Accepted on 2026-10-07.

## Context

Sval's panel is the place tabs live. Firefox's tab strip, tab groups and the ML
suggester behind them would be a second, competing picture.

## Decision

Firefox's tab strip does not render, its tab grouping and suggester are off,
and Sval's panel is the only place a tab appears. `gBrowser` remains as the
content layer: it owns the `<browser>` elements, processes, navigation and
history, and its `<tab>` elements are its records. The strip is hidden per
window, through the window's own `setToolbarVisibility`, kept in `xulStore`, and
a patch to `TabBarVisibility.update`, which assigns `TabsToolbar.collapsed` on
every tab open and close, keeps it collapsed in a window Sval marks. The window keeps its close, minimise and zoom buttons through
the attributes Firefox sets when vertical tabs hide the strip. Firefox's tab
internals, the private members of `tabbrowser.js` and session store, are
reached through one module, `SvalFirefox.sys.mjs`. Their public interface,
such as `gBrowser`'s methods and the tab events on `tabContainer`, is used
where it is needed.

## Consequences

A node drawn nowhere is a tab nothing tells the user exists, so every
unreachable shape a merge can produce is drawn in the workspace and can be
rescued in one move.
