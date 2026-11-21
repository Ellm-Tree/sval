# 2499. Keep links in this tab is a site rule

**Status:** Accepted on 2026-11-20.

## Context

Some sites open their own pages in new tabs: a listing on eBay or a product on
Amazon opens with `target=_blank`, and a session of browsing leaves a row of
tabs to close. Firefox has one switch for it, `browser.link.open_newwindow`,
which sends every site's new-tab links to the current tab. That breaks the
sites that open a second tab on purpose, such as a docs page beside the app it
documents.

## Decision

- **Keep links in this tab is a choice for a site**, with no default for all
  sites. It is off until the user turns it on, in the site menu or on the
  site's page in Settings. A host can hold a rule of its own (decision 1980).
- **It covers links between the site's pages.** A request for a new tab loads
  in the tab it came from when the tab's top document asked and the address
  is of the site whose rule is on. A link to another site keeps its tab. So
  does a frame's link, since loading it in the tab would navigate the top
  from a frame, which a sandboxed frame may be barred from.
- **The user's own request opens where they asked.** A link opened with a
  modifier key, or from the context menu, opens as it would without the rule.
- **A script keeps only a window it lets go of.** `window.open` with
  `noopener` is kept. Without it the page holds the new window, and a page
  that writes into the window it opened would write over itself. A request
  with window features, as sign-in and payment popups make, opens its window.
- **The rule syncs, and the iPhone app keeps it.** WebKit does not say whether
  a script kept its window, so the app keeps links and forms alone.
- **The line under the switch says what it does:** "Links between
  amazon.com pages can't open a new tab or window." It names the site, and
  says nothing of what the rule leaves alone.

## Consequences

- Gecko decides in the content process, where it decides the current-tab path
  of `browser.link.open_newwindow` (`BrowserChild::ProvideWindow`). Prefs
  named for a site never reach a web content process, so Sval's chrome puts
  the site whose rule is on into a field of the tab's top browsing context as
  each page loads (`sval-keep-links.patch`). The patch moves the Gecko key.
- A host rule keeps every link from that host to any page of its site, since
  the decision compares sites.
