# Sval — Where messages go, and what they say

**Status:** Built: `SvalAppNotices`, `SvalNoticesButton`, `SvalReport`, `SvalCritical`.
**Date:** 2026-10-21
**Author:** John Postlethwait
**Decisions:** 1143 (messages go where the user acts), 1144 (a damaged own
file is moved aside).

---

## 1. What this is

Each message Sval gives the user has its own place:

| Message | Where |
|---|---|
| Sync state and sync problems | One indicator in the footer (§3) |
| This device's own copy can't be saved or opened | A critical dialog (§4) |
| Sval updates | A notices button in the header (§5) |
| Extension notices, and refusals at install | The extensions button (§6) |
| The result of something the user did | The dialog or page they did it in (§7) |

A user who never has a sync problem sees one small moon at the bottom of the
panel and nothing else. A user whose sync folder is offline sees the moon dim
and how long ago it last synced. A user whose disk is full cannot miss it.

## 2. How a message is written

- Say nothing when the problem fixes itself. Delay anything transient.
- A message is a short situation and one call to action. No internals: no
  file names, key stores' mechanics, or how a key was lost.
- When Sval knows why something failed, it says why.
- Offline is a state, not an error.
- One quiet indicator, with the detail one click away in Settings › Sync.
- Losing data on this device is critical and interrupts. Nothing else does.

Strings are English literals, as the rest of Sval's are.

## 3. The footer sync indicator

One icon with a variant per state, a label only when the state needs one, a
button only when the user must act. Clicking the indicator opens
Settings › Sync, whose readout carries the detail sentence, except in the
critical state, where it reopens the dialog.

| State | Icon | Label | Button | Tooltip / Settings detail |
|---|---|---|---|---|
| No sync folder chosen | the footer row is absent | | | |
| Synced | moon | none | | "Synced just now" (the time) |
| First pass of this launch | moon and orbiting satellite | none | | "Syncing…" |
| Folder unreachable, two steps in a row | moon at 50%, pause badge | Can't reach *folder*, with "Last synced 2 hours ago" under it | Try again | |
| Folder missing, from the first step | moon, warning badge | Can't find *folder*, with the last sync under it | Sync now, Change… (opens the Change dialog) | |
| Sval's files gone from the folder, from the first step | moon, warning badge | Sval's files are missing from *folder*, with the last sync under it | Choose folder… (opens the folder picker), Sync now | |
| Folder access denied | moon, warning badge | Can't access sync folder | Choose another folder… (opens the Change dialog) | |
| Another key's device in the folder | moon, warning badge | Pair your other device | Enter Code… and ✕ | "Your sync folder has Workspaces from a device that isn't syncing with this one. To sync them, choose "Sync with another device" on that device and enter the code it shows here." |
| Another device on a newer Sval | moon, warning badge | Update Sval | Update | "A newer version of Sval is available. Update to keep syncing." |
| Key store refused | moon, warning badge | Sync needs access | Allow Access (macOS, Linux), Try Again (Windows) | below |
| Folder too large | moon, error badge | Sync stopped | Settings | "Your sync folder is too large to sync. Choose a different folder." |
| Sync key gone | moon, error badge | Sync is off | Reconnect… | "Sync is off on this device." |
| Private window | outlined moon | none | | "Private window. Tabs here aren't saved or synced." |
| Automated (WebDriver) window | outlined moon | none | | "Automated window. Tabs here aren't saved or synced." |
| A critical dialog was dismissed | moon, error badge | the dialog's title | | |

The footer shows one state's detail under its label: another key's device in
the folder. Its label alone cannot explain the problem, which is on another
device and is put right there, so the footer says what to do, with the
buttons under the detail. Every other state shows its label alone, with the
detail in its tooltip and in Settings › Sync.

Key store detail, by platform:

- macOS: "Sval needs Keychain access to sync. Choose Always Allow when your
  Mac asks."
