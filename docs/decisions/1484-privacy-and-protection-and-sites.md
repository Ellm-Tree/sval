# 1484. Privacy and protection is one category, and Sites is one of its own

**Status:** Accepted on 2026-10-27.

## Context

Firefox's Settings split privacy between Privacy and security and Site
permissions, and Sval's own protections add a third topic. Site permissions'
rows each open a dialog of exceptions, so what one site may do would sit in
several places beside the site's own page, and Firefox's cookie choice sits
apart from cookies and site data. People ask "what is this site allowed to
do", and the answer has to be in one place.

## Decision

One topic has one category.

- **Privacy and protection** is Firefox's Privacy and security category,
  renamed, and Sval's Protections category is part of it. Firefox's id,
  `privacy`, is the one kept, so every link of Firefox's own lands there.
  Sval's cards sit between Firefox's groups in the order a person reads them:
  blocking, cookies and site data, fingerprinting, privacy signals, HTTPS-Only
  and Secure DNS, breach warnings and browsing protection, passwords and
  security keys, history, then Advanced. Fingerprinting protection's windows
  are a row of the Fingerprinting card, and the cookie choice heads one
  Cookies and site data card built from Firefox's own site data controls.
- **Sites** follows it, a category of Sval's: the defaults every site gets
  (JavaScript, video and audio, each permission's default as Firefox's own
  dialog writes it, pop-ups and pausing notifications), then one list of every
  site with a choice, a stored protection, a JavaScript rule, a permission or
  removed elements. A row says in one line what differs from the defaults
  and opens the site's page, which is the one place a site's choices are
  made, each of its permissions among them, so Firefox's permission
  dialogs are not needed and Site permissions leaves the nav. A row's reset
  takes its JavaScript rule and permissions too, with Undo. Add site asks
  for an address and opens that site's page.
- **Agents** takes the same list and page form: a paired agent's permissions
  are a page of its own, with a breadcrumb back.
- The warning when a website installs an extension, with its exceptions, is
  in Extensions.

Every address of a category this folds in lands where its topic is: Firefox's
Site permissions and Sval's Protections sections through
`LegacyPaneMappings`, and a site page's address through a rewrite before
`gotoPref` reads it, since the map cannot carry the site.

## Consequences

Sval's Privacy and protection depends on Firefox's privacy groups keeping
their ids, which its section anchors name; a rebase that renames one moves a
card, and the category's order test fails on it. A popup or cookie exception
for a site never visited is added from the site's page, reached through Add
site, rather than from a dialog that takes an address.
