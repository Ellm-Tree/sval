# Where Sval keeps its keys

Date: 2026-10-08. Status: built. Decisions 0083, 0084 and 0089.

- **One sync key per device, in one store.** Sval never keeps several copies, so
  it never has to pick a winner.
- **A store that is locked or unavailable stops only syncing.** Sval starts,
  shows this device's workspaces, and says in the panel that it cannot reach the
  shared workspaces and why.
- **Holding a key never decides whether the user has workspaces.** A device
  syncs because the user set it up to.
- **Joining is one plain choice.** First run asks "I'm new to Sval" or "I use
  Sval on another device". After first run the same thing is one action: "Sync
  with another device". A user who ignores it uses Sval local-only and is never
  asked again.
- **A printed or typed key is only a backup.** The user recovers with it, and
  Sval never runs from it.
- **Sval encourages a backup.** Losing the sync key everywhere makes the synced
  workspaces unreadable to anyone, Sval included.
- **The local copy needs no secret.** It lives in the profile, beside Firefox's
  own history and session files, which are not encrypted either.

## Two keys

One key encrypts this device's file in the profile. Another encrypts and names
the directory in the shared folder. Splitting the two jobs is what lets a locked
or missing sync key stop only syncing.

| | Local key | Sync key |
|---|---|---|
| Encrypts | This device's file in the profile | Every file in the shared folder |
| Kept in | `sval-local-key` in the profile, raw bytes | The profile, encrypted under a system-store secret |
| Created | On first launch | Only when the user sets up sharing on a device that is not joining |
| Leaves the device | Never | Through pairing, or the user's own backup |
| Can be locked | No | Yes, and then only syncing stops |

The engine takes a key on every call (host contract §4), so the browser passes
the local key to the profile pass and the sync key to the shared pass. The file
format is the same in both places, which keeps the contract iOS and Android
inherit.

The local key protects nothing. It exists only because the
file format is encrypted. Anyone who can read the profile can already read the
open tabs from Firefox's session files.

## Where the sync key is kept

The sync key lives in the system store: Keychain on macOS, Credential Manager
on Windows, Secret Service on Linux. It is the only store. Firefox's login store
is never offered: Sval turns Firefox's password manager off (decision 0078),
and the store that remains is for nothing Sval keeps. A password manager cannot
be one, because no desktop operating system lets a browser write to one (spec
§7.2).

Gecko's `nsIOSKeyStore` generates and holds its own secret under a label, and
encrypts given bytes with it (`asyncGenerateSecret`, `asyncEncryptBytes`). It
cannot store 32 bytes that Sval chose. So Sval keeps the sync key in the profile,
encrypted under an `nsIOSKeyStore` secret. The system store holds what unlocks
it, and that secret never leaves the device.

`sval-identity.json` records a non-secret fingerprint of the sync key.

**The Kagi session token is kept the same way,** wrapped under its own
label. Sval keeps nothing in Firefox's login store. One module,
`SvalSecretStore`, wraps, unwraps and removes a secret by name, with the label
scheme and the Linux fallback below, and both `SvalIdentity` and `SvalKagi` call
it.

**The label is per user of the machine, never per profile.** Keychain,
Credential Manager and Secret Service entries outlive an uninstall and a
deleted profile, which is what lets Sval installed again find its key (below).
Every profile of the user shares the one system secret, so Sval never removes
it.

### What each system store does to Sval

- **macOS.** `KeychainSecret` uses `SecItemAdd` and `SecItemCopyMatching` without
  `kSecUseDataProtectionKeychain`, so the secret lands in the login keychain,
  whose access list names the app by its code signature. A build signed by
  Sval's team reads it silently. A build signed differently, which includes every
  dev build, gets the system's "sval wants to use your confidential information"
  prompt, or a refusal. A refusal is the unreadable state below. The item is
  not synchronizable, so iCloud Keychain never carries it to another Mac.
- **Windows.** Credential Manager protects the secret with DPAPI, which is tied
  to the user's Windows password. An administrator resetting that password, or
  moving to a new PC, loses the secret. The device then reports a missing key,
  and the message says to enter a code from another device again.
