# Connect an extension to a desktop app

Some extensions talk to an app on your computer. A password manager's
extension, for example, asks its desktop app to unlock with Touch ID or
Windows Hello. The desktop app makes this possible by installing a small
file, called a native messaging manifest, where the browser looks for it.

Sval looks for these files in its own folders. The only file Sval reads
from a Firefox folder is the one macOS installs for
[iCloud Passwords](#icloud-passwords). Some desktop apps don't know about
Sval yet, so they only install the file for Firefox. You can copy the file
into Sval's folder yourself.

## Find the app's manifest

The app's installer puts the manifest where Firefox reads it. The file is
named after the app's host, such as `com.8bit.bitwarden.json`. Look in
these places:

- **macOS:** `~/Library/Application Support/Mozilla/NativeMessagingHosts`
- **Linux:** `~/.mozilla/native-messaging-hosts`
- **Windows:** Open Registry Editor and go to
  `HKEY_CURRENT_USER\Software\Mozilla\NativeMessagingHosts`. Each key there
  is named after a host, and its default value is the path to the manifest.

Some apps install the file only when Firefox is on the computer. If you
can't find it, check the app's own help for the file's contents.

## Copy it to Sval

Sval reads manifests from these places. Create the folder if it doesn't
exist.

- **macOS:** Copy the file to
  `~/Library/Application Support/Sval/NativeMessagingHosts`.
- **Linux:** Copy the file to `~/.sval/native-messaging-hosts`.
- **Windows:** In Registry Editor, create the key
  `HKEY_CURRENT_USER\Software\Sval\NativeMessagingHosts\<host name>`, using
  the same host name as the Firefox key. Set its default value to the path
  of the manifest file. You can point it at the same file Firefox uses.

The extension finds the app the next time it connects.

## KeePassXC

On macOS and Linux, KeePassXC can write its file into Sval's folder itself:

1. In KeePassXC, open Settings › Browser Integration.
2. On the General tab, check Enable browser integration.
3. On the Advanced tab, check Use a custom browser configuration location.
4. Set Browser type to Firefox.
5. Set Config Location to Sval's folder from the list above.

KeePassXC writes the file as soon as the setting is saved.

## iCloud Passwords

On a Mac, you don't need to copy anything for Apple's iCloud Passwords
extension. macOS installs the extension's file in
`/Library/Application Support/Mozilla/NativeMessagingHosts`, and Sval reads
that one file from the folder.

## For administrators

To install a manifest for every user on a computer, put it here:

- **macOS:** `/Library/Application Support/Sval/NativeMessagingHosts`
- **Linux:** `/etc/sval/native-messaging-hosts`
- **Windows:** `HKEY_LOCAL_MACHINE\Software\Sval\NativeMessagingHosts\<host name>`

Managed storage for extensions and PKCS#11 security modules use the same
places, in folders or keys named `ManagedStorage` and `PKCS11Modules`
(`managed-storage` and `pkcs11-modules` on Linux).
