# First run, revamped

**Status:** Draft.
**Date:** 2026-11-09
**Author:** John Postlethwait
**Builds on:** `2026-10-07-first-run-design.md`, `2026-10-08-import-design.md`,
the Claude Design round in the First Run project
(`handoff/first-run-revamp/`).

## 1. What changes and why

First run asked eight setup questions and taught nothing. It opened with a
question that mixed "are you new to Sval" with "how do you sync", sent a new
user straight to choosing a folder, with a Keychain prompt on a Mac, and
left anyone who imported nothing in an empty, unnamed Workspace. Only an Arc
user saw a welcome, the Arc card's reveal on the import page.

The revamp:

1. **Introduces Sval first**: a welcome, then three frames on Workspaces,
   the Launcher and what Sval protects.
2. **Asks one plain question**: "Is this your first time using Sval?"
3. **Takes the sync folder out of the new path.** A new device saves on this
   device. Sync is set up from Settings › Sync and devices, which already
   chooses the folder, and the welcome offers one button to it. A new user
   never sees a folder, a key or the Keychain prompt in first run, because
   Sval asks the Keychain only for a sync folder's key.
4. **Names the first Workspace** when nothing is imported.
5. **Folds the small choices** (panel side, AI assistants, default browser)
   onto one screen.
6. **Ends with the user's Sval Card for everyone**, and shows a running
   import's progress there.

Everything the 2026-10-07 spec decided about writes, held steps, pairing,
Kagi, the password manager and failure handling stands, except where this
spec says otherwise.

## 2. The flow

### 2.1 New user

| # | Screen | Shown when |
|---|---|---|
| 1 | Introduction: a welcome, then three frames | always |
| 2 | Is this your first time using Sval? | always |
| 3 | Import | another browser is found |
| 4 | Your first Workspace | nothing is imported |
| 5 | Search engine | always |
| 6 | Blocking | new path |
| 7 | Password manager | always |
| 8 | A few more things | always |
| 9 | Welcome, with the card | always |

Import comes before the Workspace step because what the user imports decides
whether the step shows: imported windows become Workspaces, and the first
fills the Workspace first run would have made. A user who reaches Import and
checks nothing gets the Workspace step next.

### 2.2 Joining

Introduction, the question ("I use Sval on another device"), the folder, the
code or the backup key, search engine (preset to the synced one), password
manager, a few more things, then the welcome. The join steps work as the
2026-10-07 spec §3.2 says; only their look changes.

### 2.3 Controls

- **The introduction** has Back (on every frame after the welcome), Next,
  four dots, the arrow keys and Enter. The last frame's button reads Get
  started. A quiet **Skip** jumps to the question. There's no Skip setup on
  the introduction, and Escape does nothing there.
- **Every step** has Skip setup on the left and Back and Continue on the
  right. Enter is Continue, Escape is Skip setup.
- **The welcome** has one button, Start browsing. Enter and Escape both start
  browsing.

### 2.4 Skip setup

Skip setup goes to the welcome, with the answers continued through kept and
the rest at what installs nothing: DuckDuckGo, Balanced blocking (Sval's own
filter lists, which install nothing), the panel on the left, AI assistants
off, no password manager, and Sval not made the default browser. An import
the user continued through is one of those answers, so it still runs, and the
welcome shows its row and, for Arc, the Arc card.

On the join path before pairing lands, Skip setup closes the sheet and
pairing keeps trying in the background, as today. No synced setting has been
written.

### 2.5 Progress

"Step N of M" goes. A 4px bar fills to the current step's place in the
current path, with no count. The path is worked out again on every step, and
steps are only ever added after the current one, so Continue never moves the
bar back. The introduction shows its own four dots, and the welcome shows
no progress.

## 3. The screens

All copy below is a draft.

### 3.1 Introduction

It opens on a welcome: Sval's mark and wordmark, large, on the night sky,
then "Welcome to Sval" and "Here's a quick look at how Sval works." It has
Next and Skip, and no Back. Three frames follow.

Each frame has a night-sky scene above its text. The scenes are drawn with
the real component's stylesheet and row markup, fed canned content, so they
change when the component does. They're never screenshots.

1. **Workspaces.** A small Workspace panel cycles Work, Home and Trip to
   Lisbon every 2.7 seconds, each in its Workspace's tint. One Workspace
   shows a Split, two tabs side by side.
