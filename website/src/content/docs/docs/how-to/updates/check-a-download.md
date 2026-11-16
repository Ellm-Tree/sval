---
title: Check a download
description: Make sure the Sval file you downloaded is the one Ellm Tree published.
---

Each Sval release comes with SHA256SUMS, a list of the SHA-256 checksum of
every file. Ellm Tree signs the list with Sval's release key. If your file's
checksum is on the list and the list's signature is good, your file is the
one Ellm Tree published. Nothing changed it on the way to you.

You got Sval from a link someone sent you, and you want to be sure the file
came from Ellm Tree before you install it.

## Check the file's checksum on macOS or Linux

1. On the [Download page](/download/#verify), under Verify your download,
   download SHA256SUMS into the folder with your Sval file.
2. Open Terminal, and go to that folder.
3. On macOS, run `shasum -a 256 -c --ignore-missing SHA256SUMS`. On Linux,
   run `sha256sum -c --ignore-missing SHA256SUMS`.

The command prints your file's name and **OK**. Any other answer means the
file is damaged or isn't Sval's. Delete the file and download Sval again.

## Check the file's checksum on Windows

1. On the [Download page](/download/#verify), under Verify your download,
   download SHA256SUMS into the folder with your Sval file.
2. Open PowerShell, and go to that folder.
3. Run `Select-String -Path SHA256SUMS -Pattern (Get-FileHash sval-*.exe).Hash`.
   If you downloaded the .zip, type `.zip` in place of `.exe`.

PowerShell prints the line of SHA256SUMS that names your file. If PowerShell
prints nothing, the file is damaged or isn't Sval's. Delete the file and
download Sval again.

## Check the list's signature

These steps need GnuPG. Linux usually comes with it. On a Mac, install
[GPG Suite](https://gpgtools.org/). On Windows, install
[Gpg4win](https://gpg4win.org/).

1. On the [Download page](/download/#verify), under Verify your download,
   download SHA256SUMS, SHA256SUMS.asc, and sval-archive-keyring.asc into
   one folder.
2. In a terminal in that folder, run
   `gpg --import sval-archive-keyring.asc`.
3. Run `gpg --verify SHA256SUMS.asc SHA256SUMS`.

GnuPG says **Good signature**. The last line it prints is the key's fingerprint:
`294F 1F37 83E6 A345 616D F757 007B AE81 50D9 8CEE`. Some versions of GnuPG
print the fingerprint without the spaces.

## Details

- GnuPG also warns that the key isn't certified with a trusted signature.
  That warning means you haven't marked the key as trusted yourself. What
  counts is that the fingerprint matches.
- Sval for macOS is also signed with Ellm Tree's Apple Developer ID and
  notarized by Apple. macOS checks the signature and notarization when you
  open Sval.
- Every time apt or dnf updates Sval's .deb or .rpm package, it checks the
  package against the same release key.

## If something goes wrong

- **The command says FAILED, or BAD signature.** Delete the files, and
  download them again from the [Download page](/download/).
- **The fingerprint is different.** Don't install that file. Download
  Sval from the [Download page](/download/) on sval.app.

## Related pages

- [Install an update](/docs/how-to/updates/install-an-update/)
- [Get release candidates](/docs/how-to/updates/get-release-candidates/)