- Linux: "Sval needs your keyring to sync. Unlock it when asked."
- Windows: "Sval can't reach Windows Credential Manager. Try again, or
  restart your computer."

When several hold, the most severe shows: critical, then error, then
warning, then offline, then syncing, then synced.

**Not shown at all:**

- A file from another device that can't be read. It clears when that device
  next writes, and a cloud client that has not finished downloading a file
  causes it too. It goes to the log.
- This device's own file in the folder that can't be read. Sval recovers it
  (§8.2).
- The time while healthy. It is the synced icon's tooltip, and the label
  appears only when the folder is unreachable.

**Why the folder is unreachable.** The shared-folder helper reports a reason
with every failure, and the engine passes it up (§8.1):

| Reason | State |
|---|---|
| `timeout`, `busy`, `helper-failed`, any other `io-error` | Folder unreachable |
| `missing`, `not-a-directory`, `no-sval-dir` | Folder gone |
| `io-error` named `NotAllowedError` | Folder access denied |
| `too-large` | Folder too large |
| `own-file-unreadable` | none: §8.2 |

A folder that is not there shows from the first step that finds it so: a
retry finds the same until someone connects the drive or chooses the folder
again. A folder that is there and does not answer shows from the second
failed step in a row, because one failure is often a blip, and the engine
retries the first within seconds. A pass someone waited on, as Settings'
Sync now is, shows its answer at once. The first step that reaches the
folder clears either (decision 0032).

The footer and Settings › Sync say a folder's state in one wording: the
footer's label is the Sync card's title, naming the folder, with the same
last-synced line under it, and the footer's buttons are the card's. The
footer's Sync now waits for the folder, as the card's does.

The folder's two remedies are apart in Settings › Sync. A chosen path that
is not there (`missing`, `not-a-directory`) says the folder can't be found,
with the last sync, and offers Sync now and Change…. A folder that is there
without Sval's files (`no-sval-dir`) offers to choose the folder again or set
it up again.

The last-synced time says how long ago the sync was, "2 hours ago", and is
kept in the profile's device-local settings for the folder chosen, so a
launch says when this device last synced before its first step answers.
"Not synced yet" means this device has never synced with the folder.

## 4. The critical dialog

For the two states where this device's own copy, in the profile, is failing.
Sval works from that copy whether or not a sync folder exists
(`2026-10-06-local-copy-shared-folder-design.md`), so failing to read or
write it is the one fault that loses work.

| Title | Body | Buttons |
|---|---|---|
| Sval can't save your changes | The cause, then "Changes you make won't be kept." | Try Again · Send Report |
| Sval can't open your workspaces | The cause | Restart · Send Report |

The cause:

| Cause | How Sval knows | Sentence |
|---|---|---|
| Disk full | `NotReadableError`, and `nsIFile.diskSpaceAvailable` on the profile directory is under 1 MiB | Your disk is full. |
| Permission denied | `NotAllowedError` | Sval doesn't have permission to save to its profile. |
| Disk failing | `NotReadableError` with space available | There's a problem with your disk. |
| Anything else | | none |

The first dialog appears when two passes in a row have failed to save; one
failure is a blip, and a pass that saves starts the count again. A minute of
failures would hide a fault that loses every change made in it. The second
appears when startup
throws. Both have a ✕, and Esc closes them; dismissing hands the state to
the footer's critical line, and clicking that reopens the dialog.

**Send Report…** opens the feedback form with the dialog's title and cause
as its context (`2026-10-22-feedback-design.md`), and closes the dialog.

## 5. The notices button

Sval's header has no app menu button, which is where Firefox shows update
notices. A button in the header's right-hand group, after the pinned items
and before the extensions button, appears only while a notice exists. It
carries a badge and opens a popover listing each notice with its buttons. It
holds Sval's update notices, in Firefox's own translated strings
(`appMenuNotifications.ftl`, `appmenu.ftl`):