- **Linux.** `OSKeyStore` loads libsecret when it can and falls back to
  `NSSKeyStore` when it cannot, which keeps the secret in the profile's
  `key4.db`, protected by nothing once the Primary Password is gone. libsecret
  can also load with no Secret Service running (tiling window managers, some
  KDE setups, headless machines), and then every read fails.
  **Sval keeps the secrets in the profile on such a machine** and says so in
  one line under storage in Settings: "This system has no keyring, so your sync
  key is kept in your Sval profile." The threat model already trusts the device
  (§6.5); the key's job is to keep the provider out. Sval decides when the first
  secret is written: libsecret that will not load, or a system store whose
  first call fails, means the profile, and the choice is recorded so a keyring
  that appears later does not hide the key already kept.

## Starting up

1. Read the local key from the profile. Create it if the profile has none. A
   local key that exists but cannot be read stops startup with a message. That
   is a damaged profile, and minting a replacement would hide this device's
   workspaces.
2. Open this device's workspaces from the profile. This never waits on a store.
3. If the device syncs, read the sync key from its store, before the first
   pass. A device with a shared folder waits for that folder before it makes a
   first workspace, and it can only wait for a folder it holds the key to.
   - **Read, fingerprint matches:** shared passes run.
   - **Unreadable** (a macOS Keychain locked by hand, or the store refusing): no shared pass runs. The panel's
     status line says "Not syncing" and why, with Try again. Try again reads the
     store again, which lets the OS show its own unlock prompt. Syncing starts
     without a restart.
   - **Missing, or a different key:** the status line says this device no
     longer has the sync key and needs a code from another device again. It
     offers "Sync with another device". Sval never mints a replacement on its
     own. This is what a new computer restored from a backup, a reset Windows
     password, or a different signing identity on macOS look like.

Only syncing stops, so the user keeps their own workspaces while fixing it.

## Becoming a syncing device

Both paths begin from a device that already has its local workspaces.

**Setting up sharing for the first time.** This is first run's new-user path
with "In a folder your devices share", or the same choice later in Settings.
Before minting a sync key, Sval lists the chosen folder's `sval/ws/`. If it holds
another key's directories, Sval says the folder already has Sval workspaces and
offers to sync with them. It never writes a second key's workspaces beside
another's without asking. Otherwise Sval mints the sync key, saves it to the
system store, reads it back, then offers the backup (below). The first shared
pass publishes this device's tree.

**A second key can arrive later.** Two devices set up as new against the same
folder, before either's files have reached the other, both find it empty and
both mint a key. Providers take up to 30 minutes to deliver (§6.4), so this is
an ordinary afternoon. Every shared pass therefore lists `sval/ws/`, and a
directory that is neither this key's nor a directory this device has already
been told about raises one line in the panel: "This folder also has Sval
workspaces from another device." Its action is "Sync with existing Sval
workspaces". The line stays until the user acts on it or dismisses it, and a
dismissed directory is remembered so it is not raised again.

**"Sync with another device".** First run's joining path is the same
flow under a different name. It asks for the folder and then the code, as
pairing does (decisions 0042 to 0045). The received key is saved and read
back. The shared pass then merges this
device's local workspaces into the shared ones. The local copy is not
re-encrypted, because it keeps its own key.

**An untouched first workspace is not merged.** A device that joins has usually
made its unnamed first workspace already: first run's join hold lives in
memory, and quitting, Skip setup or a closed window ends it. Before its first
shared publish, a joining device removes a workspace that is unnamed, has never
been renamed, and holds nothing but the new tab it was made with. Anything the
user touched merges like every other workspace.

The action sits in Settings, under storage, and in the panel footer's menu while
the device is local-only.

## Starting over with a new sync key

Every device keeps the whole merged tree in its own profile, under its local
key. So losing the sync key loses nothing while any device survives, and a new
sync key is how that device carries on. The same act is the only way to shut out
a lost or stolen device, whose copy of the old key reads the folder for as long
as it exists.

"Start over with a new sync key" sits in Settings, under storage, and is the
action the panel offers beside "Sync with another device" when the key
is missing. It:

1. Says what happens: every other device stops syncing until it is paired
   again, and the old files in the folder stay readable to anyone who still
   holds the old key until they are removed.
