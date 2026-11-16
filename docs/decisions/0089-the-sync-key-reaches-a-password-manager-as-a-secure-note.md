# 0089. The sync key reaches a password manager as a secure note

**Status:** Accepted on 2026-10-08.

## Context

A password manager's extension cannot run on Sval's own pages, so offering the
backup through a form would need a static page at `sval.app`. The key would
travel in the URL's fragment, which never reaches the server, but the page
would still be a contact with Sval's server at the moment a backup is saved or
restored, and a script served from it reads the key. Sval says the user's data
never touches its servers; that page would make the claim depend on a server
never being compromised.

Password managers scan QR codes only to set up one-time passwords
(`otpauth://`). Dressing the key up as one would store it as a two-factor
code the manager displays as six changing digits, with the key itself buried
in an edit screen. A plain QR code of the key fails too: an iPhone camera
reads it as text and offers to search the web for it, no password manager
files a scanned code as a secure note, and nothing reads the code back into
Sval, which has no phone app.

## Decision

- No page, and no contact with `sval.app`, for the backup.
- The backup sheet tells the user how to keep the key in their password
  manager: press Copy, and save the code as a secure note. Restoring is
  pasting the code into "Use a backup".
- The sheet shows no QR code and says nothing about scanning. A QR code comes
  with a phone app that reads it.
- The backup sheet is drawn like Sval's other dialogs.

## Consequences

- No manager fills the key in by itself on a new machine; the user pastes it.
  iCloud Keychain (0084) and the sealed copy in the sync folder cover the
  cases where nothing has to be pasted.
- Saving the backup needs the password manager on the machine Sval runs on,
  or a paste somewhere the user moves it from.
