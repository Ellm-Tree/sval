---
title: Privacy and protection
description: What each setting in Settings › Privacy and protection does, from ad and tracker blocking to Secure DNS.
---

Settings › Privacy and protection holds the settings that apply to every
site. You make choices for a single site with the controls in the address
bar. Settings › Sites lists those choices.

- [Address bar site controls](/docs/reference/privacy-site-controls/)
  covers the Privacy and Security button and the site settings menu.
- [Settings › Sites](/docs/reference/privacy-sites/) covers the defaults
  for every site and each site's own page.

## Ad and tracker blocking

Sval blocks ads and trackers with filter lists. Your changes apply the next
time a page loads.

- **Level.** The level decides which lists Sval uses.
  - **No Blocking.** Sval blocks nothing.
  - **Balanced Blocking.** Sval blocks ads and trackers with lists that
    rarely break sites. A new install starts on this level.
  - **Strict Blocking.** Sval adds lists that block more, including
    trackers in links, social widgets, and scam sites. Some sites might break.
    Sval also strips tracking parameters from the addresses you open.
  - **Custom.** You can switch on any of the lists Sval knows, and add
    your own lists by address. Custom starts from the lists of the level you were on.
- **Lists.** You see the lists in use, grouped by what they block: Ads,
  Trackers, Annoyances, Scams and malware, Site fixes, and Other. Each list
  names its license or its address. Under Custom, each list has a switch.
- **Add list.** This adds a list by its address. When you add a list, the level
  switches to Custom.
- **Customize lists.** The level switches to Custom, starting from the
  lists of the level you were on.
- **Trust this list.** This shows on a list you added. After you confirm,
  the list can run trusted scriptlets.
- **Allow on this device.** This shows on a list you added on another
  device. The list downloads on this device only once you allow it.
- **Allowed domains.** This lists the domains Sval never blocks, at any
  level. **Add domain** adds a domain.

The level, the lists, and the allowed domains sync to your other devices.

### Hidden trackers

Some sites load a tracker from an address on their own domain, with a DNS
record called a CNAME that points the address to the tracker's servers.
Hiding a tracker this way is called CNAME cloaking. Blocking lists match a
request by its address, so they miss a cloaked tracker.

At every level but No Blocking, Sval looks up the DNS record of each request
that your lists didn't already block. Sval skips the page itself and requests
to the page's own address. If the address points to another site, Sval
checks that site against your lists before it connects. This check is
called CNAME uncloaking. Sval needs that lookup to connect anyway, so the
check contacts no extra servers. When you use a proxy, Sval skips this
check.

### Advanced

- **My filters.** This field holds your own rules, one per line, in
  uBlock Origin's syntax. **Save** saves your rules. Your rules sync to your other
  devices.
- **Let My filters use trusted scriptlets.** After you confirm, your own
  rules can run trusted scriptlets. This covers your rules as they were
  when you trusted them on this device.
- **Hide page elements and apply site fixes from the lists.** This is on by
  default.
- **Use trusted scriptlets from uBlock Origin's lists and the lists you
  trust.** This is on by default.

## Cookies and site data

- **Cookies.** This sets which cookies sites can set. The choices are
  **Allow every cookie**, **Keep each site's cookies to that site**,
  **Block cookies from trackers**, and **Block cookies from sites you
  haven't visited**. You can also choose **Block cookies from other sites**
  or **Block every cookie**. It starts on Keep
  each site's cookies to that site.
- The size line says how much space site data and the cache take up.
- **Clear browsing data**, **Clear data for specific sites**, and **Manage
  exceptions** each open Firefox's own dialog for that task.
- **Clear cookies and site data every time you close Sval.** Sval clears
  cookies and site data each time you quit.

## Fingerprinting

These settings control what sites can learn about your browser and device.
Sval's defaults make you look like other Sval users and rarely break sites.
Your changes apply the next time a page loads.

- **Fingerprinting protection.** This applies protection **In every
  window**, **Only in private windows**, or **Off**. It starts on In every window.
- **Strict fingerprinting protection.** This switch turns on every strict
  item, which protects you more and breaks more sites. The switch is off at
  first. The
  line under it says how many strict items are on.
- **Restore Sval's defaults.** Every fingerprinting setting goes back to
  its default. The message that follows has **Undo**.
- Under Language and region, **Tell sites all your languages** is off, so
  sites see only your first language.
- Under Hardware and devices, **Report the real CPU core count** is off, so
  each site sees a count of its own, between half your cores and all of
  them.
- Under Network, **WebRTC (calls in the browser)** offers **Allow calls**,
  **Only through your proxy**, and **Block**. Allow calls is the
  default. With Allow calls, sites don't see your local network address.

### Advanced

Advanced lists each protection by group. The groups are:

- Graphics
- Fonts and text
- Appearance
- Screen and window
- Audio, video, and media
- Language and region
- Hardware and devices
- Timing
- Network
- Compatibility

Each group shows
how many of its protections are on. Each protection says what it hides and
what it can break. A protection is marked when it differs from
Sval's default.

Under Compatibility, **Mozilla's compatibility fixes** is off by default.
When you turn it on, Sval weakens protection on Google's and Bing's sites,
following a list Mozilla publishes.

## Privacy signals

- **Global Privacy Control.** Sval tells sites not to sell or share your
  data. In some places, the law requires sites to honor this signal. It's
  on by default.
- Under Advanced, **Do Not Track** asks sites not to track you. Nothing
  requires sites to honor this signal. It's off by default.

## HTTPS-Only Mode

This is Firefox's own setting. HTTPS-Only Mode allows only secure
connections to websites, and asks you before connecting insecurely. The
choices are **Enable HTTPS-Only Mode in all windows**, **Enable HTTPS-Only
Mode in private windows only**, and **Don't enable HTTPS-Only Mode**. The
last one is the default. **Manage Exceptions…** lists the sites you let load
insecurely.

## Secure DNS

This setting controls how Sval looks up the sites you visit. It applies to
every site and syncs to your other devices.

- **Your network's DNS.** This is the default. It works with internal
  names, VPNs, and router filters. Your network can see the sites you look
  up.
- **Encrypted, with fallback.** Sval looks sites up through the resolver.
  When that fails, Sval uses your network's DNS.
- **Encrypted only.** Sval looks sites up only through the resolver. If
  Sval can't reach the resolver, sites don't load.
- **Choose provider:** This menu shows with the two encrypted choices. It
  offers Quad9, the default, Cloudflare, and **Custom**, which takes
  another resolver's address.
- **Internal names.** This lists domains that always use your network's
  DNS.

## Data breach warnings

**Warn about sites with a data breach in the last year** is on by default.
Sval checks sites against Have I Been Pwned's list of breaches, downloaded
from Mozilla. When this is off, Sval doesn't download the list.

## Deceptive content and dangerous software protection

This is Firefox's own setting. **Block dangerous and deceptive content** is
on by default. Under it are **Block dangerous downloads** and **Warn you
about unwanted and uncommon software**.

## Password manager and Security keys

See [Passwords](/docs/reference/passwords/).

## History

This is Firefox's own setting. The choices are **Remember history**,
**Customize history**, and **Never remember history**.

## Advanced

- Under More tracking protection:
  - **Strip tracking parameters from the addresses you open** is on with
    Strict Blocking. At other levels, it's off.
  - **Block redirect tracking** is off by default.
  - **Never send a page's full address to the next site you go to** is off
    by default.
- Under Bookmarklets, **Run bookmarklets from Favorites** is on by default.
- **Certificates** and **Proxy settings** are Firefox's own settings.