2. Mints a new sync key, saves it and reads it back.
3. Publishes this device's tree under the new key.
4. Removes the old key's directory from the folder, once the publish has
   landed. Sval removes only the directory named by the key it just replaced,
   and only from this device. A missing old key leaves the old directory in
   place, because Sval cannot name it; Settings then lists it as "Old Sval files
   this device cannot read", with Remove.
5. Offers the backup, as for a first key.

Other devices see their key stop matching anything that is written and fall
into the missing-key state on their next pass, which offers pairing.

## Backup and recovery

The backup matters when every device is gone at once: the only computer is
lost, or all of them are. While any device survives, starting over (above) is
the recovery.

When Sval mints a sync key, it offers "Save a backup of your sync key". The user
can save a file or print a sheet. Either one holds the key as 52 characters of
the pairing alphabet in groups of four, the same key as a QR code for a phone, a
fingerprint, and one paragraph saying what it unlocks and that nobody can
recover it for them.

**The backup must not sit beside what it unlocks.** The save dialog opens in the
user's Documents folder. Downloads commonly syncs to the same provider. A destination inside the shared folder is refused with one line
saying why. A destination under a known provider root (`~/Library/CloudStorage`,
`~/Library/Mobile Documents`, `%OneDrive%`, `~/Dropbox`) gets the same line as a
warning the user can pass. The sheet says the
same: keep it somewhere other than the cloud account that holds the folder. The step can be
skipped. Until a backup has been saved, Settings shows "No backup saved" under
storage, with the same action. Sval does not nag beyond that line.

**Recovery** is "Sync with another device" with "Use a backup" in place
of the code. The typed key is checked against the folder: a key that names no
directory in it is reported as not matching this folder. A key that does match
is saved like a paired one.

A printed or saved backup is never read at startup. Sval does not track where it
went.

## Installing again

A user who uninstalls Sval, or loses the profile, and installs it again on the
same machine must get their workspaces back from the folder alone, inside
first run, with no other device and no backup.

- **Each device leaves a sealed copy of the sync key in the shared folder**,
  at `sval/keys/<device id>.key`, sealed under this user's system secret. The
  provider cannot open it: the secret never leaves the machine.
- **Choosing a folder that already holds Sval workspaces looks there first.**
  A copy this user's secret opens, whose key names the workspaces in the
  folder, is the user's key. First run's join step, its new-user path, and
  Settings' "Sync with another device" all join with it and ask for
  nothing.
- A copy that does not open is another user's or another machine's, and Sval
  carries on as before: a code, or the backup.
- The lookup goes by the folder, never by a profile path, so it survives Sval's
  profile directory moving.

Two more layers cover a new machine and a wiped store (decision 0084):

- **iCloud Keychain, on macOS and iOS.** The sync key is also a synchronizable
  password item in the data-protection keychain, under an access group the Mac
  and iOS apps share, reached through js-ctypes calls into Security.framework.
  A new Mac or an iPhone signed in to the same Apple account finds it. Gecko's
  `KeychainSecret` keeps its own, unsynchronized items
  (`SvalICloudKeychain`). Signed release builds only: it needs the
  `keychain-access-groups` entitlement in a Developer ID provisioning profile,
  and `browser.sval.keychainAccessGroup` stays empty until signing sets it. An
  empty group or a refused call is "not available", and Sval goes on with the
  per-user system secret and the sealed copy in the folder.
- **The user's password manager, everywhere** (decision 0089). The backup
  sheet tells the user to scan its QR code with a phone, or press Copy, and
  save the code as a secure note in their manager; restoring is pasting it
  into "Use a backup". Nothing reaches Sval's server.

Pairing and the printed or saved backup remain for everything else.

## Moving a profile to another computer

A profile copied to another computer carries its device id with it. Two
machines with one device id write one file, and each overwrites the other.
The sync key travels in the copy on Linux without a keyring and is lost on
macOS and Windows, but the device id travels everywhere.

## Mobile

Mobile is a v2 fast-follow (spec §11). Keys there are settled. How the files
travel is not, and it decides whether "a folder your devices share" is Sval's
sync model or only its desktop one. It must be settled before more of §6 is
built on the folder.

### Keys on mobile

- **iOS.** The sync key in the Keychain, accessible after first unlock, this
  device only, so it is in neither iCloud Keychain nor a device backup.
