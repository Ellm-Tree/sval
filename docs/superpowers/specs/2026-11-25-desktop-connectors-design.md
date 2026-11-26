# A shared folder on an SMB share or in Dropbox, with nothing mounted

**Status:** Built. Decision 2650.
**Date:** 2026-11-25
**Author:** John Postlethwait
**Builds on:** decision 1437 (the shared-folder helper is a native program),
`2026-10-26-native-shared-folder-helper-design.md`, mobile spec §8.1.

## 1. What this is

The desktop syncs through a folder its devices share (spec §6.4). This adds
two places that folder can be without the operating system's help: a folder
on an SMB share, which needs no mount, and a folder in the user's Dropbox,
which needs no Dropbox client. The engine, the browser's passes and every
message about the folder stay as they are. What changes is the helper, the
root the settings keep, and how the user chooses one.

## 2. Remote folders in the helper

`tools/sval-folder/src/remote/` holds the connectors and `src/ops/remote.rs`
the operations over them.

### 2.1 The root

A request's `root` is a local path or a remote root:

- `smb://[user@]host[:port]/share[/folder...]`, port 445 by default.
- `dropbox:/[folder...]`, the folder's Dropbox path.

Each segment is percent-encoded, and none may be empty, `.` or `..`, or decode
to `/`, `\` or NUL. A root of either form is never a local path on any
platform. The browser keeps the root in `sharedFolder`, as it keeps a path.

### 2.2 The sign-in

Each request for a remote root carries `auth`: `{ "password" }` for SMB,
`{ "refreshToken" }` for Dropbox. A request without one answers `io-error`,
`SignInError`. The helper keeps one connection per root and sign-in for its
run, and a new password drops the old connection. It writes the sign-in
nowhere, so a helper killed and started again needs nothing from the one
before.

### 2.3 The operations

Every operation of the helper spec's §2.1 answers as it does for a local
folder, with the same limits (§2.2 there) and the same answers. Where a
remote store differs:

| | SMB | Dropbox |
|---|---|---|
| Atomic write | temporary `.<name>.<16 hex>.tmp`, renamed over the target | upload in overwrite mode, which Dropbox commits whole |
| Move without replacing | rename refused by the server on a name collision | `move_v2`, which refuses a conflict |
| Link | an entry the server reports as a name surrogate | none exist |
| A file's version | change time and size | `rev` |

A temporary file older than ten minutes, of the same name, is removed after a
write, as a local one is.

A link on an SMB share is refused where the server reports one. Samba lists a
Unix symlink as what it points to, and confines a symlink to the share unless
`wide links` is on.

### 2.4 Reading a listing

A listing plans every entry by the size the server lists, with the local
caps, before reading any. It then reads the files whose kept copy is missing
or at another version, Dropbox's eight at a time, and keeps what it read for
the helper's run, up to 256 MiB in all. A file read longer than listed is
`Changed`, as a local one is.

A read that fails because the network did, or the sign-in did, fails the
whole request. Listing a peer's document as unreadable would have the browser
set it aside.

### 2.5 Errors

| Store failure | Answer |
|---|---|
| Nothing at the root | `missing` |
| Sign-in refused | `io-error`, `SignInError` |
| Access refused | `io-error`, `NotAllowedError` |
| Server or Dropbox unreachable | `io-error`, `NetworkError` |

The browser's `folderProblem` reads `SignInError` as `sign-in`. The panel's
indicator says "Can't sign in to sync folder" and offers Settings. Every other
answer means what it means for a local folder.

### 2.6 Protocol

The handshake's protocol is 2: an older helper refuses a remote root as an
invalid request.

## 3. Dropbox

- **Sign-in is OAuth 2 with PKCE** against Sval's Dropbox app, the iPhone
  app's (`DropboxApp` in `mobile/ios/Sval/Shared.swift`), so Sval holds no
  secret (`SvalDropbox.sys.mjs`). The browser opens Dropbox's authorize page
  in a Peek. Once the user allows Sval, Dropbox answers with a 302 to
  `db-<app key>://2/token`, which it accepts without the app listing it.
  Gecko drops a redirect to a scheme no app handles
  (`nsExtProtocolChannel::OpenURL`), so while a sign-in is under way Sval
  reads each response in `http-on-examine-response`, cancels the one that
  redirects there, takes the code from its address and closes the Peek.
  The sign-in logs each of the Peek's loads, and warns with them when the
  Peek closes, or sits for 15 seconds, without the redirect.
- **The browser trades the code for a refresh token** at
  `api.dropboxapi.com/oauth2/token`, without cookies, and keeps the token
  with the sync key. The helper turns it into access tokens.
- **The user picks the folder** in a folder browser of Sval's own, as on the
  iPhone: the helper's `listFolders` names the folders in a remote root,
  with the sign-in the request carries, before the folder is the one in use.
  A token Dropbox no longer takes is replaced by signing in again.
- Sval contacts `www.dropbox.com` to sign in, and `api.dropboxapi.com` and
  `content.dropboxapi.com` to sync (spec §10.9).

## 4. Choosing a remote folder

A folder on this computer, an SMB server and Dropbox are three ways to sync,
so Settings' Sync card offers each with a button of its own: Choose folder…
opens the system folder picker, Connect to SMB server… opens a dialog with
the server's address, the share, the folder in the share, the username and
the password, and Connect to Dropbox…, with Dropbox's glyph, signs in and
opens the Dropbox folder browser. Connect, or Use this folder, keeps the
sign-in and chooses the folder as a picked one is chosen. The way in use
changes from its own button, Change…, Edit connection… or Change Dropbox
folder…, and the other buttons switch to another way.

On a Mac each dialog says, in one line before the button that saves the
sign-in, that the Mac may ask whether Sval can use the Keychain item Sval's
secrets live in.

First run's step for joining another device offers the same three ways.

While Sval syncs through an SMB server or Dropbox, the card says so, names
the folder, and shows `smb://server/share/folder` without the username, or
`Dropbox/folder`. A remote folder has no Show in Finder button. The dialog opens filled in with the folder in
use, with the password empty.

A sign-in is kept only for the folder in use. Choosing another folder, or
stopping sync, drops the rest. A user who names Sval's own folder inside the
share has chosen the folder above it (spec §6.4), and the sign-in moves with
the choice.