| Notice | Text | Buttons |
|---|---|---|
| Available | Download the latest version of Sval. | Download · Dismiss |
| Manual | Sval couldn't update automatically. Download the new version — you won't lose saved information or customizations. | Download · Dismiss |
| Unsupported | Your operating system isn't compatible with the latest version of Sval. | Learn more · Dismiss |
| Restart | Get the latest version of Sval. Open tabs and windows will be restored. | Update and restart · Dismiss |
| Another copy running | Close the other copy of Sval to finish updating. | Update Anyway · Not Now |
| Dismissed | Update available — restart now, and its variants | the main action |

"Another copy running" is Sval's own sentence: Firefox's runs to three
sentences.

## 6. The extensions button

Every extension notice is a message at the top of Firefox's extensions
panel, with a badge on the extensions button. The top, because an extension
that is turned off, pinned or not installed has no row in the panel. The
badge clears when the panel opens; a message stays until one of its buttons
answers it.

| Notice | Text | Buttons | Opens the panel |
|---|---|---|---|
| Installed | uBlock Origin was added. | OK, and Pin to toolbar | yes |
| New permissions on update | Firefox's | Firefox's | no |
| Installed by another program | Firefox's | Firefox's | no |
| Password manager not installed | 1Password couldn't be installed: you're offline. / …: the download failed. | Try Again | no |
| Turned off: needs containers | Sval turned off Multi-Account Containers because it doesn't support it. Use isolated workspaces instead. | Remove · OK | no |
| Hides and shows tabs | Simple Tab Groups may not work as expected in Sval. It only sees tabs in the current workspace. | Remove · Keep | with the install |

A password manager that failed to install is tried again as soon as the
network comes back, as well as at the next launch.

**Refused at install.** An install Sval refuses is answered where Firefox
shows its install prompt, on the extensions button:

- A theme: "Sval doesn't support themes." OK.
- An extension that needs containers: "Sval doesn't support Multi-Account
  Containers. Use isolated workspaces instead." OK.

Firefox's add-on import offer is not shown: Sval's import brings no
extensions, so nothing stages one.

## 7. Results where they happen

None of these reaches the footer.

**Workspace edit dialog.** A colour or emoji the engine refuses keeps the
dialog open with the choice still selected and "Couldn't save the colour or
emoji." under the picker; Save tries again. A save that fails for any other
reason keeps the dialog open with "Couldn't save your changes." in the same
place.

**Import.** The dialog stays open through the import: one row per browser
with its progress, an overall bar, then the result and Done. An import chosen
in first run runs once first run closes, because the first imported window
fills the workspace first run makes; the import dialog opens then, already
running. Results: "Imported 3 workspaces and 40 favorites." /
"Imported 3 workspaces, 40 favorites and your history." / "Imported your
history." / "Nothing new to import." History is said without a count, and
an import that brought only history is never "Nothing new to import." A
browser that failed:

| Cause | Line | Buttons |
|---|---|---|
| Its data wasn't understood | Couldn't read Chrome's data. Export your bookmarks from Chrome as an HTML file and import that instead. | Import Bookmarks File… · Send Report |
| Its files couldn't be opened | Couldn't open Chrome's data. Export your bookmarks from Chrome as an HTML file and import that instead. | Try Again · Import Bookmarks File… |
| Only its history couldn't be imported; the rest arrived | Couldn't import Chrome's history. | Try Again |

**Joining another device (Settings › Sync and devices).** Settings never
says "pair": Agents uses the word for an agent's access.

| Result | Line | Button |
|---|---|---|
| Success | Joined. Your devices are syncing. | |
| The folder wasn't written | Join failed: Sval can't reach your sync folder. | Try Again |
| The key store refused the key | Join failed: Sval needs Keychain access. (Credential Manager, keyring) | Allow Access (macOS, Linux), Try Again (Windows) |
| No sync folder | Join failed: choose a sync folder first. | Choose folder… |
| This device's workspaces couldn't be read | Join failed: Sval can't read this device's workspaces. | Send Report |