- **Android.** A Keystore key, which cannot be exported, wraps the sync key,
  the same pattern as `nsIOSKeyStore`. The wrapped file is excluded from Auto
  Backup, because a phone restored from backup would hold a wrapped key it has
  no Keystore key for.
- **Joining** is a QR code the phone scans from a desktop's screen (§6.7), or
  the QR code on a backup sheet. The 52-character code stays available.
- The local key is a file in the app's own storage, as on desktop.

### How the files travel: open

The folder model needs list, read, write and detect-changes against a folder
the user's other devices also see (§6.1). What each mobile platform offers,
from documentation, none of it yet tried on a device:

- **iOS.** A folder picked through the document picker is reachable through a
  bookmark, from the app, while it runs. iCloud Drive and other providers'
  File Provider extensions download on demand, so every read can be a fetch.
  Background time is short and not guaranteed, and nothing reports that a peer
  wrote a file. Bookmarks do not travel between devices.
- **iCloud ubiquity containers** are push-based and prompt, which §6.4 wanted.
  Developer forum posts from 2017 to 2022 say a Developer ID Mac
  app cannot hold the iCloud entitlement, and Sval for Mac is Developer ID. A
  container would then be reachable from desktop Sval only as a plain folder
  under `~/Library/Mobile Documents`, if at all.
- **Android.** The Storage Access Framework grants a directory tree, but whether
  Google Drive's, OneDrive's and Dropbox's providers offer a tree, and whether
  what they offer is a synced folder or an online listing, is unconfirmed.
  Syncthing does present a real folder.

The candidates:

1. **The providers' own HTTP APIs** (§6.4's deferred plan): Dropbox, OneDrive,
   Google Drive and iCloud through CloudKit where it is allowed. Push or delta
   cursors give seconds of latency on every platform. Each needs app
   registration, OAuth and, for Google, a restricted-scope review that takes
   weeks.
2. **The folder on desktop, the API on mobile,** both writing the same files.
   Desktop stays as built. Each phone provider is an API client of the folder
   the desktop syncs.
3. **The folder everywhere,** accepting slow, foreground-only sync on phones and
   naming the providers it works with.

**To settle first, on real devices:** for each of iCloud Drive, Dropbox,
OneDrive and Google Drive, on iOS and on Android, can an app list a folder, read
every file in it, write one, and learn that a peer wrote one, in the foreground
and in the background, and how long a desktop write takes to become readable.
Then whether a Developer ID Mac app can use a CloudKit container. The answers
choose among the candidates; this spec does not.

## Testing

- **xpcshell**
  - Startup with each sync-key state: present, unreadable, missing and
    different. Each opens the local workspaces, and each runs no shared pass
    except "present".
  - Try again after the store becomes readable starts shared passes with no
    restart.
  - Setting up sharing in a folder that holds another key's directories mints
    nothing.
  - A backup round-trips to the same 32 bytes, and a backup for another folder
    is refused.
  - A backup save into the shared folder is refused, and one under a known
    provider root warns.
  - A directory from another key appearing after this device minted raises the
    line once, and not again after it is dismissed.
  - Starting over: the old directory is removed only after the new publish
    lands, a crash between the two leaves both, and a device holding the old key
    lands in the missing-key state.
  - Two profiles on one machine hold two labels, and removing one leaves the
    other readable.
  - After startup, the login store holds no Sval entry, so neither about:logins'
    list (`getAllUserFacingLogins`) nor `browsingData.removePasswords` can reach
    the sync key or the Kagi token; both still read after a removal.
  - On Linux with libsecret unavailable, and with libsecret loaded but every call
    failing, the key is kept in the profile, the choice is recorded, and a
    keyring appearing later does not hide it.
- **browser-chrome**
  - The "Not syncing" line and its Try again and Sync with existing actions,
    driven through the real panel.
  - "Sync with another device" on a device with local workspaces ends
    with both devices showing both sets.
- **Two-device acceptance** (`docs/acceptance-two-devices.md`): make one
  device's store unreadable mid-session. Its edits reach the other device after
  Try again succeeds.

## Out of scope

- Building the mobile apps. This spec settles their keys and names the transport
  question; the answer is its own spec.
