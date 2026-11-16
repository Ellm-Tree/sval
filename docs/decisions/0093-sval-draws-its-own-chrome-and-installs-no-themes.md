# 0093. Sval draws its own chrome and installs no themes

**Status:** Accepted on 2026-10-09.

## Context

Sval's header and workspace panel are one surface. A workspace's colour tints
the window and forces dark chrome, and the header's shape (pills, a docked
address bar, glass and shadows) is drawn in CSS. A Firefox theme add-on can
only set colours. Installed, it would either lose to the workspace tint or
paint over it, and it would recolour half a header whose shape it cannot
reach. A built-in Sval theme manifest would add a patch to
`BuiltInThemeConfig.sys.mjs` and duplicate colours the stylesheet already
needs for the tinted and private states.

Firefox's enterprise policy `ExtensionSettings` with `allowed_types` blocks
theme installs, but any policy makes Firefox's settings say the browser is
managed by an organisation.

## Decision

Firefox's default theme stays active and Sval's stylesheet draws every chrome
colour: light, dark, a tinted workspace and a private window. Sval installs no
theme: the add-on manager's install listener cancels one, its add-on listener
puts the default theme back if another is enabled, and the add-ons page shows
no Themes category. No policy is used.

The header's widgets and their order are fixed, and toolbar customisation is
closed, because the stylesheet fuses neighbouring widgets into pills by id.
Pinning an extension's button works.

## Consequences

A person cannot restyle Sval with a Firefox theme, and any theme in an imported
profile stops showing. A theme that supplied the accent for an untinted
workspace only would keep the tint and the header's shape Sval's.
