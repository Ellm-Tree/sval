# Sval — A local copy, and a shared folder that comes and goes

**Status:** Built.
**Date:** 2026-10-06
**Author:** John Postlethwait

---

## 1. What this is

Sval keeps this device's copy of the workspaces in the profile, always, and works
from it (decision 0030). The folder the user chooses for sync is only where
devices exchange changes. Sval assumes that folder is volatile: an SMB or NFS
share that drops, an iCloud folder whose files were evicted, a USB drive that is
unplugged. Not reaching it is an expected state, and Sval treats it as one.

**Success looks like:** with the shared folder unplugged, Sval launches with every
workspace and tab, edits and quits without losing anything, and says nothing for
the first three minutes. When the folder returns, the devices converge with
nobody pressing anything.

## 2. Rejected approaches

- **Engine-level local and remote roots.** A `StorageProvider` with two locations
  inside `sval-core`. Rejected because the browser-run two-pass approach needs no
  engine change and gets the same behaviour.
- **Mirroring the whole shared folder into the profile.** Rejected per the "one
  file is enough" rule (§3).

## 3. Rules

- **This device's file always lives in the profile.** Same encrypted format,
  same layout (`sval/ws/<hashed>/<deviceId>.json`), under
  `PathUtils.profileDir`. The profile is per-user, writable, and already holds
  Sval's identity and settings. The application directory is read-only once
  installed, shared by every OS user, and replaced on update.
- **One file is enough.** The profile holds only this device's own file. Each
  device's file carries the whole merged tree (main spec §6.2), so it alone
  restores every workspace and tab.
- **The browser runs two passes; the engine has one location per call.** `sync`
  judges what to write against the own file in whatever snapshot it is handed,
  and treats a stale copy of its own file correctly
  (`sync::tests::a_device_restored_from_backup_recovers_its_own_offline_writes`).
  Two locations in the engine would change a contract iOS and Android inherit.
- **The browser process never touches the shared folder. A helper process does**
  (decision 0031). Firefox runs every `IOUtils` call through one serial queue
  per process (`IOUtils::EventQueue`), so one read stuck on a hung NFS mount
  would stall every file operation in the browser. An OS thread stuck in that
  read cannot be interrupted. A separate process can be abandoned, and the
  browser quits without it.
- **The helper is `sval-folder`, a native program beside the browser binary**
  (decision 1437, `2026-10-26-native-shared-folder-helper-design.md`). The
  browser talks to it over its stdin and stdout, and one helper serves the
  browser run until its stdin closes.
- **The helper only moves bytes.** Sval computes the directory (`syncPrefix`)
  and merges; the helper lists, reads and writes files. The document key never
  leaves the browser.
- **The shared step has 20 seconds, runs every 30 seconds, and at most one
  helper is alive** (decisions 0032 and 0033). Local saves are immediate; only
  the exchange with the folder runs on the slower clock.
- **Unreachable is silent for three minutes, then a neutral notice**
  (decision 0032).
- **A shared folder Sval has used before counts as reachable only if its `sval/`
  directory is there.** An NFS mount point that is not mounted is an empty
  local directory. Without this rule Sval would write into it, report "synced",
  and leave a file hidden under the mount when it returns.
- **Sval never recreates a missing folder on its own; the user does, in one
  click** (decision 0036).

## 4. Design

### 4.1 Two locations

- **Local:** `PathUtils.profileDir`. Always present.
- **Shared:** the folder the user chose, or none: the local settings'
  `sharedFolder`, null for none. With no shared folder, local is the only
  location and there is one pass.

### 4.2 A pass

Every pass, whether from the poll, a debounced local change, or "Sync now":

1. **Local.** Read the profile's own file, merge, and write it if the merged
   shared state differs. Always runs, and runs first, so a local edit is on disk
   before anything touches the network. A background pass returns here, and
   the shared step's result arrives through `addSharedListener` (decision 0034).
