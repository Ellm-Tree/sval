---
title: Install an extension
description: Add an extension from addons.mozilla.org or from a file.
---

Sval runs the extensions from addons.mozilla.org, Mozilla's extension site.
Ad blockers such as uBlock Origin can inspect and block each request
before it's sent.

You want uBlock Origin's own filter lists on top of Sval's blocking.

## Install from addons.mozilla.org

1. Go to addons.mozilla.org and open the extension's page.
2. Select the page's button for adding the extension.
3. In the prompt that lists what the extension can do, select **Add**.

The extensions menu opens and tells you the extension was added. Select
**OK**. To put the extension's button on the toolbar, select
**Pin to toolbar** instead.

## Install from a file

1. Open Settings › Extensions.
2. Under Installed, select **Install from file…**.
3. Choose the extension's file, then confirm.
4. In the prompt that lists what the extension can do, select **Add**.

## Details

- Sval runs Manifest V2 and Manifest V3 extensions. Both can inspect and
  block each request before it's sent.
- Sval doesn't install themes, or extensions that use containers. To keep
  sign-ins apart, use an isolated Workspace. See
  [Isolate a Workspace](/docs/how-to/workspaces/isolate-a-workspace/).
- An extension that hides tabs sees only the tabs in the Workspace on
  screen. When you install an extension like that, the extensions menu
  warns you and offers **Remove** or **Keep**.
- An extension you install stays on this device. To use the extension on
  your other devices, install it on each one.

## If something goes wrong

- **Sval doesn't support themes.** Sval draws its own colors, so it
  stopped the install.
- **Sval doesn't support** the extension. The extension uses containers,
  so Sval stopped the install. The message suggests an isolated Workspace
  instead. If an extension like this was already installed, Sval turns it
  off and shows the same advice with a **Remove** button.

## Related pages

- [Pin an extension to the toolbar](/docs/how-to/extensions/pin-an-extension-to-the-toolbar/)
- [Remove an extension](/docs/how-to/extensions/remove-an-extension/)
- [Extension settings and controls](/docs/reference/extensions/)
