# 0120. The code is open; the name and art are Sval's

**Status:** Accepted on 2026-10-17.

## Context

AGPL-3.0 lets anyone fork Sval (0111, 0119), and grants no rights to its name
or art. Something must still stop a modified build, or a scam app, presenting
itself as Sval. Mozilla's policy does this for Firefox, and Sval follows it as a
modified Firefox.

Mozilla's policy also once required its approval for any patched build that
kept the name. Debian, which applies its own security backports, renamed
Firefox to Iceweasel from 2006 to 2016 rather than wait for that approval.
Linux is a v1 platform for Sval (0094), so its packagers must be able to keep
the name.

## Decision

The policy, published as `TRADEMARKS.md` at the repository root:

1. **Code.** Anyone may fork Sval under AGPL-3.0. The policy covers only the
   name and the art (`branding/sval/LICENSE`).
2. **Unmodified builds** may be redistributed under the name and with the art,
   by mirrors and package managers among others.
3. **Linux distributions** may keep the name and art with build and
   integration patches, such as system libraries and sandboxing, provided the
   browser behaves as Sval does.
4. **A modified version** takes its own name and replaces all of the art. It
   may say it is "based on Sval" alongside an equally prominent statement that
   it is not affiliated with Sval.
5. **Referring to sval.** Anyone may use the name, and the unmodified logo, to
   refer to Sval itself: an importer's "Import from Sval", a list of compatible
   software, a review. Never as their own product's name or icon, nor in a way
   that implies Sval endorses them.
6. **Update servers.** A fork uses its own update server and signing keys,
   never `download.sval.app` (0110), so Sval's updates cannot overwrite
   it and its users never reach Sval's servers.
7. **Community use**, such as fan sites and groups, may use the name if it
   does not imply it is official. A domain name, an app store listing or
   merchandise for sale needs permission.

## Consequences

- `TRADEMARKS.md` publishes it, and `branding/sval/LICENSE` points to it.
- A fork's update configuration is part of renaming it. Sval's build should
  make the update URL and signing keys one place to change.
