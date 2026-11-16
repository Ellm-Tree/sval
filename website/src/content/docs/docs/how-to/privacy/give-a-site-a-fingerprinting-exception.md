---
title: Give a site a fingerprinting exception
description: Let one site read a single kind of device detail, and keep the rest of its fingerprinting protection.
---

A fingerprinting exception lets one site read one kind of detail, such as
your installed fonts. The rest of the site's protection stays on.

A design tool you use can't find the fonts you installed, and you don't want
to turn off all of the tool's protection.

## Steps

1. Open Settings › Sites.
2. In Your sites, select the site's row.
3. In the Protections card, select the button next to **Fingerprinting exceptions**.
4. Turn on the exception the site needs.

To give an exception to a site that isn't listed, select **Add site** in
step 2, type the site, then select **Add**. The site's page opens.

## Details

- The exceptions are **Canvas**, **Installed fonts**, **All speech voices**,
  **All your languages**, **WebGPU timestamp queries**, and **Standard audio
  hardware**. Each one says what the site can then read.
- An exception takes effect the next time the site loads a page.
- Exceptions sync to your other devices.
- You can't give exceptions while the site's protections are off, or while
  its fingerprinting protection is off. The site can already read every
  value then.
- Private windows can't keep fingerprinting exceptions.

## Related pages

- [Turn off protections for a site](/docs/how-to/privacy/turn-off-protections-for-a-site/)
- [Change fingerprinting protection](/docs/how-to/privacy/change-fingerprinting-protection/)
- [Settings › Sites](/docs/reference/privacy-sites/)
