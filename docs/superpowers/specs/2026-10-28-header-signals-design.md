# Header signals: one look per meaning, a JavaScript pin, and device controls

**Status:** Built.
**Date:** 2026-10-28
**Author:** John Postlethwait
**Builds on:** decision 0132 (site controls), `2026-10-22-element-picker-design.md`
(pinned buttons, §5 and §10.3), decision 0131 (the Privacy and Security
button).

## Rules

- **Every on/off state tells on from off by 3:1 or more** (WCAG 1.4.11), in
  every window and in forced colours. Contrast against the surface is not
  enough: the on look is measured against the off look.
- **The header uses five looks that people already know from other apps,
  and each look means one thing.** Pressed means on. Crossed means blocked or
  off. A dot means look at me. A count means this many things changed or
  blocked on the page. Alarm means live or unsafe. Anything else about a
  site, such as your rule, a saved choice or an allowance for this visit,
  goes in the tooltip and the site menu.
- **The site controls read by one rule** (decision 1985): a plain glyph is
  allowed or available, a slash is blocked and never carries a dot, a dot is
  a prompt waiting for the person's answer and nothing else, and the live
  fill is something happening on the page now. JavaScript is plain or
  crossed only.
- **"Differs from your default" has no mark in the header.** A page that
  breaks because your rule turns JavaScript off shows the crossed JavaScript
  glyph, and the site menu says "Your rule for this site".
- **The JavaScript button can be unpinned.** It is pinned by default.
- **Media, live devices and the chevron can't be unpinned.** Media's state
  moves too often (a visit's allowance, an attempt to play, the site's choice)
  to hide, and a hidden media button would take its "tried to play" dot with
  it.
- **A page's attempt to use a device blocked for its site** shows in the
  header. It shows only for that page visit.
- **A live device can be stopped from the site menu**, one device at a time.
  Stopping leaves the saved permission alone, and the device stays off on
  the tab until a reload. Gecko's revoke ends the camera and the microphone
  together, so Sval patches `MediaManager` to revoke one kind (§5).

## 1. The looks

| Look | Means | Used for |
|---|---|---|
| Pressed: a chip in the header's ink with the glyph in the header's colour | on | Snip, Remove, Reader, Panel, History, Privacy and Security while its panel is open |
| Crossed: crossed glyph in icon ink, a 2→22 stroked slash, never with a dot | blocked or off | media off, JavaScript off, a blocked device or location the page tried |
| Plain glyph in icon ink | everything else | includes Favorite (a filled star in ink) and the shield's "something blocked" (a filled shield in ink) |
| Dot: accent, top right | look at me; on a site control, a prompt waiting for an answer and only that | unread notice, extension notice, media that tried to play on Ask first, a permission prompt (open or closed), a breach |
| Count: a small number at top right, in the pressed look's colours | this many things changed or blocked on this page | Remove from this site (the site's rules, as the site menu counts them), Snip (the page's snips, until a reload); the chevron counts those of the two that are unpinned; the shield (the trackers and ads blocked on the page, over its filled shield; a breach's dot takes its place) |
| Alarm | live or unsafe | the live fill, one 26px chip in the live colours and hover on every control: a camera, microphone or screen in use, location in use, media playing on the page, a translated page; the shield's connection tones |
| Disabled: dimmed (forced colours `GrayText`) | can't be used | the only dimming in the header |

- Muted ink (`--sval-muted`) is used for no header glyph. Blocked never looks
  disabled.
- The solid action fill is used for no header button. The Panel and History
  toggles take the pressed look, in every window, tinted ones included. The
  chip is each window's own ink, so it needs no per-window swap.
- A count is never the accent: it says what changed, and the dot alone asks
  for attention.
- Accent marks only the dot, focus and live. Nothing pressed or chosen uses
  it.
- Breach is the top-right dot. Breach yellow stays inside the Privacy and
  Security panel's breach card.