2. **Shared, if there is a shared folder, at least 30 seconds have passed
   since the last shared step (or the user pressed "Sync now"), and no helper is
   still busy.** Sval asks the helper, starting one if none is alive. It
   checks the folder (§4.3) and copies every file under this document's
   directory into a private directory in the profile. Sval merges what it read
   inside the worker's queue. If this device's file needs writing, the helper
   writes it to the folder, atomically. The whole step has **20 seconds**.
   If it overruns, or a helper fails, Sval kills the helper without waiting for it
   to die, discards anything it later reports, and marks the folder unreachable.
   A step reads at most 256 MiB from the folder; a folder holding more is too
   large and is not synced (decision 0032).
3. **Local again, only if step 2 changed the document,** so what arrived from
   peers is on disk locally too.

A helper stuck in a hung mount cannot die until the mount answers. It is outside
Sval, so it holds up nothing, and Sval starts no other helper while it is alive.
When the mount returns, the helper exits and the next shared step runs. When the
browser quits, Sval sends any live helper `SIGKILL` and does not wait. The
browser's own shutdown never waits for a child (`toolkit/modules/subprocess/`).

### 4.3 Reachable, unreachable, and first use

- The shared folder is **reachable** when the helper finds its root is a
  directory within the limit and, if Sval has published there before, `sval/`
  exists in it.
- **First use:** when the user chooses a folder, Sval has not published there. The
  first pass that reaches it creates `sval/` and writes this device's file, and
  `SvalLocalSettings` records that this folder has been published to.
- **Unreachable** is any other outcome of step 2: missing root, a root without
  `sval/` after first use, a timeout, a permission error, an I/O error.
- A file Sval cannot decrypt, or one from a newer build, leaves the folder
  reachable. It is reported as a problem with that file.
- **Moved or deleted looks the same as unmounted.** A folder the user moved, or a
  `sval/` deleted here or on another device and synced here, is unreachable by
  these rules. Sval keeps working from the profile and never recreates the folder
  by itself. The way out is in settings (§4.6).
- **Recovery spreads by itself.** Once any device republishes, with "Use this
  folder again" on one device, `sval/` exists again, and every other device
  finds the folder reachable on its next pass with nothing pressed.
- **Deleted device files inside an existing `sval/`** are not an outage. The folder
  is reachable, and each device rewrites its own file on its next pass.

### 4.4 Launch

Decision 0039 holds the rule.

1. The local pass runs first. If the profile copy holds workspaces, the panel
   draws them and restores the tabs at once, online or not. The shared pass
   then runs in the background.
2. If the profile copy holds none and there is a shared folder, as on a fresh
   install pointed at an existing share, Sval creates no workspace until the
   shared folder has answered, and retries silently until it does. Creating
   one without that answer is how two devices end up with two.
3. If the profile copy holds none and there is no shared folder, this is a
   first run, and Sval creates the first workspace.

### 4.5 Choosing and changing the folder

- **Choosing a folder** stores the setting and marks it not yet published to.
  Nothing is moved: the next pass that reaches it publishes there. An empty
  folder receives this device's file; one that holds Sval files merges with it.
- **Choosing "none"** stops syncing. The profile copy carries on. This device's
  file stays in the old folder, where peers keep its last state.
- **Changing from one folder to another** is both of the above.

### 4.6 What the user sees

- **Unreachable for under three minutes:** nothing.
- **Unreachable for three minutes or more:** the footer's sync indicator shows
  its offline state: the moon dimmed, labelled with the last-synced time, and a
  tooltip saying Sval can't reach the sync folder
  (`2026-10-21-messages-design.md` §3). It is a state of the indicator with no
  error styling and no `role="alert"`. It clears on the first pass that reaches
  the folder. While the folder is reachable the last-synced time is the
  indicator's tooltip and has no label (decision 0037).
