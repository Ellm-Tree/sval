# Sval — First run

**Status:** Built: `SvalFirstRun`, `SvalFirstRunModel`, `first-run.xhtml`.
**Date:** 2026-10-07
**Author:** John Postlethwait
**Builds on:** `2026-10-06-local-copy-shared-folder-design.md` §4.4,
`2026-10-07-settings-sync-design.md`, `2026-10-08-import-design.md` §5 and
`2026-10-08-kagi-privacy-pass-design.md`.

---

## 1. What this is

The first time Sval opens on a profile, it asks the few things worth asking, in
one short flow: whether this person already uses Sval elsewhere, where their
workspaces live, whether to import from another browser, which search engine
to use, how much to block, which password manager they use, whether AI
assistants may use Sval, which side the panel goes on, and whether Sval should
be the default browser.

A new user who presses Continue through every screen ends up with DuckDuckGo,
ad blocking on Balanced, the panel on the left, and their workspaces on this
device, having seen each of those choices. A user joining from another device
ends up with their existing workspaces, search engine and ad-blocking level,
and first run never overwrites any of them on the way.

## 2. Rules and their reasons

| Decision | Reason |
|---|---|
| **A modal in the window's dialog box (`gDialogBox`), over the dimmed browser.** | Sval opens its new-workspace dialog and emoji picker this way, so the pattern, its focus handling and its tests are shared. A `chrome://` page in Sval's own `jar.mn` costs no Mozilla patch; an `about:` page would mean patching `components.conf`. |
| **Every choice is preset to its default, and the default is shown.** The password manager step alone has no preset, so no extension installs unasked. There is no Skip button: Skip and Continue would both keep the default. | A user who presses Continue throughout has seen every default Sval applied. |
| **One "Skip setup" leaves the whole flow, from any screen, the welcome included.** | One exit is enough when every step already has a visible default. |
| **Skip setup applies only what installs nothing:** DuckDuckGo, ad blocking on Balanced, workspaces on this device, panel on the left. | Sval never installs an extension on a screen the user did not see. Balanced is the default level and installs nothing (§4). |
| **The search step preselects DuckDuckGo.** | DuckDuckGo is the engine in use until the user answers (Sval spec §13 item 3), so preselecting it shows what is true. |
| **The privacy step preselects Balanced.** | Most users should end up with ad blocking on, and they see that choice before it happens. |
| **The welcome asks new or existing.** | Its answer changes the rest. A joining device receives its search engine and ad-blocking level from its other devices and has nothing to import. Where a new device saves is a field of Start new, because saving to a synced folder is how a device shares, and asking "sync or not" set up a choice the user could not tell apart from the folder. |
| **A joining device waits on the pairing step until the other device's files arrive.** It does not carry on through the flow while pairing runs in the background. | Search engine and ad-blocking level are synced settings (Sval spec §5.6), merged last-writer-wins. A joining device that answered those steps before pairing landed would write the defaults with a newer timestamp than the user's real choice, and overwrite that choice on every device. Waiting means those steps come after pairing, with the real values already known: search is shown preset to the synced engine, and privacy is skipped. |
| **While waiting, a succinct, provider-neutral note** says the other device's files have not been seen yet and that the user can make their storage app sync. | Sval supports iCloud Drive, OneDrive, Google Drive, Dropbox, SMB and plain folders; naming one provider's controls would be wrong for the rest. Delivery can take tens of minutes on some providers (Sval spec §6.4). |
| **Kagi signs in through Kagi's own cookie in normal windows. A private window never gets the normal window's session:** it signs in with Privacy Pass or a Session Link the user pastes. No token ever goes into a search URL. | A normal session in a private window links private searches to the user's account. Decision 0091, §5. |
| **The panel moves live behind the dialog** as the user picks a side. | The user sees the result before committing. |
| **A welcome screen opens the flow.** | |
| **First run shows once per profile and cannot be reopened.** | Everything it asks is also in Settings (Sval spec §10.8): search engine, ad-blocking level, password manager, agent access, panel side, and Kagi's sign-in with a Session Link field for private windows. |
| **The password manager is device-local and installs only on a choice.** `SvalPasswordManager` records `browser.sval.passwordManager`, which settings sync does not carry. | A choice arriving from another device would install an extension nobody chose here. |
| **A private window never runs first run.** A private window opened first waits, or skips. | A private window saves nothing (decision 0074), so nothing first run wrote there would last. |

