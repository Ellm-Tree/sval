# Rules for one host or the whole site

**Status:** Approved.
**Date:** 2026-11-04
**Author:** John Postlethwait
**Builds on:** decision 1980, `2026-10-22-site-page-design.md`,
`2026-10-22-element-picker-design.md`, `2026-10-12-protections-design.md`,
`2026-10-31-extension-controls-design.md`, decision 0132 (the site menu).

## 1. What it is

A rule made on `nas.example.com` can cover that host alone or all of
`example.com`. The person chooses where they make the rule, and the host
is where every surface starts. A host rule beats the site's rule for that
host (decision 1980).

## 2. The model

- **A scope is a site or a host.** The site is `siteOf`'s. A host is
  `nsIURI.host` with its trailing dot stripped, as `siteOfHost` reads it.
  A host rule covers the host and every name under it, which is how each
  engine below matches a domain already.
- **No choice is offered where there is nothing to choose:** when the host
  is the site, when it is `www.` and the site (a rule from
  `www.example.com` is a site rule), for an IP address and `localhost`, and
  for a host that is itself a public suffix, such as `github.io`.
- **The most specific rule wins, control by control.** A lookup walks from
  the page's host up through its parent names to the site and takes the
  first rule it finds for that control. The protections rule's fields
  (`protections`, `media`, `exceptions`) are separate controls: a host rule
  holding only `media` leaves the site's `protections` in force.
- **A host rule may equal the default.** It is stored when it differs from
  what the host would get without it. "Allow JavaScript on
  `nas.example.com`" under a site that blocks it is a rule, while the
  same choice under a site with no rule stores nothing.
- **A host inherits what it has not set** from the names above it, up to
  the site. A choice made at the site's scope reaches every host that has
  not set that control, and never replaces a host's own.
- **A host's choices are undone by its Reset** in Settings (§5). No control
  offers to fall back to the site.
- **Two scopes are offered:** the host the page is on, and the site. A host
  rule for a name between them (`home.example.com`) is reached from the
  site page's Add an address.
- **Private windows** keep host rules in memory as they keep site rules.

## 3. Each control

### Hidden elements

- The picker writes `host##selector` for a host and `site##selector` for
  the site, and `$domain=` of the same name on the network line.
- **Show again** on a host, for a line written for its site, offers both:
  showing it everywhere removes the site's line, and showing it here alone
  writes `host#@#selector`.
- `linesForSite`, `sitesInFilters` and the Sites list read a line named by a
  host under that host's site. A line naming a host under a public suffix
  is grouped under the host, which is its own site.

### JavaScript

- One pref per scope: `browser.sval.javascript.site.<site or host>`.
- `_apply` puts each rule in the super list of its choice.
- **Gecko patch:** `PolicyAllowsScript` checks both directions and takes
  the entry of the most specific name, so a host's "allow" beats its site's
  "block" whatever `javascript.enabled` is. The patch is the lookup alone.

### Protections, video and audio

- One pref per scope: `browser.sval.protection.site.<site or host>`.
  `readRules` keeps a name `siteOfEntry` reads as a site or a host.
- **Protections off** writes `trackingprotection` ALLOW on the scope's
  http and https origins, as for a site. **A host's protections on, under
  a site's off,** writes DENY on the host's origins: the permission
  manager takes the most specific origin's entry
  (`PermissionManager::GetPermissionHashKey`), so no Gecko change is
  needed.
- **Video and audio:** `coverOrigin` copies the most specific rule onto the
  exact origin.

### Fingerprinting exceptions

- The overrides' `firstPartyDomain` takes the host.
- **Gecko patch:** `nsRFPService`'s override lookup tries the first party's
  host and its parent names before its base domain.

### Extension switches

- One pref per scope: `browser.sval.extensions.offOn.<site or host>`.
- **Gecko patch:** `SvalTopLevelSite` reads the top-level document's host,
  and `SvalHostInSites` matches it as it matches a host today. The partition
  key holds only the base domain, so it cannot answer for a host.

### Agent site levels and file permissions

- `policy.sites`, `downloads`, `uploads`, `console`, `apps`,
  `pageToolSites` and `pageToolGrants` take a host key as well as a site.
  `levelFor` and `filePermissionFor` walk from the host to the site.
- The agent page's add row shows a scope select once the typed host
  differs from its site, starting at the host. Host rules are listed under
  their site, indented.
- The first-visit prompt names the host the agent opened. Its "Remember
  for" select starts at the host and covers both Allow and Deny.

### Not scoped

- **Cookies and site data**, Clear, Clear everywhere and Forget this site
  (decision 1980).
- **Firefox's permissions**, which are per origin.
- **Link rules and allowed domains**, which are per host already.

## 4. Where the scope is chosen

### The scope dropdown