- **The site menu and Settings:**
  - A pinned pin is the pressed look in the popup's colours. Unpinned is
    the outline pin.
  - The chosen segment of a segmented choice is the same chip. The others
    sit in an outlined group.
  - An off switch is an outlined, transparent track with a small knob. On
    is the action-coloured track with a larger knob at the end. The
    Privacy and Security panel's switches are the same.
  - A selection list marks its chosen row with a check, never a tint.

## 2. Each control

Each state's tooltip names the control, its state and what a click does.
The tooltips are in `SvalSiteControls.sys.mjs`.

**Video and audio**

| Look | States |
|---|---|
| plain | allowed; allowed for this visit; site set to Always |
| crossed | blocked; site set to Never; stopped for this visit |
| plain + dot | tried to play on Ask first, waiting for the person's answer |
| live fill | media playing on the page now |

The dot never shows for a site set to Never: the person already answered.

While the page captures a camera, microphone or screen, Gecko lets it play
whatever the site's choice (`IsWindowAllowedToPlayByTraits`), so the button
takes the plain look whatever its state, its tooltip says the page plays
while it uses the device, and it is `aria-disabled`: a click changes
nothing. It takes no live fill then, since the live cells beside it carry
the fill and say why. When the capture ends, the button
shows its state again, dot included.

**JavaScript**

| Look | States |
|---|---|
| plain | on, by default; on, by your rule |
| crossed | off, by default; off, by your rule |
| disabled | private window; page with no site |

**Remove from this site and Snip** say in their tooltips that their mode is
on while it is. A count names itself in the tooltip too: "Snip (2 snipped
until you reload)".

**Live devices.** The cell exists only while one of these applies, for each
of the camera, the microphone and the screen:

| Look | State |
|---|---|
| live fill | in use |
| live fill, crossed | a muted camera or microphone |
| glyph + dot | its permission prompt is open |
| glyph + dot | the prompt closed without an answer |
| crossed | blocked for the site, and the page tried to use it |

Each live cell is a button of its own. A click on a camera or microphone
mutes or unmutes it; on a screen it opens the site menu. Muting is Gecko's
camera and microphone mute (`DeviceListener::SetDeviceMuted`): the capture
goes on, the page's track sends black frames or silence and fires `mute`, and
unmuting needs no prompt. The asking and blocked cells together are one
button, which opens the site menu or the closed prompt. The blocked state
clears on the next top-level navigation, as media's attempt does.

**Location** is a button of its own, shown only while one of these applies:

| Look | State | A click |
|---|---|---|
| glyph + dot | its prompt is open, or held without an answer | opens the prompt |
| live fill | the page uses location | saves Block for the site and reloads |
| crossed | a block or a Block answer refused the page | saves Allow for the site and reloads |

**Translate** is plain while the page can be translated, and takes the live
fill, with the target language's code beside its icon, while the page is
translated.

## 3. Pinning JavaScript

- `browser.sval.siteControls.toolbarButtons` holds `"javascript"`, `"remove"`
  and `"snip"`. The default is `["javascript","snip"]`: Remove from this site
  stays unpinned by default, as the element picker spec has it.
- The cluster's order is live, media, JavaScript, Remove, Snip, chevron.
- Each pinned button takes its cell's width from the address field.
- An unpinned JavaScript button leaves no trace. The chevron stays plain.
- The site menu's JavaScript section ends its switch row with the pin button
  the Elements rows use, so the three pins line up. The
  section stays when the button is unpinned. In a private window the switch
  is disabled and the pin works, because the pref is global.

## 4. Settings

The Address bar page has a "Pinned to the address bar" card. It has a row
each for JavaScript, Remove from this site and Snip, in that order, and each
row ends with the site menu's pin button, with the same tooltips and
colours.

## 5. Live devices in the site menu

- **"In use now"** is the site menu's first section, above Elements, while a
  device is live.
- **A row per live device:** a tile in the live fill with the device's
  glyph, the device's kind and its name, then Stop. A camera or microphone
  also has Mute (Unmute while muted), and its tile's glyph is crossed while
  muted.
