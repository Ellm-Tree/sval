# 1993. My filters apply where Sval's lists do not

**Status:** Accepted on 2026-11-04.

## Context

A site's protections switch and the Off blocking level turn off Sval's
filter lists: ad and tracker blocking, and the page rules that come with
them. Remove from this site saves its rule in My filters, the person's own
rules, which reach pages through the same engine as the lists. So turning a
site's protections off brought back everything the person had removed there,
and the picker was unavailable on that site and while ad blocking was Off.

## Decision

My filters' page rules apply on every site at every blocking level. A
removal is the person's edit to a page, and Sval does not classify it as ad
blocking, even where what it hides is an ad. The protections switch and the
blocking level govern Sval's lists alone.

- Remove from this site is offered wherever the page has a site, outside
  private windows.
- My filters' network rules block as part of ad blocking: they follow the
  blocking level and the site's protections. A removal's "Stop the download
  too" line is one of them.

## Consequences

- The `my-filters` content-classifier feature holds My filters alone and
  serves only page rules. A page whose site has protections off, or that
  loads while the level runs no list, takes its page rules from that feature
  and none from the lists.
- Where the lists apply, My filters' rules reach the page with them, from the
  `ads` feature, so an exception in My filters still excepts a list's rule.
