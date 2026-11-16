# Sval's licenses

Sval is made of files under different licenses. Each file states its own, in
a notice at its top or, for a file that cannot carry one, in REUSE.toml. The
layout follows the REUSE specification (https://reuse.software/spec-3.3/),
and LICENSES/ holds the full text of every license named.

- Files written for Sval, by Ellm Tree, Inc. or a contributor, are licensed
  under the GNU Affero General Public License, version 3 only:
  LICENSES/AGPL-3.0-only.txt, with the Sval App Store Permission, an
  additional permission under its section 7:
  LICENSES/AdditionRef-sval-app-store.txt (SPDX-License-Identifier:
  AGPL-3.0-only WITH AdditionRef-sval-app-store). A contribution to these
  files comes in under the same terms, with no contributor license agreement,
  and its author keeps the copyright (CONTRIBUTING.md).

- Files that are Mozilla's code, or are derived from it, are licensed under
  the Mozilla Public License 2.0: LICENSES/MPL-2.0.txt (MPL-2.0). These are
  the patches in patches/, the files in branding/sval/ copied from Firefox's
  branding, the search configuration that carries Mozilla's engine records,
  the Linux package templates in packaging/linux/, and Mozilla's extensions
  bookmarks test that Sval runs. REUSE.toml lists each one, and each keeps
  Mozilla's header.

- The docs pages and release notes in website/src/content/ are licensed
  under Creative Commons Attribution-ShareAlike 4.0:
  LICENSES/CC-BY-SA-4.0.txt. The rest of the website is not licensed:
  LICENSES/LicenseRef-sval-website.txt.

- Sval's brand art is reserved, as branding/sval/LICENSE sets out. Unmodified
  copies of Sval may carry it; modified versions must replace it.

- The emoji data in chrome/browser/components/sval/SvalEmojiData.sys.mjs is
  also under the Unicode License v3: LICENSES/Unicode-3.0.txt.

- The search engines' and browsers' logos listed there belong to their owners:
  LICENSES/LicenseRef-third-party-logos.txt.

- The Outfit typeface in chrome/browser/components/sval/home/Outfit.ttf is
  The Outfit Project Authors' work, under the SIL Open Font License 1.1:
  LICENSES/OFL-1.1.txt.

- The map of trackers' owners in chrome/browser/components/sval/tracker-owners/
  includes AdGuard's companiesdb, under Creative Commons Attribution-ShareAlike
  4.0 (LICENSES/CC-BY-SA-4.0.txt), and hosts from the Public Suffix List,
  under the Mozilla Public License 2.0. REUSE.toml names each file.

- The icons in chrome/browser/components/sval/'s icons/, header-icons/,
  protection-icons/, dialog-icons/ and notification-icons/ are Lucide's
  (https://lucide.dev), Copyright (c) 2026 Lucide Icons and Contributors,
  under the ISC License: LICENSES/ISC.txt. Those Lucide derives from Feather
  are under Feather's MIT License, Copyright (c) 2013 Cole Bemis:
  LICENSES/MIT.txt. REUSE.toml names each file.

The Firefox source that scripts/fetch-upstream.sh fetches into build/ is not
part of this repository. Mozilla licenses it, and its own LICENSE says how.

Required Notice: Copyright 2026 Ellm Tree, Inc. (https://sval.app)
