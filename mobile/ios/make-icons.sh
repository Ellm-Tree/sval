#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

# Writes Generated/Icons.xcassets from the desktop's own glyphs, so the app
# draws the same shields the desktop does. XcodeGen runs it before it
# writes the project (project.yml, preGenCommand).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
icons="$here/../../chrome/browser/components/sval/protection-icons"
out="$here/Generated/Icons.xcassets"
rm -rf "$out"
mkdir -p "$out"
printf '{"info":{"author":"xcode","version":1}}\n' > "$out/Contents.json"
header="$here/../../chrome/browser/components/sval/header-icons"
sync="$here/../../chrome/browser/components/sval/sync-icons"
# Firefox paints its chrome icons through context-fill, which an asset
# catalog doesn't know: the glyphs are drawn in black and tinted as
# templates instead.
for path in "$icons/pr-shield.svg" "$icons/pr-shield-fill.svg" "$icons/pr-shield-off.svg" \
    "$icons/sc-shield-plain.svg" "$icons/pr-ads.svg" "$icons/sc-external.svg" \
    "$header/back.svg" "$header/forward.svg" "$header/reload.svg" "$header/stop.svg" \
    "$sync/satellite.svg" "$sync/badge-bang.svg" "$sync/badge-x.svg" "$sync/badge-pause.svg" \
    "$header/javascript.svg" "$header/javascript-off.svg" "$header/media.svg" "$header/split.svg" "$header/private.svg" \
    "$here/../../chrome/browser/components/sval/workspace-isolated.svg" \
    "$here/../../chrome/browser/components/sval/agent-robot.svg" \
    "$here/../../chrome/browser/components/sval/device-phone.svg" \
    "$here/../../chrome/browser/components/sval/device-tablet.svg"; do
  name=$(basename "$path" .svg)
  set="$out/$name.imageset"
  mkdir -p "$set"
  sed -e 's/stroke="context-fill\( black\)\{0,1\}"/stroke="#000"/' -e 's/ stroke-opacity="context-fill-opacity"//' \
    -e 's/fill="context-fill\( black\)\{0,1\}"/fill="#000"/' -e 's/ fill-opacity="context-fill-opacity"//' \
    "$path" > "$set/$name.svg"
  cat > "$set/Contents.json" <<JSON
{"images":[{"filename":"$name.svg","idiom":"universal"}],"info":{"author":"xcode","version":1},
 "properties":{"preserves-vector-representation":true,"template-rendering-intent":"template"}}
JSON
done

# Each agent app's mark (SvalAgentBrands.sys.mjs), tinted as the robot is.
for path in "$here/../../chrome/browser/components/sval/agent-brands/"*.svg; do
  name=agent-brand-$(basename "$path" .svg)
  set="$out/$name.imageset"
  mkdir -p "$set"
  sed -e 's/fill="context-fill\( black\)\{0,1\}"/fill="#000"/' -e 's/ fill-opacity="context-fill-opacity"//' \
    "$path" > "$set/$name.svg"
  cat > "$set/Contents.json" <<JSON
{"images":[{"filename":"$name.svg","idiom":"universal"}],"info":{"author":"xcode","version":1},
 "properties":{"preserves-vector-representation":true,"template-rendering-intent":"template"}}
JSON
done

# Art drawn as it is, not tinted: the app icon as the desktop's About page
# shows it, and the home page's starfield.
art() {
  name=$1 path=$2
  set="$out/$name.imageset"
  mkdir -p "$set"
  file=$(basename "$path")
  cp "$path" "$set/$file"
  cat > "$set/Contents.json" <<JSON
{"images":[{"filename":"$file","idiom":"universal"}],"info":{"author":"xcode","version":1},
 "properties":{"preserves-vector-representation":true,"template-rendering-intent":"original"}}
JSON
}
art app-icon "$here/../../branding/sval/content/about-logo@2x.png"
art starfield "$here/../../chrome/browser/components/sval/home/starfield-stars-only-1920x1080.svg"
art mark-private "$here/../../branding/sval/content/app-icon-private-unplated.svg"
art mark "$here/../../branding/sval/content/app-icon-unplated.svg"
art mark-light "$here/../../branding/sval/content/app-icon-unplated-light.svg"

# The home screen icon, in the layered format iOS draws Liquid Glass from:
# the plate and its stars, then the globe and the "S" as glass, each a
# group of its own so the system lights and shadows them apart. Groups and
# layers are listed front to back.
icon="$here/Generated/AppIcon.icon"
rm -rf "$icon"
mkdir -p "$icon/Assets"
cp "$here/../../branding/sval/ios/back.png" "$here/../../branding/sval/ios/globe.png" \
  "$here/../../branding/sval/ios/letter.png" "$icon/Assets/"
cat > "$icon/icon.json" <<'JSON'
{
  "groups" : [
    { "layers" : [ { "glass" : true, "image-name" : "letter.png", "name" : "letter" } ],
      "shadow" : { "kind" : "neutral", "opacity" : 0.5 },
      "translucency" : { "enabled" : false, "value" : 0.5 } },
    { "layers" : [ { "glass" : true, "image-name" : "globe.png", "name" : "globe" } ],
      "shadow" : { "kind" : "neutral", "opacity" : 0.5 },
      "translucency" : { "enabled" : false, "value" : 0.5 } },
    { "layers" : [ { "glass" : false, "image-name" : "back.png", "name" : "back" } ],
      "shadow" : { "kind" : "none", "opacity" : 0.5 },
      "translucency" : { "enabled" : false, "value" : 0.5 } }
  ],
  "supported-platforms" : { "squares" : [ "iOS" ] }
}
JSON