- **Where a surface has a domain title** (the site menu, the protection
  panel), the title is the dropdown: the current scope's name
  (`nas.example.com` or `All of example.com`) and a 16px chevron.
- **Its options**, host first: the host, sub "Only on nas.example.com",
  and `All of example.com`, sub "Everywhere on example.com". The current
  one is checked.
- **It opens at the host** on every surface, whether or not the host holds
  a choice yet.
- **On a host with nothing to choose** (§2) the title is plain text and the
  surface is as it was.
- **Metrics:** min height 32px, padding 3px 6px 3px 8px, margin-left -8px
  so the text lines up with a plain title, radius 10px. Text 16px/600,
  chevron 16px in the text colour. Closed it has no fill, hovered it takes
  the hover fill, and open it adds an inset 1px muted ring. The title wraps
  at any character, with the chevron after its last line.
- **Its menu:** 290px wide (picker 280px, agent prompt 250px), 6px padding,
  radius 16px, the popup's solid fill and 1px border. Items are at least
  44px tall, radius 10px. The selected item has a 16px check and the hover
  fill. Role `listbox` with `option`s.
- **Keys:** Enter, Space or Down opens it. Up and Down move. Enter picks.
  Esc closes and returns focus. Picking redraws the surface in place, and
  nothing reloads until a control changes.
- **At the site's scope while the host holds choices of its own**, one
  muted 12.5px line under the header names them: "nas.example.com keeps
  its own JavaScript choice." Several are joined in one sentence ("its own
  JavaScript and video and audio choices"). The line is per surface, never
  per row.

### Each surface

- **The site menu.** The dropdown covers Elements, Video and audio, and
  JavaScript, with the sub line "Changes reload the tab". The hidden row
  reads "Removal rules for nas.example.com" or "Removal rules for all of example.com",
  counting the rules saved at that scope ("Removal rules for this site" where there
  is no choice). "Remove from this site…" reads "Remove an element…" on a
  host with a choice, since the picker card picks its own scope. The
  Permissions section ignores the scope, and on such a host one line under
  its label says so: "These permissions are for nas.example.com
  only."
- **The protection panel.** The same dropdown as its title. Its section
  label reads "Choices", and "Protections for this site" reads
  "Protections" on a host with a choice. "Changes reload the tab" stays.
- **The element picker's card.** Its title reads "Remove from
  [nas.example.com ▾]", starting at the host, and is plain on a host
  with no choice. Its options read as the dropdown's do. The button reads
  `Remove from ${scope}` and the toast `Removed from ${scope}`. The scope
  is not remembered between removals.
- **Show again** on a host, for a rule the whole site holds, offers "Show
  on all of example.com", which deletes the rule, and "Show on
  nas.example.com only", which adds `host#@#selector` to My filters.
  Anywhere else it acts at once.
- **The extensions menu.** The dropdown finishes the switch's label: "Run
  on [All of example.com ▾]".
- **The agent prompts** carry "Remember for [host ▾]" (§3).
- **Launcher commands** ("Block JavaScript") act at the host's scope.

## 5. Settings

- **Sites list:** host rows sit under their site's in one list, indented
  22px, each a list item at `aria-level=2`, 44px tall where a site's row is
  52px. The site part of a host's name is muted, at weight 500. A host row
  shows only the host's own choices, and "—" for everything it inherits.
  A row lists each extension switch saved for its own name by the
  extension's name: "Bitwarden off", or "Bitwarden on" for a host that
  turns an extension back on under a site that turns it off. A name whose
  only choice is an extension switch has a row. Each row has its own
  Reset, which clears every choice of that row's own, JavaScript and
  extension switches included, and Undo puts them back. A site's Reset
  leaves its hosts' choices. A site with host
  rules and none of its own reads "Choices only for addresses on example.com" and has no Reset.
- **Site page:** a "Choices for" select under the site's name lists "All
  of example.com · N choices", each host with choices with its count, and
  "Add an address…". It shows when the site has host choices or the address
  carries `&scope=<host>`; otherwise Add an address is in the page's ⋯ menu. At
  a host's scope each control shows what applies, and a value the host
  inherits reads muted, as a default does. One hint beside the select
  reads "Everything else comes from example.com." Protections,
  JavaScript, Hidden elements and Extensions follow the scope. Under them a
  rule and the heading "For all of example.com" lead Permissions, Cookies
  and site data, and Forget this site.
- **Add site** takes an address. A host under a site opens the site's page
  at the host's scope.
- **Forget this site** lists the host rules among the parts it removes.

## 6. Sync

Prefs named by a host sync through the branches that carry site prefs
(`SYNCED_BRANCHES`). Agent policies stay on the device.

## 7. Out of scope

- Per-host cookies, storage and Forget.
- Scopes between the host and the site (`a.b.example.com` choosing
  `b.example.com`). A host rule on `b.example.com` already covers
  `a.b.example.com`, and Add an address on the site page reaches it.
