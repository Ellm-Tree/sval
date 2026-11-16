# 0082. Sval's settings are categories of about:preferences

**Status:** Accepted on 2026-10-08.

## Context

The panel holds tabs and a sync indicator (spec §10.8), so settings need a
home of their own. Two settings places confuse: Firefox's settings in one tab,
Sval's workspace, sync and pairing settings in another.

`preferences.js` registers each category with `register_module`, shows a
category's elements by their `data-category`, and reads the URL's hash in
`init_all` on `DOMContentLoaded`. `document-element-inserted` fires for a
document as its root element is inserted, before the parser reaches any of
its scripts. So Sval can add categories without patching Mozilla's
preferences markup or its pane registry.

## Decision

Sval's settings live in `about:preferences`. Sval adds categories of its
own, and puts its other sections into the Firefox categories that already
hold their topic (spec §10.8 lists the nav). Firefox's categories with nothing
left to show leave the nav. At `browser-before-ui-startup`,
`SvalPreferences.watch()` registers with `SvalChromePages`, Sval's one
`document-element-inserted` observer, which loads Sval's scripts into each
preferences page. The script queues a `DOMContentLoaded` listener ahead of
`init_all`, adds each category's nav button and pane container, and registers
it with `register_module`; the panes' markup is a file Sval owns, fetched into
the containers. No Mozilla file is patched for it. Firefox's own Settings
commands open it, and the panel's sync indicator opens it at the category its
notice is about.

## Consequences

Settings are one place, and Firefox's own search box and nav serve Sval's
categories too. Sval's categories depend on `preferences.js` keeping
`register_module`, `gotoPref` and the `data-category` convention, and on its
`init_all` running at `DOMContentLoaded`; a rebase that changes those breaks
the categories, and Sval's browser tests fail on it. Firefox's own Search pane
and Sval's search engine choice both set the default engine.
