---
title: Sync another device with this one
description: Give another device the key to your sync folder with a one-time code.
---

Your sync folder is encrypted, so a device that joins needs the key. A
one-time code carries the key to that device through the folder.

You've used Sval on your desktop for a while. You install Sval on your laptop
and want the same Workspaces there.

First, choose the same sync folder on both devices. On the device that
already syncs, see [Choose a sync folder](/docs/how-to/sync/choose-a-sync-folder/).
When you set up a device for the first time, setup asks for the folder
and the code itself. See
[Set up Sval on two computers](/docs/tutorials/set-up-sval-on-two-computers/).

## Show the code on the device that syncs

1. Open Settings › Sync and devices.
2. Under Your devices, select **Sync with another device**.
3. Select **This device shows a code**.
4. Select **Show code**.

The code has three groups of four characters, and it works for an hour.
The page shows how long the code has left. Keep the page open until the other
device has joined.

## Type the code on the other device

1. Open Settings › Sync and devices.
2. Under Your devices, select **Sync with another device**.
3. Select **The other device shows a code**.
4. Select **Next**.
5. In **Type the code it shows**, type the code.
6. Select **Join**.

Sval looks for the code in the sync folder. When the code arrives, the line
under the code reads **Joined. Your devices are syncing.** On the first device,
the page reads **Code used. Your devices are syncing.**

## Details

- The code reaches the other device through your sync folder. With a
  cloud folder, the code can take a few minutes to arrive.
- You can type the code in upper or lower case, with or without its dashes.
- To send the code to yourself, select **Copy**.
- To take the code back before anyone uses it, select **Cancel code**. On
  the other device, select **Stop** to stop looking for the code. Then you
  can type the code again.
- Either device can show the code. The other one types it.
- Anyone with the code and your sync folder can read and change your
  Workspaces. Don't share the code.
- If Sval was installed on this computer before, Sval can find your sync
  key in the folder. After you select **Next**, the page says **Sval found
  your sync key in your sync folder.** and you don't need a code.

## If something goes wrong

- **No code yet. Check that both devices use the same folder.** Sval keeps
  looking. Check that both devices name the same folder on this page, and
  give the cloud service time to sync.
- **That code didn't work.** Check what you typed, or show a new code on the
  other device.
- **That code expired. Show a new one.** Select **Show code** again.
- **Choose a sync folder first.** This device has no sync folder. Select
  **Go to Sync** and choose the folder the other device uses.
- **This device isn't syncing right now, so it can't give another device a
  code.** Show the code on a device that syncs.

## Related pages

- [How sync works](/docs/explanation/sync/)
- [Set up Sval on two computers](/docs/tutorials/set-up-sval-on-two-computers/)
- [Sync settings and controls](/docs/reference/sync/)
