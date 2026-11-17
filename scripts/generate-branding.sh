#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Generate every image in branding/sval from Sval's brand masters,
# branding/sval/src/masters/.
#
# Re-run it after each upstream rebase: a hand-exported file goes stale or
# wrong-sized when Mozilla changes a manifest.
#
# The masters are final art: vector SVGs for the icons, glyphs, wordmarks and
# installer bitmaps, and PNGs for the raster pieces whose copy or layout is
# baked in (masters 09 and 12 to 14). src/sval-art.js is the generator they
# come from. Every output's size and layout comes from upstream's file of the
# same name: PNG dimensions from the IHDR chunk, the frame list of each .ico,
# the header of each .bmp (scaled as BMP_SCALE says), the dimensions and
# density of bgstub.jpg. So sizes stay correct if upstream
# changes a tile size, and a master that stops matching fails loudly.
#
# App-icon sizes follow the masters' size tiers: 48 px and up render
# 01-app-icon.svg, 32 px renders 02-app-icon-small-32.svg (no stars), 16 px
# renders 02-app-icon-small-16.svg (the "S" alone). The 16 and 32 px menu
# glyphs (08-*) are pixel-aligned and render at 1:1.
#
# Formats and tools:
#   SVG -> PNG      rsvg-convert (librsvg). ImageMagick's built-in SVG
#                   renderer draws these masters wrongly.
#   unplated PNG    node runs src/sval-art.js with its unplated flag, then
#                   rsvg-convert renders the result
#   PNG, ICO, BMP   written here with the Python standard library
#   SFX             Mozilla's installer stubs, their resources rewritten by
#                   scripts/pe_resources.py
#   ICNS            iconutil, from a generated .iconset
#   JPEG            sips, from the PNG master
#   dsstore         the ds_store and mac_alias packages (the library dmgbuild
#                   uses), installed into build/branding-venv, with the
#                   background alias taken from a scratch HFS+ volume that
#                   hdiutil creates and mounts under the DMG's volume name
# iconutil, sips and hdiutil ship with macOS, so the generator needs a Mac.
#
# The outputs are byte-for-byte reproducible: sval-art.js uses fixed seeds,
# rsvg-convert and the PNG encoder are deterministic, and the dsstore's
# volume and file dates are fixed. Shipped copies of the masters carry no
# C2PA provenance metadata; the masters in src/masters keep theirs.
#
# Assets.car has no generator: it is a compiled asset catalog, and only
# Xcode's actool writes one. Sval ships none, and
# patches/no-mozilla-asset-catalog.patch stops the build copying it.
#
# Usage: ./scripts/generate-branding.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVAL="$REPO_ROOT/branding/sval"
UPSTREAM="$REPO_ROOT/build/firefox/browser/branding/unofficial"

if [[ ! -d "$UPSTREAM" ]]; then
  echo "error: no upstream checkout at $UPSTREAM — run scripts/fetch-upstream.sh first" >&2
  exit 1
fi
for tool in iconutil sips hdiutil; do
  if ! command -v "$tool" >/dev/null; then
    echo "error: $tool not found — the generator needs macOS" >&2
    exit 1
  fi
done
for tool in rsvg-convert node; do
  if ! command -v "$tool" >/dev/null; then
    echo "error: $tool not found — brew install librsvg node" >&2
    exit 1
  fi
done

# The DMG background's bottom-edge colour, passed from the image step to the
# dsstore step.
EDGE_FILE="$(mktemp)"
trap 'rm -f "$EDGE_FILE"' EXIT
SVAL="$SVAL" UPSTREAM="$UPSTREAM" EDGE_FILE="$EDGE_FILE" SCRIPTS="$REPO_ROOT/scripts" python3 <<'PY'
import os, re, shutil, struct, subprocess, sys, tempfile, zlib

