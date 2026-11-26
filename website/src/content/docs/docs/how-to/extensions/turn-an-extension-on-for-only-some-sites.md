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
3. In the menu at the top of the Sites card, choose **Only these sites**.
4. Type the site's address in the field under the list.
5. Select **Add**.

Sval reloads the tabs whose pages the extension can now reach, or can no
longer reach.

## Details

- The **Run on** switch in the extensions menu also turns the extension on
  for the site you're on.
- Choosing **Only these sites** empties a list of sites the extension was
  off on, since the extension is now off on them anyway. Choosing **Every
  site** empties the list too.
- Your choice syncs to your other devices.

## Related pages

- [Turn an extension off on a site](/docs/how-to/extensions/turn-an-extension-off-on-a-site/)
- [Keep an extension to some Workspaces](/docs/how-to/extensions/keep-an-extension-to-some-workspaces/)
- [Extension settings and controls](/docs/reference/extensions/)
