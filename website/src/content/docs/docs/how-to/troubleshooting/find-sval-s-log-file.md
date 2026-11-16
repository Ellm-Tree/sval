---
title: Find Sval's log file
description: Open the folder that holds sval-log.txt, the file where Sval keeps its warnings and errors.
---

Sval writes its warnings and errors to a file called `sval-log.txt` in its
data folder. The log never includes a Workspace, group, or tab name, a web
address, a file path, or a secret.

Sync stopped working on one of your computers, and you want to see what
Sval logged before you report the problem.

## Steps

1. In the address bar, type `about:support` and press Enter.
2. Under Application Basics, find **Profile Folder** (**Profile Directory** on Linux).
3. Select **Show in Finder** (**Open Folder** on Windows, **Open
   Directory** on Linux).
4. Open `sval-log.txt`.

## Details

- When `sval-log.txt` gets full, Sval renames it `sval-log-old.txt` and
  starts a new one. The two together stay under 1 MB.
- The log keeps warnings and errors from Sval and from the browser's own
  code.
- When you send feedback, the form includes recent lines from the log as
  Sval's error log. You can view or uncheck the error log in the form. See
  [Send feedback](/docs/how-to/troubleshooting/send-feedback/).

## Related pages

- [Troubleshooting settings and controls](/docs/reference/troubleshooting/)
