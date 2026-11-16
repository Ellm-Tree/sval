---
title: Passwords
description: What each password control does, from choosing your password manager to managing a security key.
---

Sval doesn't save passwords, and has no list of saved passwords of its own.
The extension for your password manager fills in your sign-ins. With the
controls below, you choose that password manager and manage security keys.

## Settings › Privacy and protection › Password manager

- **The list of password managers.** The list offers 1Password,
  Bitwarden, Dashlane, iCloud Passwords, KeePassXC, LastPass, NordPass,
  Proton Pass, and **None of these**. iCloud Passwords shows on macOS and Windows only.
  Nothing is chosen until you choose.
- **Add extension.** Sval saves your choice. If the password manager's
  extension isn't installed, Sval installs it from addons.mozilla.org. If
  you removed the extension, Sval installs it again.
- **Save.** When you choose None of these, this button takes the place of
  Add extension. It installs nothing and removes nothing.
- **The status line.** While Sval installs the extension, the line says
  **Adding its extension…**. Then it says **Saved.** or what went wrong.

Your choice stays on this device and doesn't sync.

## Settings › Privacy and protection › Security keys

- **Manage security keys.** The security key manager opens in a new tab.
  There you set the PIN for a hardware security key, and add fingerprints.
  You can also see and remove the passkeys the key holds.

The Security keys card shows on macOS and Linux.

## When you first set up Sval

The step "Which password manager do you use?" offers the same password
managers. When you choose one, Sval installs its extension. When you're importing from
another browser, the step also says how to move that browser's passwords
into the password manager you choose.

## The extensions button's notice

When Sval couldn't install a password manager's extension, the extensions
button shows a notice. The notice says why: you're offline, or the download
failed.

- **Try Again.** Sval tries to install the extension again.

Sval also tries again when it starts, and when your connection comes back.

## Folders Sval reads for desktop apps

An extension that talks to an app on your computer finds the app through a
file the app installs. Sval reads these files from its own folders:

- **macOS:** `~/Library/Application Support/Sval/NativeMessagingHosts`
- **Linux:** `~/.sval/native-messaging-hosts`
- **Windows:** the registry key
  `HKEY_CURRENT_USER\Software\Sval\NativeMessagingHosts`

For every user of a computer, Sval also reads
`/Library/Application Support/Sval/NativeMessagingHosts` on macOS,
`/etc/sval/native-messaging-hosts` on Linux, and
`HKEY_LOCAL_MACHINE\Software\Sval\NativeMessagingHosts` on Windows.