### 2.1 Rejected approaches

- **Carrying on through the flow while pairing finishes in the background.**
  It would cause the overwrite described above unless the joining device
  wrote no synced setting until pairing lands.
- **`?token=` Kagi search URLs.** They put a credential into history, and Kagi
  documents them as the manual fallback to its extension.

## 3. The flow

Every screen after the welcome has **Back**, **Skip setup** and **Continue**;
the welcome has **Skip setup** under its two buttons.
The words are plain enough for a user who has never met Sval's own terms, and
say "device" throughout, since a phone will join a computer. The flow follows the "new or existing?" pattern
of Enpass, Obsidian, KeePassXC and Firefox Sync, where the place data lives is
a field of "new", never a question about syncing.

### 3.1 New user

1. **Welcome.** The Sval mark and wordmark, two short paragraphs on what Sval
   is (tabs synced through storage the user controls, no Sval servers, no
   selling of data; tracking and profiling blocked; an AI assistant only if
   wanted), and two buttons: **Start new** and **Use my tabs and settings from
   another device**. The button chooses the path.
2. **"Where should Sval save your tabs?"** On a Mac, the Keychain line comes
   first, then "Saving to Sval's default folder" with Change…, under the line
   "To use your tabs on other devices too, choose a folder they can all reach:
   a cloud folder like iCloud Drive, Dropbox or OneDrive, a network drive, or
   even a USB drive." A cloud folder is named by its
   service ("iCloud Drive › Sval"), any other by its whole path. A folder
   another device already uses says so, with **Use the same tabs and settings
   here**, which turns the flow to join with that folder, and **Choose another
   folder**. The Keychain line carries Keychain Access's own icon, drawn by
   macOS through `moz-icon:`.
3. **Import.** `2026-10-08-import-design.md` §5, headed "Import from another
   browser". Shown when another browser is found.
4. **Search.** "Choose a search engine": all ten engines in Sval spec §13 item 3's
   order, one line each with the engine's icon and a few neutral words.
   DuckDuckGo selected.
5. **Privacy.** No Blocking / Balanced Blocking / Strict Blocking (Sval spec §10.3),
   Balanced selected, and "Sval always warns you about scam and malware
   sites."
6. **Password manager.** "Which password manager do you use?" One choice per
   manager Sval offers on this platform, alphabetically, and "None of these",
   none preset. Choosing one installs its extension from AMO (Sval spec
   §7.3). "None of these" installs nothing and removes nothing. A failed
   install keeps the choice, is recorded in
   `browser.sval.passwordManager.installFailed`, is retried at the next
   launch and when the network comes back, and is said once on the
   extensions button (messages spec §6).
7. **Agents.** "Let AI assistants use Sval?" No or Yes, side by side as every
   two-choice step is, and under Yes alone
   the checkbox "Let websites offer AI assistants tools" (site tools spec
   §7).
8. **Panel side.** "Which side should your tabs go on?" Left (selected) or
   Right.
9. **Default browser.** "Make Sval your default browser?" Yes or No. Not shown
   when Sval already is the default.

The last step shows the Launcher's key beside Start browsing (launcher spec
§8).

### 3.2 Joining from another device

1. Welcome, then **Use my tabs and settings from another device**, which covers
   another device and Sval installed again alike.
2. **"Choose the folder Sval uses on your other device".** A device with no
   sync key yet runs no sync pass, so the folder is accepted once Sval can
   read it. When this user's own sealed key is in the folder (decision 0084),
   the folder step opens the tabs and settings with it and says so as it
   happens; the code step is not shown. A code would bring the same key, so a
   join that fails here offers what fixes the cause (§8), never the code.
3. **"Type the code from your other device".** The twelve-character code, with
   the way to it on the other device: Settings › Sync and devices › Sync with
   another device › This device shows a code. I and L read as 1, and O as 0.
   Continue waits on this step until the other device's files arrive: the
   line under the field names the service that syncs the folder, when Sval
   knows it ("Waiting for iCloud Drive to sync from your other device…"), and
   after thirty seconds says the other device must save to the same folder. A
   join that fails names the folder's problem and offers what fixes it; Try
   again repeats the same claim or adoption in place, because the user may
   have fixed the cause out of band. Skip setup closes first run and leaves
   pairing retrying in the background; no synced setting has been written.
