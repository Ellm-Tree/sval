# 0129. Always allow for uploads covers folders, each with its scope

**Status:** Accepted on 2026-10-18.

## Context

An answer covers one action or the site for good
([0124](0124-an-answer-covers-one-action-or-the-site-for-good.md)). For
uploads, "Always allow uploads to <site>" covering any file the user can read
fails. The agent chooses the files, and text on any page it reads can steer
it, so once a site where an attacker can receive a file is allowed, SSH keys,
cloud credentials and other browsers' login stores can reach it with no alert.

Covering a folder and every folder inside it, with no choice, leaves the same
hole one level down: a file's folder is often the home folder or Downloads, so
approving `~/resume.pdf` covers `~/.ssh` (security audit 2026-10-24, AG-3).

## Decision

- **Always allow covers the folders of the files the upload alert showed**
  that no folder of the site's entry allows. The alert names those folders.
- **Under Always allow the user picks the scope**: "This folder only", the
  default, or "This folder and the folders inside it". One choice covers every
  folder the alert names.
- **Each folder is stored with its scope** in the site's `uploads` entry,
  `{"folders": [{"path": ..., "subfolders": false}]}`. `false` allows a file
  whose parent folder is the folder; `true` allows a file the folder holds at
  any depth, as Gecko's `nsIFile.contains` judges it. A folder Sval cannot read
  is dropped, and an entry with no folders is no decision, and asks again.
- **A file outside every allowed folder asks again**, with the usual alert,
  which lists every file the call sends.
- **A folder never covers a hidden file**, or a file in a hidden folder below
  it. A hidden entry's name starts with a dot, or Windows marks it hidden. The
  home folder keeps SSH keys, `.netrc` and other tokens in hidden files, so
  approving `~/resume.pdf` with "This folder only" would otherwise cover them.
  Such a file asks every time.
- **An Always allow for a folder the entry has keeps the wider scope.** Only
  Settings narrows one.

## Consequences

- An upload from a folder inside an allowed one asks, unless the user chose
  the folders inside it.
- Settings shows each folder's scope, and can narrow a folder, remove one, or
  set the entry to Ask or Deny. It never widens a scope or sets an entry to
  Allow: only an alert that showed the files gives either.