sval = os.environ["SVAL"]
upstream = os.environ["UPSTREAM"]
tree = os.path.normpath(os.path.join(upstream, "..", "..", ".."))
sys.path.insert(0, os.environ["SCRIPTS"])
import pe_resources  # noqa: E402
masters = os.path.join(sval, "src", "masters")


def master(name):
    return os.path.join(masters, name)


def rsvg(svg, size=None):
    """PNG bytes of an SVG rendered by librsvg; size None renders 1:1."""
    cmd = ["rsvg-convert"]
    if size:
        cmd += ["-w", str(size), "-h", str(size)]
    return subprocess.run(cmd + [svg], check=True, capture_output=True).stdout


def app_icon(px, base="01-app-icon.svg"):
    """The app icon at px pixels, from the master for that size tier."""
    if px >= 48:
        return rsvg(master(base), px)
    assert px in (16, 32), f"no app-icon master for {px} px"
    return rsvg(master(f"02-app-icon-small-{px}.svg"), px)


def decode_png(data):
    """(width, height, top-down RGBA rows) of an 8-bit, non-interlaced RGBA
    or RGB PNG."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    o, idat = 8, b""
    while o < len(data):
        n, tag = struct.unpack(">I4s", data[o:o + 8])
        body = data[o + 8:o + 8 + n]
        if tag == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and ctype in (2, 6) and interlace == 0, "unsupported PNG"
        elif tag == b"IDAT":
            idat += body
        o += 12 + n
    bpp = 4 if ctype == 6 else 3
    raw, stride, rows, prev = zlib.decompress(idat), w * bpp, [], bytearray(w * bpp)
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b, c = prev[i], prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        if bpp == 3:
            line = bytearray(b"".join(bytes(line[i:i + 3]) + b"\xff" for i in range(0, stride, 3)))
        rows.append(bytes(line))
    return w, h, rows


def png_bytes(w, h, rows, ppm=None):
    """RGBA PNG. ppm sets the pHYs density in pixels per metre."""
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    raw = b"".join(b"\x00" + r for r in rows)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    if ppm:
        out += chunk(b"pHYs", struct.pack(">IIB", ppm, ppm, 1))
    return out + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def read_png_dims(path):
    with open(path, "rb") as f:
        head = f.read(24)
    assert head[:8] == b"\x89PNG\r\n\x1a\n", f"not a PNG: {path}"
    return struct.unpack(">II", head[16:24])


def png_master(name, upstream_rel):
    """A raster master, decoded, checked against upstream's dimensions."""
    w, h, rows = decode_png(open(master(name), "rb").read())
    if upstream_rel.endswith(".png"):
        want = read_png_dims(os.path.join(upstream, upstream_rel))
    elif upstream_rel.endswith(".bmp"):
        head = open(os.path.join(upstream, upstream_rel), "rb").read(26)
        want = struct.unpack("<ii", head[18:26])
        want = (want[0], abs(want[1]))
    else:
        props = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight",
                                os.path.join(upstream, upstream_rel)],
                               check=True, capture_output=True, text=True).stdout
        want = (int(re.search(r"pixelWidth: (\d+)", props).group(1)),
                int(re.search(r"pixelHeight: (\d+)", props).group(1)))
    assert (w, h) == want, f"{name} is {w}x{h}; upstream's {upstream_rel} is {want[0]}x{want[1]}"
    return w, h, rows


