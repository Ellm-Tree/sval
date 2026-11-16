---
title: Connect an extension to a desktop app
description: Copy a desktop app's connection file to Sval's folder, so its extension can reach the app.
---

Some extensions talk to an app on your computer. For example, a
password manager's extension asks the password manager's desktop app to
unlock with Touch ID or Windows Hello. To make that possible, the app
installs a small file, called a native messaging manifest, in a folder
where the browser looks for it.

Sval reads these files from its own folders. Sval never reads them from the
folders Firefox uses. If an app sets itself up only for Firefox, the app
can't reach Sval until you copy its file.

Your password manager's extension in Sval says it can't find the desktop
app, though the app is running.

## Find the app's file

The app's installer puts the file where Firefox reads it. The file is named
after the app, such as `com.8bit.bitwarden.json`.

- **macOS:** `~/Library/Application Support/Mozilla/NativeMessagingHosts`
- **Linux:** `~/.mozilla/native-messaging-hosts`
- **Windows:** In Registry Editor, go to
  `HKEY_CURRENT_USER\Software\Mozilla\NativeMessagingHosts`. Each key there
  is named after an app. The key's default value is the path to the app's
  file.

Some apps install the file only when Firefox is on the computer. If you
can't find the file, check the app's own help for what the file holds.

## Copy it to Sval

Create the folder if it doesn't exist.

- **macOS:** Copy the file to
  `~/Library/Application Support/Sval/NativeMessagingHosts`.
- **Linux:** Copy the file to `~/.sval/native-messaging-hosts`.
- **Windows:** In Registry Editor, create the key
  `HKEY_CURRENT_USER\Software\Sval\NativeMessagingHosts\<name>`, with the
  same name as the key under Mozilla. Set the new key's default value to
  the path of the file. That path can point to the same file Firefox uses.

The next time the extension connects, it finds the app.

## Add Sval to 1Password's list of browsers

1Password's desktop app connects only to browsers on its own list. After
you copy 1Password's file to Sval's folder, add Sval to that list.

- **macOS and Windows:** In 1Password, open **Settings**, then select
  **Browser**. Select **Add Browser**, then choose Sval.
- **Linux:** Add the line `sval` to `/etc/1password/custom_allowed_browsers`.
  You need root permissions to edit the file. Quit 1Password and open it
  again.

## Details

- To set up a file for every user of a computer, use
  `/Library/Application Support/Sval/NativeMessagingHosts` on macOS,
  `/etc/sval/native-messaging-hosts` on Linux, or
  `HKEY_LOCAL_MACHINE\Software\Sval\NativeMessagingHosts\<name>` on
  Windows.
- Sval reads managed storage files and security module files from the same
  places, under `ManagedStorage` and `PKCS11Modules` in place of
  `NativeMessagingHosts` (`managed-storage` and `pkcs11-modules` on Linux).

## Related pages

- [Choose your password manager](/docs/how-to/passwords/choose-your-password-manager/)
- [Password settings and controls](/docs/reference/passwords/)