4. **Search**, reviewed: preset to the engine the tabs and settings use, under
   "Your search engine". Kept, it writes nothing, so an engine sync has
   not brought yet is never written over the other devices' choice; changed,
   it is written and syncs. A Kagi session is per device, so Kagi's sign-in is
   offered here too (§5). Privacy is skipped: the synced level applies as it
   arrives.
5. Password manager, agents, panel side, then default browser, as above. The
   password manager is asked on this path too, because its extension installs
   per device.

`claim` separates "nothing has arrived yet" from "this code is wrong"; only a
wrong code is reported as one. Skip setup on the join path applies only
device-local answers (panel side), never search or the ad-blocking level.

### 3.3 Writes and completion

- Each step applies its answer on Continue, except the new path's search and
  privacy steps (`SvalFirstRunModel.HELD_STEPS`), whose answers the panel
  writes once the dialog closes. Both settings sync last-writer-wins, and a
  user who goes back from the new path to join must have written neither:
  writing the old value back would itself be a newer write. Turning to the
  other path at the welcome starts both from their defaults. A crash mid-flow
  loses nothing else already answered.
- Completion is recorded at the end (`done`), or on Skip setup. A dialog
  that closes unanswered records nothing, and first run returns at the next
  launch. A start is recorded too, so a first run that began and never ended
  returns from the welcome with earlier answers preset, though the profile
  by then holds a file and a workspace.
- Search engine and ad-blocking level are written through the synced-settings
  interface that settings sync provides. Panel side is written to
  `SvalLocalSettings`. The password manager is the
  local pref `browser.sval.passwordManager`, which does not sync. Default browser goes through
  Firefox's `ShellService`, and the OS shows its own confirmation.

### 3.4 The first workspace

The panel does not create the unnamed workspace until the dialog has closed. If
it created one first, a joining device would publish an empty unnamed workspace
into the user's real document when pairing completes. On the new-user path it is
created when first run ends. On the joining path none is created; Sval waits
for the shared folder, as local-copy §4.4 specifies for a profile with no
file and a shared folder.

## 4. Ad blocking

The privacy step offers the curated levels Off, Balanced and Strict
(`SvalBlocking.CURATED_LEVELS`). Its answer goes to `SvalBlocking.setLevel`,
which writes `browser.sval.adblock.level`. Sval blocks on Gecko's content
classifier with its own filter lists (`2026-10-12-protections-design.md` §1,
decision 0102), so the level installs nothing. The pref is in settings
sync's pref list (settings-sync spec §4.3), so it applies on every device,
and `SvalBlocking` observes it and rebuilds what the classifier runs.

## 5. Kagi

Researched against Kagi's documentation and the source of its official
extensions (`github.com/kagisearch`).

**Normal windows.** Kagi is registered from its own OpenSearch description
(`https://kagi.com/opensearch.xml`): results at `https://kagi.com/search?q=`,
suggestions at `https://kagisuggest.com/api/autosuggest?q=`. Kagi recommends the
`kagisuggest.com` host because it sends no login cookie with suggestion requests.
Kagi offers a browser no sign-in it can run for the user, only its own page.
With Kagi chosen, the search step offers **"Sign in or sign up to Kagi"**. It
opens `kagi.com/signin`, which goes through `account.kagi.com`, where an account
can also be made, in a small popup over the dialog: a tab would sit under the
dialog, out of sight. The popup has no toolbar and draws no panel, and a banner
says it closes by itself. It closes once a normal window is signed in, and the
notice says so. A device already signed in is told so and asked nothing. If the
popup closes unsigned, the sign-in opens in a tab once first run's workspace is
in place: a tab opened before it would be replaced with the window's other tabs.

A popup, a window without a toolbar (`chromehidden~="toolbar"`), draws no
panel and shows the one page that opened it.

Kagi sets `kagi_session` Secure, for `.kagi.com`. Sval reads a Secure
`kagi_session` for `kagi.com` or `.kagi.com`, in the default cookie jar, only to
say whether a normal window is signed in and to fetch Privacy Pass tokens
(decision 0091). `SvalKagi` starts at every launch when Kagi is the default
engine or a Session Link is stored, and when the user switches to Kagi.

