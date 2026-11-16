---
title: Set up sync again with a new key
description: Replace your sync key, so a lost device can no longer read your sync folder.
---

When you set up sync again, Sval makes a new sync key and publishes this
device's Workspaces under the new key. Sval removes the old files from your
sync folder, so the old key can't read them anymore.

Your laptop was stolen, and Sval on the laptop was syncing. You want to
shut the laptop out of your sync folder.

## Steps

1. On a device that still syncs, open Settings › Sync and devices.
2. Open **Advanced**.
3. Under Sync key, select **Set up sync again**.
4. In the dialog, select **Set up sync again**.

Under Sync key, Sval shows "Sync is set up on this device. Give your other
devices a code to sync with it." Sval then offers to back up the new key.

## Give your other devices the new key

Your other devices stop syncing until you give each one a code. On each of
those devices, the sync indicator at the bottom of the Workspace panel reads
Sync is off.

1. On this device, select **Show Code…**.
2. Select **Show code**.
3. On the other device, open Settings › Sync and devices.
4. Under Sync, select **Reconnect…**.
5. Type the code, then select **Join**.

See [Sync another device with this one](/docs/how-to/sync/sync-another-device/)
for the code's details.

## Details

- A backup of the old key no longer opens your sync folder. Save a backup of
  the new one. See [Back up your sync key](/docs/how-to/sync/back-up-your-sync-key/).
- You'll see **Set up sync again** only on a device that syncs. If none of
  your devices still syncs, restore your key from your backup. See
  [Back up your sync key](/docs/how-to/sync/back-up-your-sync-key/).

## Related pages

- [How sync works](/docs/explanation/sync/)
- [Sync settings and controls](/docs/reference/sync/)
