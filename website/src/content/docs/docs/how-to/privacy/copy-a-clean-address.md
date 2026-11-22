---
title: Copy a clean address
description: Copy a page's address without the tracking parameters that sites add to links.
since: 0.1.0-rc.11
---

Copy Clean Address copies the page's address without the tracking
parameters that tell a site where you came from, like
`utm_source=newsletter`.

You found a recipe through a newsletter and want to send it to a friend
without the newsletter's tracking code.

## Steps

1. Open the site settings menu at the end of the address bar.
2. Under **Address**, choose **Copy Clean Address**.
3. Paste where you want the link.

For `https://example.com/recipe?id=7&utm_source=newsletter`, Sval copies
`https://example.com/recipe?id=7`.

## Details

- Sval takes out only the parameters named by Mozilla's lists and by the
  filter lists you use for blocking, and every other part of the address
  stays.
- Some parameters are taken out on one site only, like Amazon's.
- When the address has no tracking parameters Sval knows of, Sval copies
  the address as it is.
- When a parameter holds another address, as a redirect link does, Sval
  cleans that address too.
- Sval leaves out a user name or password written in the address.
- The pin next to **Copy Clean Address** puts a Copy Clean Address button
  in the address bar, and the Launcher has Copy clean address too.

## Related pages

- [Address bar site controls](/docs/reference/privacy-site-controls/)
