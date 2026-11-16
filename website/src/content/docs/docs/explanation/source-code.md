---
title: Sval's source code
description: Where Sval's source code is, which licenses cover it, and how to report a problem or send a change.
---

Sval's source code is public on GitLab, at
[gitlab.com/sval-browser/sval](https://gitlab.com/sval-browser/sval). You
can read every line Sval adds to Firefox, build Sval yourself, and send
changes back.

## Where the code lives

The GitLab repository holds Sval's own code and the patches Sval applies to
Firefox ESR. It doesn't hold a copy of Firefox. When you build Sval, a
script downloads the Firefox ESR commit that Sval is built on, then applies
Sval's patches to it. The repository's
[README](https://gitlab.com/sval-browser/sval/-/blob/main/README.md) says
how to build and run Sval.

GitHub has a read-only copy at
[github.com/Ellm-Tree/sval](https://github.com/Ellm-Tree/sval). It takes
no issues or pull requests, so report problems and send changes on GitLab.

## The licenses

Sval's own code is licensed under the GNU Affero General Public License,
version 3, with an added permission that lets Sval ship through Apple's and
Google's app stores. Anyone can use, change, and share Sval under that
license. If you share a changed copy of Sval, you have to share its source
code under the same license.

Some files in the repository are under other licenses:

- **Mozilla's files**, and Sval's changes to them, stay under the Mozilla
  Public License 2.0.
- **These docs pages** are under Creative Commons Attribution-ShareAlike
  4.0. You can copy and adapt them, as long as you credit Sval and share
  your version under the same license.
- **Sval's logo and brand art** are under no open license. They belong to
  Ellm Tree, Inc., along with Sval's name, so a fork of Sval needs a name
  and art of its own.

[LICENSING.md](https://gitlab.com/sval-browser/sval/-/blob/main/LICENSING.md)
lists which license covers which files.

## The source of each release

Each release on the [download page](/download/) comes with an archive of
the source of its Mozilla Public License files. The archive holds Sval's
patches and the files Sval adds to Firefox's own folders, with a README
that names the exact Firefox commit the release builds on.

## Report a problem

To report a problem or ask for a feature, open an issue in Sval's
[issue tracker](https://gitlab.com/sval-browser/sval/-/issues). To report a
problem without a GitLab account,
[send feedback](/docs/how-to/troubleshooting/send-feedback/) from inside
Sval.

If you find a security problem, don't open an issue, because everyone can
read the tracker. Email [security@sval.app](mailto:security@sval.app)
instead. Say what you found, which version of Sval and which platform you
use, and the steps that show the problem.

## Send a change

Sval takes changes as merge requests on GitLab.
[CONTRIBUTING.md](https://gitlab.com/sval-browser/sval/-/blob/main/CONTRIBUTING.md)
covers the rules every change follows, and how to test your change before
you send it.

You don't sign a contributor license agreement. Your change comes in under
the license of the files it touches, and you keep the copyright in what you
wrote. Because every contributor keeps their copyright, nobody can take
Sval's code closed later.

## Related pages

- [Send feedback](/docs/how-to/troubleshooting/send-feedback/)
- [Check a download](/docs/how-to/updates/check-a-download/)