2. **The Launcher.** The Launcher types "lisbon" and its top match is an open
   tab in another Workspace. It then shows an `@` shortcut searching one
   site (`@w` Wikipedia or `@maps`). The heading shows the window's own
   Launcher key as key caps.
3. **Protection.** The protection panel, open under the address bar's
   shield, with canned counts. The text covers blocking, storage the user
   controls, no Sval servers, and AI assistants only when allowed.

Under reduced motion each scene holds still on its first state. The
welcome has no animation.

### 3.2 Is this your first time using Sval?

Two choices: **I'm new to Sval** and **I use Sval on another device**.

### 3.3 Import

The 2026-10-08 import spec's picker, restyled to the new rows. When Arc is
checked and Arc carries a card, a line says the card comes along.

### 3.4 Your first Workspace

The New Workspace form as built, emoji control included, inside the step,
with a sentence on what a Workspace is and a live Workspace header preview
above it. The name is preset to Personal, focused and selected, so Continue
works with nothing typed. The panel behind the sheet follows the name, color
and emoji as the user changes them. Escape closes the emoji control first.

The Workspace is created with these fields at the end of the flow, in place
of the unnamed one (§4).

### 3.5 Search engine, blocking, password manager

As built, restyled. The password manager step lists every manager Sval offers
on the platform, alphabetically, then None of these, with nothing preset.

### 3.6 A few more things

Three cards, each a glyph, a title, a line of text and a two-way switch:

- **Workspace panel:** Left or Right. The panel moves live behind the sheet.
- **AI assistants:** Off or On. On shows the checkbox "Let websites offer AI
  assistants tools", unchecked.
- **Default browser:** Yes or No. Left out when Sval already is the default.
  Yes asks the OS when the step continues.

### 3.7 Welcome

The user's card (`SvalCardArt`) with its own reveal, in place of the Sval
mark, and the heading "Welcome, {card title}." The card is:

- **new:** the card `ensureCard` made at first launch;
- **Arc:** the card Arc gave the user, when the import includes an Arc
  profile with one. Sval reads it when the sheet opens, so it's known before
  the import runs;
- **synced:** the card from the other device, on the join path.

Under the card:

- **The import row**, when the user chose anything to import. The import
  starts when the last step continues and runs behind the welcome. The row
  shows the browsers' logos and steps from one browser to the next as each
  finishes, because the importer reports progress per browser. When the
  import ends, the row says what arrived. When something failed, the row
  shows the import page's own result lines, with their Try again and Send
  report… buttons. Start browsing, and Enter and Escape, wait until the
  import ends, whether it succeeded or failed.
- **The sync row.** New path: "Your tabs are only on this computer for now."
  and **Set up sync**, which closes first run and opens Settings › Sync and
  devices. Join path: a line that sync is on, with no button.
- **The Launcher tip**, as today.

## 4. The first Workspace and the import

The 2026-10-07 spec §3.4 holds: no Workspace exists until the new path's
last step continues, and the join path creates none. On the new path, the
last step's Continue:

1. applies the held answers;
2. creates the first Workspace, with the user's name, color and emoji, or
   unnamed when an import will fill it;
3. starts the import, whose first window fills that Workspace;
4. shows the welcome.

First run's import no longer opens the import page. The welcome's row shows
its progress and its result, and the welcome stays until the import ends.

## 5. Components

| Component | Change |
|---|---|
| `SvalFirstRunModel.sys.mjs` | The new steps (`intro`, `question`, `workspace`, `more`, `welcome`), the storage step off the new path, progress as a fraction. |
| `first-run.js`, `.css`, `.xhtml` | The new screens and the restyled ones. The sheet is 560×660. |
| `sval-panel-first-run.js` | Creates the named Workspace, starts the import before the welcome, applies Skip setup's answers. |
| `SvalImport.sys.mjs` | Runs first run's plan without its page and reports per browser to the welcome. |
| `new-workspace.js` | Its form, usable inside the first-run sheet. |

## 6. Testing

- **xpcshell:** `SvalFirstRunModel` across every path, Skip setup from every
  screen, and the progress bar never moving back on Continue.
- **browser-chrome:**
  - A new user who imports nothing ends with one Workspace carrying the
    name, color and emoji chosen.
  - A new user who imports ends with no empty Workspace.
  - The new path never asks the Keychain or chooses a folder.
  - Set up sync opens Settings › Sync and devices.
  - The welcome shows the Arc card when Arc is imported, and the new card
    on Skip setup.
  - The joining path still writes no synced setting before pairing lands.
