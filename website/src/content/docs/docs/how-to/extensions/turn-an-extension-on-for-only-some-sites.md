---
title: Turn an extension on for only some sites
description: Keep an extension off on every site, then turn it on for the sites you choose.
since: 0.1.0-rc.11
---

You can keep an extension off on every site and turn the extension on only
where you want it, so it can't read or change anything on the rest.

You use React Developer Tools on the app you're building and want it to
stay away from every other site you visit.

## Steps

1. Open Settings › Extensions.
2. Under Installed, select the extension's name.
3. Turn off **Run on every site**.
4. In **Add a site**, type the site's address.
5. Select **Add**.

Sval reloads the tabs whose pages the extension can now reach, or can no
longer reach.

## Details

- The **Run on** switch in the extensions menu also turns the extension on
  for the site you're on.
- When you turn Run on every site on or off, Sval drops each listed site
  that now matches the switch. A site where you'd turned the extension off
  stays off when you turn the switch off.
- Your choice syncs to your other devices.

## Related pages

- [Turn an extension off on a site](/docs/how-to/extensions/turn-an-extension-off-on-a-site/)
- [Keep an extension to some Workspaces](/docs/how-to/extensions/keep-an-extension-to-some-workspaces/)
- [Extension settings and controls](/docs/reference/extensions/)