- **A shared screen** reads "Sharing a screen", "Sharing a window" or
  "Sharing a tab", with the window's title as the sub.
- **"Stop both"** ("Stop all" for three) is a link at the right of the
  section label, shown with two or more live devices.
- **Below the rows**, a line says a stopped device stays off on the tab
  until a reload and that the site's permission does not change.
- **Stop** ends that device's stream, with no confirm. The saved permission
  stays as it was. When nothing is left in use, the section and the live cell
  go and the menu stays open.
- **A stopped camera or microphone stays off on the tab.** A call page asks
  for the device again as soon as its track ends, and a site set to Allow
  would get it straight back. Stop sets a temporary block on the tab
  (`SitePermissions` `SCOPE_TEMPORARY`) before the revoke, and Sval's patch to
  `WebRTCParent`'s `prompt` refuses a request the tab's block covers whatever
  the site's saved permission (`getForPrincipal` reads a temporary block only
  where nothing is saved). The refusal shows as the blocked cell (§6), whose
  tooltip says the device was stopped on this tab. The device's permission
  row says it is off on this tab until a reload, with a "Turn on again"
  link, which lifts the block; the page has the device when it next asks. A reload of the tab
  lifts it (`SitePermissions.clearTemporaryBlockPermissions`), as does
  closing the tab. A screen share always prompts, so its Stop sets no block.
- **Focus** starts on the first Stop when the menu opens from the live cell.
- **Mute** sends the `WebRTC` actor's `webrtc:MuteCamera` (or `Unmute`,
  `MuteMicrophone`, `UnmuteMicrophone`) with the capturing window's id.
  `MediaManager` applies the mute topics to every window in the content
  process, as Firefox's global mute toggles ask, and a process can hold other
  tabs of the site, so Sval's patch mutes only the window a topic's data
  names. The toggles send no data and keep muting every window.
- **Gecko.** `MediaManager`'s `getUserMedia:revoke` takes a window id and
  stops every camera and microphone in it, or a `screen:` id and stops screen
  capture. Sval's patch adds `camera:` and `microphone:` ids that stop that
  kind alone. Sval sends the revoke through the `WebRTC` actor's
  `webrtc:StopSharing` message, without `webrtcUI.clearPermissionsAndStopSharing`,
  which also deletes the site's saved permissions.

## 6. A blocked device's attempt

`WebRTCParent.sys.mjs`'s `prompt` denies a request whose camera, microphone or
screen is blocked for the site without a word to anything else. Sval's patch
notifies `sval-webrtc-blocked` there with the browser and the permission ids,
and `SvalSiteControls` keeps them for the page visit.

## 7. Values

The sizes, colours, hover, focus and forced-colours rules of each look are in
`sval-header.css`, with the shield's in `sval-protection.css`. The dot cuts a
gap in the glyph beneath it by a mask on the icon, so it reads on every
window colour without an opaque surface token, and it is the only dot in
the header. The asking cell has no chip, because in dark an ink chip beside
the live fill would read as in use. New icons are Lucide at a 2px stroke,
as masks in `currentColor`. `browser_sval_on_states.js` measures on against
off.

## 8. Tests

- browser:
  - each media and JavaScript state draws its look and tooltip;
  - unpinning JavaScript hides its button and gives the address field its
    width;
    the site menu's pin and Settings' pin write the pref;
  - a page that asks for a blocked camera draws crossed, and a navigation
    clears it;
  - Stop on the camera ends the camera's track and keeps the microphone's,
    and the saved permission stays;
  - on a site set to Allow, a page that asks again once Stop ends its track
    is refused, "Turn on again" lets it have the camera, and a reload lifts
    the block;
  - the notices dot, the breach dot and media's dot are the one dot style;
  - each pressed header button, the open shield, both pins, the chosen
    segment and the switch are 3:1 or more against off, light and dark
    (`browser_sval_on_states.js`); the Panel and History toggles in every
    window (`browser_sval_header_toggles.js` and the colour files).
