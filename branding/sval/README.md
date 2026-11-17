# Sval branding assets

The art in this directory is Sval's final brand art, drawn from scratch.
None of the art here is Mozilla's: `scripts/branding-inventory.sh` compares every file
against every file in upstream's branding directories and passes. One piece is
still missing, the macOS 26 layered icon (below).

## Sources

- `src/masters/` holds the masters. Each file name starts with its item number
  in the brand brief:
  vector SVGs for the icons (01-03, 05-07), the wordmarks (04), the menu
  glyphs (08) and the Windows installer bitmaps (10-11), and PNGs for the
  raster art whose layout or copy is baked in (09, 12-14). Each PNG also has
  the SVG it was drawn from.
- `src/sval-art.js` is the deterministic generator every master comes from.
  Its `icon()` takes `{ unplated: true }`, which drops the night plate and
  the starfield, and `{ unplated: true, light: true }`, the variant for a
  light taskbar; the generator renders the two unplated msix tiles from them. Change the
  art there, regenerate the masters, then run the generator.
- `src/icon.svg` is a copy of `01-app-icon.svg`, the app icon's source.

## Generating the outputs

    ./scripts/generate-branding.sh

It renders every image the build ships from the masters with `rsvg-convert`,
at the size of upstream's file of the same name, and fails if a raster master
no longer matches. App-icon sizes follow the masters' tiers: 48 px and up from
`01-app-icon.svg`, 32 px from `02-app-icon-small-32.svg`, 16 px from
`02-app-icon-small-16.svg`. The 16 and 32 px `newtab` and `newwindow` glyphs
render at 1:1. It needs macOS (`iconutil`, `sips`, `hdiutil`), `rsvg-convert`
and `node`, and installs the `ds_store` and `mac_alias` Python packages into
`build/branding-venv`. Its outputs are byte-for-byte reproducible.

It produces (see the script for the exact list):

- PNGs: the toolbar and window icons (`default*.png`), the Windows Visual
  Elements tiles, the About-dialog logos, every `msix/Assets/*.png`, the
  iPhone app icon's three layers (`ios/*.png`),
  `content/about.png` and the DMG window background (`background.png`, 144 dpi)
- Multi-resolution `.ico` files with upstream's frame sizes, as 32-bit bitmaps
  below 256 px and PNG at 256 px
- `.icns` files from 16 to 1024 px, through `iconutil`: `firefox.icns` (the
  app icon), `document.icns` and `disk.icns` (the DMG volume icon)
- The NSIS installer bitmaps, 24-bit: `wizHeader.bmp`, `wizHeaderRTL.bmp` and
  `wizWatermark.bmp`, at three times upstream's size. The installer scales
  each to its control, which grows with the display's scale, so it only ever
  shrinks them up to 300%
- `7zSD.Win32.sfx` and `7zSD.ARM64.sfx`, Mozilla's 7-Zip stubs for the full
  installer's outer .exe, with Sval's app icon and names in their resources
  (`scripts/pe_resources.py`)
- `stubinstaller/bgstub.jpg`, through `sips` at quality 90
- `dsstore`, the DMG window's Finder layout. `background.png` is an
  840x560-point canvas with the composition in its top-left 720x440 points.
  `Sval.app` sits at (180, 220) and the `/Applications` link at (540, 220), at
  the two ends of the arrow. The window's content area is 840x560 points even
  with Finder's global path and status bars shown, and the hidden
  `.background` and `.VolumeIcon.icns`, which Finder shows when
  `AppleShowAllFiles` is on, sit inside it in the right-hand bleed, so no
  Finder setting produces a scrollbar
- The SVGs shipped as SVG: `content/about-logo.svg`, `content/document_pdf.svg`,
  `content/about-wordmark.svg` (the light-on-dark wordmark, for the About
  dialog's dark background) and `content/firefox-wordmark.svg` (the
  single-colour `context-fill` wordmark, which the new-tab and private-browsing
  pages tint for their theme)

Shipped files carry no C2PA provenance metadata; the masters keep theirs.

These are edited by hand, because they are text rather than art:

- `content/aboutDialog.css`, upstream's stylesheet (MPL header retained) with
  Sval's layout and colours for the About dialog.
- `stubinstaller/installing_page.css`, upstream's stub installer stylesheet
  (MPL header retained) with the progress bar in Sval's colours.
  `stubinstaller/profile_cleanup_page.css` is upstream's unchanged: it holds
  only layout.
- `sval.VisualElementsManifest.xml` and
  `sval-private-browsing.VisualElementsManifest.xml`, upstream's
  `firefox.VisualElementsManifest.xml` and
  `private_browsing.VisualElementsManifest.xml` with `BackgroundColor` set.
  Each is named for the executable it styles.

## The macOS 26 layered icon

Sval ships no `Assets.car`. That file is a compiled asset catalog holding the
layered app icon macOS 26 draws, built in Apple's Icon Composer and compiled
by Xcode's `actool`. It is item 15 in the brand brief's numbering, which
`src/masters/` follows. `patches/no-mozilla-asset-catalog.patch`
removes it from the bundle step in `browser/app/Makefile.in` and from
`browser/installer/package-manifest.in`. With no catalog, macOS takes the icon
from `CFBundleIconFile`, which is `firefox.icns`, and macOS 26 draws it inside
the standard rounded-square plate.

To ship it: build the `.icon` in Icon Composer from the layers `sval-art.js`
draws (the night background and starfield, the moon, the rim light, the "S"
with its shadow), compile it to `Assets.car`
with Xcode, add the file here, and drop the patch.

## Licensing

The brand art is reserved: `LICENSE` in this directory lists it and says when
it may be redistributed. The rest of
this directory is code. Sval's own files, `src/sval-art.js` among them, are
licensed under AGPL-3.0-only with the Sval App Store Permission. The files copied from Mozilla's
branding stay under MPL 2.0 and keep Mozilla's header; the repository's
`REUSE.toml` lists them.

## Verifying the generator

    ./scripts/generate-branding.sh
    git status --short branding/sval
    ./scripts/branding-inventory.sh

A clean `git status` after regenerating shows that every generated file is
reproducible from the masters, and the inventory gate reports nothing of
Mozilla's.