- **The indicator leads to settings.** There, the folder section says what Sval
  can see, that it can't find its files in the folder, and offers two actions:
  - **Use this folder again:** creates `sval/` and publishes this device's file,
    treating the folder as first use (§4.3). For a folder that was deleted, or a
    share that is back but empty.
  - **Choose a different folder:** for a folder that was moved. Choosing it is
    first use; Sval merges with whatever copy is already there.
  Neither action is offered while the folder is reachable.
- **"Sync now"** in settings says what happened, including that the shared
  folder is unavailable, because the user asked.
- **Pairing** needs the shared folder at that moment. It waits for a slow folder
  rather than failing, and goes through the helper (decision 0031).
- **Per-file problems** (cannot decrypt, newer build) are reported per file.

## 5. Components

- **`tools/sval-folder`:** the helper. It checks the folder, reads a
  directory's files or writes files atomically, as each request on its stdin
  says, and answers on its stdout. It never sees the key.
- **`SvalSharedFolder.sys.mjs`:** starts and supervises the helper from
  the browser: the private request directory, the 20-second limit, at most one
  live helper, kill without waiting, `SIGKILL` at quit. Nothing in it calls
  `IOUtils` on a shared-folder path.
- **`SvalSync.worker.mjs`:** the local pass, and a merge entry point that takes a
  snapshot the browser hands it. It never touches the shared folder.
- **`SvalEngine.sys.mjs`:** carries both locations; `sync()` runs the local pass,
  the shared step through `SvalSharedFolder` on its 30-second clock, and the
  second local pass, and reports whether the shared folder was reached.
- **`patches/package-sval-folder.patch`:** the package carries the helper beside
  the browser binary.
- **`SvalLocalSettings.sys.mjs`:** records whether the chosen folder has been
  published to.
- **`sval-panel.js` and `sval-panel-folder.js`:** the launch order of §4.4, the
  status rules of §4.6, and choosing a folder as a stored choice with no move.
- **`settings.js`:** "Sync now" reports an unavailable folder in words; the
  folder section says what Sval can see and offers "Use this folder again" and
  "Choose a different folder" while the folder is unreachable.
- **`sval-core` (engine):** takes one location per call; the browser runs the
  two passes. `docs/host-contract.md` notes that a host may run one document
  against more than one location.

## 6. Testing

Browser-chrome and xpcshell, all against real folders:

1. **Launch with the shared folder missing** restores every workspace and tab
   from the profile.
2. **Edit offline, quit, relaunch with the folder still missing:** nothing is
   lost.
3. **Edit offline, then the folder returns:** a peer sees the edits with nothing
   pressed.
4. **A shared folder that hangs** does not delay the write to the profile, and
   Sval gives up on it at 20 seconds and starts no second helper while the first
   is alive. A named pipe (`mkfifo`) in place of a peer file blocks the
   helper's read for real. macOS and Linux only; Windows has no `mkfifo`.
   A nightly CI job hangs real NFS and SMB shares.
4a. **Quitting with a stuck helper alive** finishes promptly, and the change made
   just before quitting is in the profile copy at the next launch.
5. **An unmounted NFS mount point**, a used folder whose `sval/` has gone,
   counts as unreachable, and Sval writes nothing into it.
6. **A deleted `sval/` stays unreachable and is not recreated;** "Use this folder
   again" recreates it and publishes; a second device pointed at the same folder
   then finds it reachable on its next pass with nothing pressed.
7. **Deleting one device's file inside `sval/`** shows nothing, and that device's
   file is back after its next pass.
8. **Status timing:** a 30-second outage shows nothing; a 3-minute outage shows
   the neutral notice, without `role="alert"`; reconnecting clears it. Driven by
   an injected clock.
9. **No local copy and an unreachable shared folder:** no workspace is created
   until the folder answers.
10. **Choosing an empty folder** publishes there on the next pass; **choosing one
   that holds a peer's files** merges; **choosing "none"** keeps every workspace.
11. **Two idle devices write nothing** to either location.

## 7. Out of scope

- Cloud provider APIs (main spec §6.4).
- Reading iCloud-evicted files in a way that triggers their download.
- Removing this device's file from a folder the user stopped using.