**Private windows** never get the normal window's session. They sign in with
Privacy Pass, Kagi's own method for private browsing, whose tokens Kagi cannot
link to an account (`2026-10-08-kagi-privacy-pass-design.md`). For an account
without Privacy Pass, a private window is signed out unless the user pastes a
Session Link (`https://kagi.com/search?token=…`) into Settings. Its token goes
to Kagi as `X-Kagi-Authorization` under decision 0081's rules: only to
`kagi.com` itself, only for loads the user or Kagi started, and removed from
every other private request so a redirect cannot carry it away. It is kept in
`SvalSecretStore`, per device and never synced, and goes only when the user
clears it or pastes another. A raw pasted token is limited to URL-safe
characters.

No token enters a URL or history, and nothing is written into the private cookie
jar. A private window saves nothing (decision 0074), and the header touches
neither workspaces nor the disk.

Kagi documents its extension, not the header, so a change on Kagi's side can
break a pasted Session Link silently.

## 6. Components

All are Sval's own files under `browser/components/sval/`. No Mozilla file
is patched.

| Component | Role |
|---|---|
| `first-run.xhtml`, `.js`, `.css` | One dialog page that swaps step views. |
| `SvalFirstRun.sys.mjs` | Opens the dialog through `gDialogBox`, as `SvalNewWorkspace` does, and returns its outcome. |
| `SvalFirstRunModel.sys.mjs` | No DOM. Decides the next step from the path and the answers so far, including which steps are hidden. |
| `SvalBlocking.sys.mjs` | First run sets its level (§4). |
| `SvalKagi.sys.mjs` | §5. |
| `SvalPasswordManager.sys.mjs` | Records and installs the password manager. |
| `sval-panel-first-run.js` | Opens first run on a fresh profile, holds off creating the first workspace until it ends (§3.4), applies its answers and records completion. |
| `settings-panes.html`, `settings-kagi.js` | The Kagi card and its Session Link field. |
| `scripts/network-contact/allowed-hosts.txt` | `addons.mozilla.org` for the chosen password manager's extension; `kagi.com`, `kagisuggest.com` and `account.kagi.com`, where `kagi.com/signin` sends the user. Once installed, a password manager talks to its own vendor's service, the user's own account, so those hosts are not on Sval's list, and the network-contact test never chooses a manager. |

## 7. Accessibility

Per Sval spec §10.5. Each step is a labelled radio group, and focus lands on the selected
choice. Enter is Continue, Escape is Skip setup. Each step's heading is
announced when the step changes. The live panel move never takes focus from the
dialog.

## 8. Failure handling

| Situation | Behaviour |
|---|---|
| Folder picker cancelled, or the folder is unreadable | The step stays and says why in one line. "Only on this device" is unaffected. |
| Wrong pairing code | Said once, on the code step. |
| Correct code, files not arrived | Waiting, with the provider-neutral note (§3.2). |
| The OS default-browser prompt is refused | Nothing. Settings has the control. |
| Kagi sign-in never completes | Kagi stays the engine; searches land on Kagi's sign-in page, which explains itself. Private windows stay signed out. |
| The window closes mid-flow | Completion was not recorded; first run returns at the next launch with answers preset. |

## 9. Testing

- **xpcshell:** `SvalFirstRunModel` across both paths, every hidden-step case, and
  Skip setup's defaults from every screen.
- **browser-chrome,** driving the real dialog:
  - The new-user path creates exactly one workspace; the joining path creates
    none.
  - A joining device writes no synced setting before pairing lands.
  - Choosing a side moves the panel before Continue.
  - A normal window's `kagi_session` never reaches a private window's request.
    A pasted Session Link's header is present on private-window requests to
    `kagi.com`, and absent from normal-window requests. The second assertion
    is what proves the guard is not vacuous.
  - Kagi's sign-in popup closes once a normal window is signed in, and says
    when it closed unsigned.
  - First run does not open on a profile that has completed it, or on one that
    already holds a Sval file.
- **Network contact:** one run with first run completed on Balanced and Kagi,
  checked against the allowed hosts.

## 10. Out of scope

- Panel positions beyond left and right.