def flatten(rows, w):
    """RGB over white, for formats with no alpha."""
    out = []
    for r in rows:
        line = bytearray()
        for x in range(w):
            red, green, blue, a = r[4 * x:4 * x + 4]
            line.extend(((c * a + 255 * (255 - a)) // 255 for c in (red, green, blue)))
        out.append(bytes(line))
    return out


def bmp24_bytes(w, h, rows, ppm):
    """BITMAPINFOHEADER, 24-bit BGR, bottom-up, rows padded to 4 bytes: the
    layout NSIS's Modern UI reads for header and welcome-page images."""
    stride = (w * 3 + 3) & ~3
    pixels = bytearray()
    for r in reversed(flatten(rows, w)):
        line = bytearray()
        for x in range(w):
            red, green, blue = r[3 * x:3 * x + 3]
            line.extend((blue, green, red))
        pixels.extend(line + b"\x00" * (stride - len(line)))
    info = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(pixels), ppm, ppm, 0, 0)
    head = struct.pack("<2sIHHI", b"BM", 14 + len(info) + len(pixels), 0, 0, 14 + len(info))
    return head + info + bytes(pixels)


def ico_dib_bytes(png):
    """An ICO frame as a 32-bit DIB: BITMAPINFOHEADER with doubled height,
    BGRA rows bottom-up, then a 1-bit AND mask. Alpha carries transparency;
    the mask marks fully transparent pixels for readers that ignore alpha."""
    w, h, rows = decode_png(png)
    pixels, mask = bytearray(), bytearray()
    mstride = ((w + 31) // 32) * 4
    for r in reversed(rows):
        bits = bytearray(mstride)
        for x in range(w):
            red, green, blue, alpha = r[4 * x:4 * x + 4]
            pixels.extend((blue, green, red, alpha))
            if alpha == 0:
                bits[x // 8] |= 0x80 >> (x % 8)
        mask.extend(bits)
    info = struct.pack("<IiiHHIIiiII", 40, w, 2 * h, 1, 32, 0, len(pixels) + len(mask), 0, 0, 0, 0)
    return info + bytes(pixels) + bytes(mask)


def read_ico_frames(path):
    """[(size, is_png)] for each frame of an .ico, in file order."""
    data = open(path, "rb").read()
    _, kind, count = struct.unpack("<HHH", data[:6])
    assert kind == 1, f"not an icon: {path}"
    frames = []
    for i in range(count):
        wb, hb, _, _, _, _, _, off = struct.unpack("<BBBBHHII", data[6 + 16 * i:22 + 16 * i])
        assert (wb or 256) == (hb or 256), f"non-square frame in {path}"
        frames.append((wb or 256, data[off:off + 4] == b"\x89PNG"))
    return frames


def ico_bytes(frames, render):
    """Multi-resolution ICO with upstream's frame list. Each frame keeps the
    encoding upstream uses at that size: PNG for 256px frames, a 32-bit DIB
    below that. render(size) returns the frame as PNG bytes."""
    payloads = []
    for size, is_png in frames:
        png = render(size)
        assert read_png_dims_bytes(png) == (size, size)
        payloads.append(png if is_png else ico_dib_bytes(png))
    out = struct.pack("<HHH", 0, 1, len(frames))
    off = 6 + 16 * len(frames)
    for (size, _), p in zip(frames, payloads):
        b = size if size < 256 else 0
        out += struct.pack("<BBBBHHII", b, b, 0, 0, 1, 32, len(p), off)
        off += len(p)
    return out + b"".join(payloads)


def read_png_dims_bytes(data):
    return struct.unpack(">II", data[16:24])


def strip_metadata(svg):
    """A master's SVG without its C2PA <metadata> block and namespace."""
    svg = re.sub(r"<metadata>.*?</metadata>", "", svg, flags=re.S)
    return svg.replace(' xmlns:c2pa="http://c2pa.org/manifest"', "")


def write(rel, data, what):
    path = os.path.join(sval, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(f"generated {rel} ({what})")


# --- PNG targets rendered from SVG masters, at the dimensions of upstream's
# file of the same name. msix/Assets is copied into the msix package by
# python/mozbuild/mozbuild/repackaging/msix.py.
svg_png_targets = {
    "default16.png": "01-app-icon.svg",
    "default32.png": "01-app-icon.svg",
    "default48.png": "01-app-icon.svg",
    "default64.png": "01-app-icon.svg",
    "default128.png": "01-app-icon.svg",
    "VisualElements_150.png": "01-app-icon.svg",
    "VisualElements_70.png": "01-app-icon.svg",
    "content/about-logo.png": "01-app-icon.svg",
    "content/about-logo@2x.png": "01-app-icon.svg",
    "msix/Assets/LargeTile.scale-200.png": "01-app-icon.svg",
    "msix/Assets/MedTile.scale-200.png": "01-app-icon.svg",
    "msix/Assets/SmallTile.scale-200.png": "01-app-icon.svg",
    "msix/Assets/Square150x150Logo.scale-200.png": "01-app-icon.svg",
    "msix/Assets/Square44x44Logo.scale-200.png": "01-app-icon.svg",
    "msix/Assets/Square44x44Logo.targetsize-256.png": "01-app-icon.svg",
    "msix/Assets/StoreLogo.scale-200.png": "01-app-icon.svg",
    "PrivateBrowsing_150.png": "03-app-icon-private.svg",
    "PrivateBrowsing_70.png": "03-app-icon-private.svg",
    "content/about-logo-private.png": "03-app-icon-private.svg",
    "content/about-logo-private@2x.png": "03-app-icon-private.svg",
}
for rel, base in svg_png_targets.items():
    w, h = read_png_dims(os.path.join(upstream, rel))
    assert w == h, f"{rel}: expected a square tile"
    write(rel, app_icon(w, base) if base == "01-app-icon.svg" else rsvg(master(base), w),
          f"{w}x{h} from {base if w >= 48 else 'its size tier'}")

w, h = read_png_dims(os.path.join(upstream, "msix/Assets/Document44x44.png"))
write("msix/Assets/Document44x44.png", rsvg(master("05-document.svg"), w), f"{w}x{h} from 05-document.svg")

# The unplated tile variants sit straight on the Windows taskbar, so they
# need a transparent background: sval-art.js renders the icon without its
# plate and starfield, and its light variant (a deeper "S" with a thin navy
# outline, no glow) for the light taskbar.
work = tempfile.mkdtemp()
try:
    unplated_svg = os.path.join(work, "unplated.svg")
    unplated_light_svg = os.path.join(work, "unplated-light.svg")
    unplated_private_svg = os.path.join(work, "unplated-private.svg")
    art = os.path.join(sval, "src", "sval-art.js")
    subprocess.run(["node", "--input-type=module", "-e",
                    "const art = await import(process.argv[1]);"
                    "const { writeFileSync } = await import('node:fs');"
                    "writeFileSync(process.argv[2], art.icon('full', false, { unplated: true }));"
                    "writeFileSync(process.argv[3], art.icon('full', false, { unplated: true, light: true }));"
                    "writeFileSync(process.argv[4], art.icon('full', true, { unplated: true }));"
                    "for (const [i, layer] of ['back', 'globe', 'letter'].entries())"
                    "  writeFileSync(process.argv[5 + i], art.icon('full', false, { layer }));",
                    "file://" + art, unplated_svg, unplated_light_svg, unplated_private_svg,
                    *(os.path.join(work, f"{layer}.svg") for layer in ("back", "globe", "letter"))], check=True)
    # The iPhone app's icon is layered, so iOS draws its glass between the
    # layers: the plate and stars, the globe, and the "S", each at the
    # 1024-point canvas iOS's icon format is drawn on.
    for layer in ("back", "globe", "letter"):
        write(f"ios/{layer}.png", rsvg(os.path.join(work, f"{layer}.svg"), 1024), f"1024x1024, the icon's {layer} layer")
    # The home and private-window pages draw the mark straight on their own
    # background, so they ship the unplated icons as SVG: the light variant on
    # the light home page, the dark one on the dark home page, and the private
    # one on the private-window page.
    for rel, svg in (("content/app-icon-unplated.svg", unplated_svg),
                     ("content/app-icon-unplated-light.svg", unplated_light_svg),
                     ("content/app-icon-private-unplated.svg", unplated_private_svg)):
        write(rel, open(svg, "rb").read(), "unplated, from sval-art.js")
    for rel, svg in (("msix/Assets/Square44x44Logo.altform-unplated_targetsize-256.png", unplated_svg),
                     ("msix/Assets/Square44x44Logo.altform-lightunplated_targetsize-256.png", unplated_light_svg)):
        w, h = read_png_dims(os.path.join(upstream, rel))
        png = rsvg(svg, w)
        _, _, rows = decode_png(png)
        assert rows[0][3] == 0 and rows[-1][-1] == 0, f"{rel}: corners are not transparent"
        write(rel, png, f"{w}x{h}, unplated, transparent")
finally:
    shutil.rmtree(work)

# --- Raster masters, re-encoded without their provenance chunk.
w, h, rows = png_master("14-wide-tile.png", "msix/Assets/Wide310x150Logo.scale-200.png")
write("msix/Assets/Wide310x150Logo.scale-200.png", png_bytes(w, h, rows), f"{w}x{h} from 14-wide-tile.png")
w, h, rows = png_master("13-about-background.png", "content/about.png")
write("content/about.png", png_bytes(w, h, rows), f"{w}x{h} from 13-about-background.png")
# The DMG window background, at 144 dpi so Finder draws it at half its pixel
# size and it stays sharp on a Retina display. Its size is set by the window
# layout in the dsstore below, not by upstream's file: an 840x560-point canvas
# with the composition (the icons, the arrow and the copy) in its top-left
# 720x440 points, and bleed to the right and below for windows whose content
# area is larger.
CANVAS = (1680, 1120)
w, h, rows = decode_png(open(master("09-macos-installer-background.png"), "rb").read())
assert (w, h) == CANVAS, f"09-macos-installer-background.png is {w}x{h}; expected {CANVAS[0]}x{CANVAS[1]}"
# A window taller than the canvas shows the dsstore's background colour below
# it, so that colour is the canvas's bottom row, averaged.
edge = [sum(rows[-1][4 * x + c] for x in range(w)) // w for c in range(3)]
with open(os.environ["EDGE_FILE"], "w") as f:
    f.write(" ".join(map(str, edge)))
write("background.png", png_bytes(w, h, rows, ppm=5669), f"{w}x{h}, 144 dpi")

# --- ICO targets, with upstream's frame list. browser/app/moz.build compiles
# firefox, document, newwindow, newtab, pbmode and document_pdf into the
# executable's resources (splash.rc); browser/app/pbproxy/moz.build compiles
# pbmode; browser/installer/windows/Makefile.in copies firefox64 for the stub
# installer.
ico_sources = {
    "firefox": app_icon,
    "firefox64": app_icon,
    "document": lambda px: rsvg(master("05-document.svg"), px),
    "document_pdf": lambda px: rsvg(master("06-document-pdf.svg"), px),
    "pbmode": lambda px: rsvg(master("03-app-icon-private.svg"), px),
    "newtab": lambda px: rsvg(master(f"08-newtab-{px}.svg")),
    "newwindow": lambda px: rsvg(master(f"08-newwindow-{px}.svg")),
}
for name, render in ico_sources.items():
    frames = read_ico_frames(os.path.join(upstream, f"{name}.ico"))
    sizes = "/".join(f"{s}{'p' if p else ''}" for s, p in frames)
    write(f"{name}.ico", ico_bytes(frames, render), f"frames {sizes}, p = PNG")

# --- BMP targets for the NSIS installer and uninstaller
# (browser/installer/windows/nsis/installer.nsi: MUI_HEADERIMAGE_BITMAP,
# MUI_HEADERIMAGE_BITMAP_RTL, MUI_WELCOMEFINISHPAGE_BITMAP).
# The installer is DPI aware (ManifestDPIAware), so its controls grow with
# the display's scale, and showWelcome and preOptions redraw each bitmap at
# its control's size through SetStretchedImageOLE
# (toolkit/mozapps/installer/windows/nsis/common.nsh), a HALFTONE StretchBlt.
# A bitmap at upstream's 96 dpi size is enlarged on any scaled display and
# looks blocky. These are rendered from the vector masters at BMP_SCALE times
# upstream's size, in upstream's aspect ratio, so the stretch only ever
# reduces them up to 300% scale, Windows' largest common setting.
BMP_SCALE = 3
for rel, name in (("wizHeader.bmp", "10-wizHeader.svg"),
                  ("wizHeaderRTL.bmp", "10-wizHeaderRTL.svg"),
                  ("wizWatermark.bmp", "11-wizWatermark.svg")):
    head = open(os.path.join(upstream, rel), "rb").read(54)
    _, up_w, up_h, _, bpp, comp, _, ppm, _, _, _ = struct.unpack("<IiiHHIIiiII", head[14:54])
    assert (bpp, comp) == (24, 0), f"{rel}: expected an uncompressed 24-bit BMP"
    png = subprocess.run(["rsvg-convert", "-w", str(up_w * BMP_SCALE), "-h", str(abs(up_h) * BMP_SCALE),
                          master(name)], check=True, capture_output=True).stdout
    w, h, rows = decode_png(png)
    assert (w, h) == (up_w * BMP_SCALE, abs(up_h) * BMP_SCALE), f"{name} rendered at {w}x{h}"
    write(rel, bmp24_bytes(w, h, rows, ppm * BMP_SCALE), f"{w}x{h}, 24-bit, from {name}")

# --- The full installer's outer executable: Mozilla's 7-Zip self-extracting
# stub (browser/installer/windows/Makefile.in, SFX_MODULE), with Sval's icon
# in place of Firefox's and Sval's names in its version block. Windows shows
# both for the downloaded installer, before anything inside it runs. The icon
# keeps the frame list of the stub's own setup.ico.
stub_dir = os.path.join(tree, "other-licenses", "7zstub", "firefox")
stub_frames = read_ico_frames(os.path.join(stub_dir, "setup.ico"))
stub_icon = ico_bytes(stub_frames, app_icon)
stub_strings = {
    "CompanyName": "Ellm Tree, Inc.",
    "FileDescription": "Sval Installer",
    "LegalCopyright": "License: MPL 2",
    "ProductName": "Sval",
}
for arch in ("Win32", "ARM64"):
    rel = f"7zSD.{arch}.sfx"
    stub = pe_resources.read_resources(open(os.path.join(stub_dir, rel), "rb").read())
    strings = pe_resources.version_strings(stub)
    assert set(stub_strings) <= set(strings), f"{rel}: version block lacks {set(stub_strings) - set(strings)}"
    strings.update(stub_strings)
    resources = dict(stub)
    pe_resources.set_icon(resources, stub_icon)
    pe_resources.set_version_strings(resources, strings)
    out = pe_resources.write_resources(open(os.path.join(stub_dir, rel), "rb").read(), resources)
    check = pe_resources.read_resources(out)
    assert pe_resources.version_strings(check) == strings, f"{rel}: version block did not round-trip"
    assert {k: v for k, v in check.items() if k not in (3, 14, 16)} == \
        {k: v for k, v in stub.items() if k not in (3, 14, 16)}, f"{rel}: other resources changed"
    write(rel, out, "Mozilla's stub, Sval's icon and version strings")

work = tempfile.mkdtemp()
try:
    # --- ICNS via iconutil. browser/app/Makefile.in copies firefox.icns (the
    # CFBundleIconFile) and document.icns into the app bundle;
    # toolkit/moz.configure gives disk.icns to the DMG packager as the volume
    # icon. An .iconset holds the ten sizes iconutil packs, 16 to 1024 px.
    icns_sources = {
        "firefox.icns": app_icon,
        "document.icns": lambda px: rsvg(master("05-document.svg"), px),
        "disk.icns": lambda px: rsvg(master("07-disk.svg"), px),
    }
    for rel, render in icns_sources.items():
        iconset = os.path.join(work, rel.replace(".icns", ".iconset"))
        os.makedirs(iconset)
        for pt in (16, 32, 128, 256, 512):
            for scale, suffix in ((1, ""), (2, "@2x")):
                with open(os.path.join(iconset, f"icon_{pt}x{pt}{suffix}.png"), "wb") as f:
                    f.write(render(pt * scale))
        icns = os.path.join(work, rel)
        subprocess.run(["iconutil", "-c", "icns", "-o", icns, iconset], check=True)
        write(rel, open(icns, "rb").read(), "iconutil, 16-1024 px")

    # --- JPEG via sips: the stub installer's background
    # (browser/installer/windows/nsis/stub.nsh), drawn under white text, at
    # upstream's density.
    up_jpg = os.path.join(upstream, "stubinstaller", "bgstub.jpg")
    dpi = re.search(r"dpiWidth: ([\d.]+)", subprocess.run(
        ["sips", "-g", "dpiWidth", up_jpg], check=True, capture_output=True, text=True).stdout).group(1)
    w, h, rows = png_master("12-bgstub.png", "stubinstaller/bgstub.jpg")
    src_png = os.path.join(work, "bgstub.png")
    with open(src_png, "wb") as f:
        f.write(png_bytes(w, h, rows))
    out_jpg = os.path.join(work, "bgstub.jpg")
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "90",
                    "-s", "dpiWidth", dpi, "-s", "dpiHeight", dpi,
                    src_png, "--out", out_jpg], check=True, capture_output=True)
    write("stubinstaller/bgstub.jpg", open(out_jpg, "rb").read(), f"{w}x{h}, q90, {float(dpi):g} dpi")
finally:
    shutil.rmtree(work)

# --- SVGs shipped as SVG. about-wordmark.svg is drawn on the About dialog's
# dark background (browser/base/content/aboutDialog.css, #rightBox; Sval's
# content/aboutDialog.css makes it dark), so it is the light-on-dark
# wordmark. firefox-wordmark.svg is drawn on the new-tab page and the
# private-browsing page, light or dark by theme, which tint it through
# -moz-context-properties: fill; the context-fill wordmark takes that tint.
svg_copies = {
    "content/about-logo.svg": "01-app-icon.svg",
    "content/document_pdf.svg": "06-document-pdf.svg",
    "content/about-wordmark.svg": "04-wordmark-light-on-dark.svg",
    "content/firefox-wordmark.svg": "04-wordmark-context-fill.svg",
}
for rel, name in svg_copies.items():
    text = strip_metadata(open(master(name), encoding="utf-8").read())
    write(rel, text.encode("utf-8"), f"from {name}")
# src/icon.svg is a copy of the app icon's master.
shutil.copyfile(master("01-app-icon.svg"), os.path.join(sval, "src", "icon.svg"))
print("generated src/icon.svg (copy of 01-app-icon.svg)")
PY

# --- dsstore: the Finder layout of the DMG window, which
# python/mozbuild/mozbuild/action/make_dmg.py copies to the volume's
# .DS_Store. It is keyed by file name and volume name, so it has to name
# Sval's: the app bundle (MOZ_MACBUNDLE_NAME), the " " link to /Applications
# that python/mozbuild/mozpack/dmg.py creates, and the volume, which
# toolkit/moz.configure names after MOZ_APP_DISPLAYNAME.
# shellcheck disable=SC1091
source "$SVAL/configure.sh"
VENV="$REPO_ROOT/build/branding-venv"
if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --disable-pip-version-check \
  "ds_store==1.3.3" "mac_alias==2.2.3"

SCRATCH="$(mktemp -d)"
MOUNT="$(cd "$SCRATCH" && pwd -P)/mnt"
cleanup() {
  hdiutil detach -quiet "$MOUNT" 2>/dev/null || true
  rm -rf "$SCRATCH" "$EDGE_FILE"
}
trap cleanup EXIT
# A scratch volume laid out as the DMG is, so the background alias resolves
# the way Finder will resolve it on the real volume.
hdiutil create -quiet -size 8m -fs HFS+ -layout NONE \
  -volname "$MOZ_APP_DISPLAYNAME" "$SCRATCH/scratch.dmg"
hdiutil attach -quiet -nobrowse -noverify -noautoopen \
  -mountpoint "$MOUNT" "$SCRATCH/scratch.dmg"
mkdir "$MOUNT/.background"
cp "$SVAL/background.png" "$MOUNT/.background/background.png"

EDGE="$(cat "$EDGE_FILE")" SVAL="$SVAL" MOUNT="$MOUNT" VOLUME="$MOZ_APP_DISPLAYNAME" APP="$MOZ_MACBUNDLE_NAME.app" \
  "$VENV/bin/python" <<'PY'
import datetime, os
from ds_store import DSStore
from mac_alias import Alias

sval, mount = os.environ["SVAL"], os.environ["MOUNT"]
volume, app = os.environ["VOLUME"], os.environ["APP"]
edge = [int(c) for c in os.environ["EDGE"].split()]

alias = Alias.for_file(os.path.join(mount, ".background", "background.png"))
# The scratch volume's dates and mount point would change the bytes on every
# run. Finder matches the alias on the real volume by name and path.
fixed = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
alias.volume.creation_date = fixed
alias.target.creation_date = fixed
alias.volume.posix_path = f"/Volumes/{volume}".encode()

out = os.path.join(sval, "dsstore")
if os.path.exists(out):
    os.remove(out)
# The window has to look right under any Finder settings. Two of them shrink
# or crowd it, and a .DS_Store cannot turn either off:
#  - Finder's global path bar and status bar take 56 points from the content
#    area, whatever bwsp says.
#  - With AppleShowAllFiles on, Finder shows .background and .VolumeIcon.icns,
#    and an item outside the content area adds a scrollbar.
# So WindowBounds, which is the window frame, is 840x648: the 32-point title
# bar, 56 points of bars and an 840x560 content area, the size of the
# background canvas. Without the bars the content area is 840x616 and the
# background colour, the canvas's bottom-edge colour, fills the strip below.
# The icons sit at the ends of the arrow in the canvas's top-left 720x440
# composition; the hidden items sit in the right-hand bleed, far enough in
# (x = 740) that their frames stay inside the window. Measured on macOS 26:
# at x = 760 they add a horizontal scrollbar, at 740 they do not.
with DSStore.open(out, "w+") as d:
    d["."]["vSrn"] = ("long", 1)
    d["."]["bwsp"] = {
        "ShowStatusBar": False,
        "ShowPathbar": False,
        "ShowToolbar": False,
        "ShowTabView": False,
        "ContainerShowSidebar": False,
        "ShowSidebar": False,
        "WindowBounds": "{{200, 120}, {840, 648}}",
    }
    d["."]["icvp"] = {
        "viewOptionsVersion": 1,
        "backgroundType": 2,
        "backgroundImageAlias": alias.to_bytes(),
        "backgroundColorRed": edge[0] / 255,
        "backgroundColorGreen": edge[1] / 255,
        "backgroundColorBlue": edge[2] / 255,
        "iconSize": 128.0,
        "textSize": 12.0,
        "gridSpacing": 100.0,
        "gridOffsetX": 0.0,
        "gridOffsetY": 0.0,
        "arrangeBy": "none",
        "labelOnBottom": True,
        "showItemInfo": False,
        "showIconPreview": True,
    }
    d[app]["Iloc"] = (180, 220)
    d[" "]["Iloc"] = (540, 220)
    d[".background"]["Iloc"] = (740, 150)
    d[".VolumeIcon.icns"]["Iloc"] = (740, 330)
print(f"generated dsstore (volume {volume!r}, {app}, background alias)")
PY
echo "done"