**Set Up Sync Again (Settings › Sync and devices).** It lives only here. Success:
"Sync is set up on this device. Give your other devices a code to sync with
it." with Show Code…. Failure: the join lines, with "Setup failed:" in place
of "Join failed:". Old files left in the folder are not mentioned: Sval
keeps removing them on its own.

**Restore from a backup (Settings › Sync and devices › Advanced).** Once the
typed key fits the folder's workspaces, the restore is a join with that key.
Success: "Done. Both devices are synced." Failure: the join lines, with
"Restore failed:" in place of "Join failed:". What is said before the key reaches the folder
(not a backup, no folder, a key for other workspaces) stays a plain line.

## 8. In the engine

### 8.1 The folder's reason

`SvalEngine`'s shared state keeps the helper's reason beside
`unreachable`, and a pass report carries it as `sharedReason`. The panel
maps it to a state (§3).

### 8.2 A damaged own file is moved aside (decision 1144)

When this device's own file in the shared folder has been unreadable for 10
minutes, Sval renames it to `<name>.damaged-<time>` in the same directory,
where the time is the pass's, in milliseconds since the epoch, and the next
pass writes a fresh file from this device's document. Each set-aside keeps a
copy of its own: nothing is ever replaced or deleted. The ten minutes cover a
cloud client still downloading the file, and count only while the folder can
be reached. A file that a newer build wrote
(`schemaTooNew`) is never moved: that device is told to update (§3).

## 9. Visual design

The stylesheets named below hold the values.

### 9.1 The sync icon

The Sval moon with the mark's S cut out. Syncing adds a satellite on an
orbit, held still under `prefers-reduced-motion`. Offline is the moon dimmed
with the pause badge. Warning and error add a ringed badge disc. Sync off is
the outlined moon. The art is in `chrome/browser/components/sval/sync-icons/`
and its colours per surface, forced colours included, in `sval-panel.css`.

### 9.2 The footer

The indicator is a pill button with the icon and, when the state has one, a
label. Its buttons sit right-aligned and wrap to their own row when the
label's row is full. At the narrowest panel the indicator is a circle and
its label and buttons hide. The values are in `sval-panel.css`.

### 9.3 The critical dialog

A dark red scrim, a card with a red edge and glow, a solid red title band
holding a white octagon and the title, the cause, and "Changes you make
won't be kept." in bold red. The primary button is solid red. Clicking the
scrim does nothing. The values are in `sval-dialog.css`.

### 9.4 Popovers and dropdowns

The notices, extensions, downloads and site-settings panels attach to their
button: while open, the button takes the popup fill and grows a stem down to
the panel, with concave fillets where the stem meets it and no arrow.
The panel opens in place, with no slide, and its stem is drawn with it.
While it is open, the button's slice of its cluster gives way to the pill,
so the joined shape is the only shape there.
One 1px edge traces the joined outline, in the address pill's border colour
(`--sval-pill-border`, the text colour under increased contrast), and one
drop shadow falls from it (`--sval-stem-shadow`). The popover's own window
draws the whole joined shape, around the button's face, down the stem and
around the panel, as one filled path stroked once, so the edge keeps one
width and one line at any display scale. The button keeps only its fill,
which matches the popover's, and shows through the popover's window. One
rule in `sval-header.css` covers all four, the doorhanger that answers a
refused install from the extensions button, and the panel's workspace
switcher and Favorites dropdowns, which take the same attachment from the
button that opens them. A dropdown that is not attached keeps its own deeper
shadow.

### 9.5 Badges

A badge is the header's one dot (header signals spec §1 and §7).

### 9.6 Result lines

A glyph, the sentence in text ink, and the line's buttons on a row beneath,
aligned with the sentence. Success, warning and error each have their own
colour, light and dark. A warning sits in a tinted well, and an error is
tinted only when the line has buttons. The values are in `settings.css`,
`import.css` and `new-workspace.css`.
