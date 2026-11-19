---
title: Record what makes Sval slow
description: Save the last minute of Sval's work as a file you can share when pages, video, or scrolling feel slow.
since: 0.1.0-rc.10
---

A performance recording shows where Sval spent time while Sval was slow.
Sval saves the recording as a file on your computer and never sends the
file anywhere.

A video call stutters, or a page scrolls slowly, and you want to show
someone exactly what Sval was doing at the time.

## Steps

1. In the menu bar, select **Help › Record Performance**.
2. Keep using Sval until the slowness shows, for at least a few seconds.
3. Select **Help › Save Performance Recording**.

Sval saves the last minute as a file named `sval-performance-` followed by
the date and time, ending in `.json.gz`. The file goes to your download
folder. Sval then shows the file in Finder on macOS, File Explorer on
Windows, or Files on Linux.

## Details

- `about:support` has a **Record Performance** button that works the same
  way. While Sval records, the button reads **Save Performance Recording**.
- In `about:processes`, the button next to a process records only that
  process for five seconds, then saves the file.
- The file lists the web addresses of the pages you had open while Sval
  recorded. Share the file only with someone you trust.
- Sval does extra work while a recording runs. Saving the file stops the
  recording.

## Related pages

- [Troubleshooting settings and controls](/docs/reference/troubleshooting/)
- [Send feedback](/docs/how-to/troubleshooting/send-feedback/)
