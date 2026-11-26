---
title: How sync works
description: Sval syncs through a folder you choose, encrypted with a key only your devices have, and a one-time code brings that key to a new device.
---

Sval syncs without an account. It syncs through any folder you choose. That
can be a cloud folder like iCloud Drive, Dropbox, or OneDrive, a network
drive, or a USB drive. Sval doesn't run a sync service.

## The folder

Each of your devices writes its changes to the folder. Each device also
reads the other devices' changes from the folder. Whatever carries the
folder between your devices carries your Workspaces too. That's your cloud
service, your network, or you carrying the drive.

Sval keeps its files in a folder called "sval" inside the folder you
choose. Sval doesn't touch anything else in your folder.

Every device keeps its own full copy of your Workspaces. The folder is
where the copies meet. So Sval works the same when the folder is out of
reach, and catches up once the folder is back. When you stop syncing on a device,
the device keeps everything it has.

A cloud folder can take a few minutes to carry a change from one device to
the other. Sval can only sync as fast as the folder does.

## The encryption

Everything Sval writes to the folder is encrypted with your sync key. If
your cloud provider or anyone else opens the folder, they see files they
can't read.

The first device you sync makes the key. Each device keeps the key, or what
unlocks it, in the system's own store for secrets. That store is the
Keychain on a Mac, Windows Credential Manager on Windows, and your keyring
on Linux. A computer with no keyring keeps the key in your Sval profile.

Nobody can recover the key for you, Sval included. While one of your devices
still syncs, that device holds the key and can give it to the others. A
backup matters when every device is gone at once. Then you set up Sval on a
new device, choose your sync folder, and paste the backup in place of a
code.
See [Back up your sync key](/docs/how-to/sync/back-up-your-sync-key/).

## Adding a device

A new device can reach your folder, but it can't read the folder without
the key. Adding a device is how the new device gets the key.

One device shows a one-time code. Sval puts the key in the folder, locked
with that code. You type the code on the other device. Sval on that device
unlocks the key and starts syncing. The locked key then leaves the folder.

That's why both devices need the same folder before you start. It's also
why the code can take a few minutes to reach the other device. The code
travels through your folder, the way your Workspaces do.

The code works for an hour. Anyone with both the code and your folder
could read your Workspaces, so keep the code to yourself.

## What syncs

Sval syncs your Workspaces with their tabs and groups, along with your
Favorites, history, and settings, which include your choices for each site
and your blocking setup. New history goes to your sync folder at most once
every 10 minutes, so it reaches your other devices later than your tabs do.
History you delete leaves your sync folder at the next sync.

Sval keeps a tab where you're using it when another device would take it
from you:

- A tab in a call stays off your other devices while it uses your camera,
  microphone, or screen. That way another device can't end the call, and
  the tab syncs again once the call ends.
- When you close a tab on one device while another device shows it, the
  other device keeps the tab open. The tab then comes back on the device
  where you closed it. The same goes for a tab with a video in
  picture-in-picture.

Some things stay on each device:

- Your sign-ins and cookies. You sign in to sites once on each device.
- Which folder the device syncs through, and the device's name.
- Your password manager's extension, which each device installs.
- Whether AI assistants can use Sval on that device.
- Which side of the window the Workspace panel is on.
- Tabs in private windows, which are never saved or synced.

## Shutting out a device

A device that has your key can read your folder for as long as the key
stays the same. To shut a lost device out, set up sync again with a new
key. Each of your other devices then needs a new code, and the old key
can't read anything. See [Set up sync again with a new key](/docs/how-to/sync/set-up-sync-again/).

## Related pages

- [Set up Sval on two computers](/docs/tutorials/set-up-sval-on-two-computers/)
- [Choose a sync folder](/docs/how-to/sync/choose-a-sync-folder/)
- [Sync another device with this one](/docs/how-to/sync/sync-another-device/)
- [Sync settings and controls](/docs/reference/sync/)
