# 0057. Workspace and group colours are free, and their text is solved

**Status:** Accepted on 2026-11-11.

## Context

A Workspace's colour fills its window: the toolbar, the Workspace panel and
the popups the window opens. Sval runs in the light and dark system
appearances and under forced colours. A person wants a colour of their own
and a window the wallpaper shows through, and the window's text has to stay
readable on every colour and every wallpaper.

WCAG 2's ratio is the measure laws and audits use, and it misjudges light
text on dark colours: it bans mid-tones that people read white text on
easily. APCA (APCA-W3 0.0.98G-4g, the method proposed for WCAG 3) rates the
two polarities apart, closer to how they are seen.

A browser window's own content cannot show what lies behind the window: CSS
backdrop filters reach only the window's own content. On macOS, AppKit's materials
(`NSVisualEffectView`) blur what is behind the window, and they are neutral
by design, with no tint. A colour laid over one at 35% or more still reads
as the colour, and text picked for the colour alone reads over most of
what lies behind.

## Decision

A Workspace colour is one of Sval's presets, or a custom colour: an OKLCH
hue, chroma and lightness, and the appearance it was picked in. With either
comes a transparency. A group's colour is a preset, or a custom
OKLCH hue and chroma: a group is drawn as a block a step off its window's
colour, so the window sets its lightness, and it has no backdrop of its own
to see through. All of it is held in the appearance group and syncs.

Every colour on the window, a group's block included, is solved against the
surface it sits on, at its worst backdrop:

- **Body text** meets APCA Lc 75 and WCAG 2 4.5:1.
- **Muted text** meets Lc 60 and 4.5:1.
- **Lines** (field borders, rings) meet Lc 30 and 3:1.
- When the system asks for more contrast, body text meets Lc 90 and 7:1,
  muted text Lc 75 and 4.5:1, and lines Lc 45 and 3:1.

Each text colour is the one nearest the surface that meets its target, in the
surface's hue, so the text carries as much of the colour as legibility
allows. Whether a window's text is light or dark follows from the colour.

**The picker offers only colours that pass.** A lightness where neither light
nor dark body text meets its target is left out of the picker. A preset
that cannot meet the raised targets moves its lightness as little as they
need, unless it carries a colour of its own for them.

**The picker.** A Workspace's presets are two rows: each preset's dark
version, then its light one, with White in Black's place. The version that
suits the system appearance is the preset, which follows the appearance;
the other is a custom colour picked against its appearance, so it stays as
shown. A custom colour is picked on a wheel, the angle its hue and the
distance from the centre its chroma, painted at the chosen lightness. One
Shade slider runs over every lightness the text allows, dark to light, with
the gap left out, so the text changes side as Shade crosses it and no
light or dark choice is asked for. A group's custom colour is picked on the
same wheel, without Shade. Neighbouring presets in each row stay at least
0.04 apart in OKLab, in both appearances and under the raised targets.

**Light and dark.** A preset carries a colour for each appearance. A custom
colour that suits the appearance it was picked in (a dark surface in dark,
a light one in light) has a counterpart in the other with its hue: deep in
dark, and in light the most colourful light surface dark text reads on. A
custom colour picked against its appearance, such as a vivid orange in
light, is the same in both.

**Transparency** is how much of what is behind the window shows,
everywhere round the page, on macOS, on Windows 11 and on Linux where the
compositor blurs. The page itself
stays opaque. One material lies behind the whole window, in the appearance
of the window's text: `hudWindow` on macOS, and on Windows the Acrylic
system backdrop, the closest of Windows' backdrops to it. On Linux the
compositor blurs what is behind the window through ext-background-effect-v1
(GNOME 51, KDE Plasma 6.7) and draws no material, so the window's root
paints `hudWindow`'s grey under its colour, solved from the measures that
give `hudWindow`'s middle, and the window shows what it would on macOS. Gecko
does not speak the protocol, and Sval's patch to its GTK widget does. One background on
the window's root lays the colour over it at a share of 1 minus the
transparency. The toolbar, the Workspace panel, the sidebars and the margin
round the page are clear over that background, so they move without a seam.
The colour keeps at least 35%: every colour goes to 65%. Text keeps the side
the solid colour gives and is solved on the colour the window shows, the
colour mixed with the material's measured middle, which popups and solid
dialogs wear so they match the window. The material's blur is the system's. At no
transparency the window is opaque and draws no material. When the system
reduces transparency (macOS's Reduce transparency, Windows' Transparency
effects turned off, high contrast on Linux), the window is solid. Windows
without a system backdrop, Linux on X11 and a Linux compositor that does not
blur draw the solid colour: without blur, what is behind the window shows
sharp through its text.

**Dialogs.** A dialog in a see-through window is frosted. Its card blurs
the dimmed window under it, the page and Sval's own chrome, and never what
lies behind the window. It wears the colour the window's root wears where
only a blur lies behind it, as on Linux: the colour at the window's share
over `hudWindow`'s grey. Its text is solved on what that shows, by the
targets above. The Send Feedback form, a popover joined to its button, is
frosted the same way. A critical dialog stays solid, the one dialog that means work
is being lost, as does a dialog drawn in a palette of its own, such as the
import page's. When the window is solid, at no transparency or with the
system reducing transparency, every dialog is opaque.

**No colour** is Sval's own window colour: its navy in dark and its blue
white in light. Solid, it is drawn by Sval's own styles. With a
transparency it is see-through like any other colour, by the same rules,
and Custom starts from it.

**The home page.** Every colour's home page but solid No colour's is
Sval's starry night sky under a wash of the colour the window shows. The
wash rises from the bottom like a glow on the horizon, with a faint band
along the top where the page meets the frame. The mark and the search
field stay clear of it. The sky stays dark, so the page's text stays
light. The wash is as strong as that text allows over the sky's lightest
part, up to 80%, so a light colour washes faintly. The text is solved on
the wash at its strongest, by the targets above. The glow behind the mark
takes the colour too, lifted to at least OKLCH lightness 0.62 so a dark
colour still glows. The glow ends above the hint below the search field.
No text lies under the glow, so the glow can be stronger than the wash. No
colour on a solid window keeps the sky of the system's appearance, with no
wash.

Under forced colours the system's colours replace the Workspace's.

## Consequences

Any colour a person can reach reads well. What is behind a see-through
window is not measured, so over a very light or very dark window behind
it, its text can fall short of the targets.

A band of mid lightness cannot be picked, wider when the system asks for
more contrast. In light, dark text needs a surface light enough that red,
blue and purple hold little chroma in sRGB, so those presets stay pale. Under
the raised targets they hold less still, and neighbours are set apart by
lightness as well as hue.

A see-through window keeps the GPU two to three times as busy as a solid
one while its content moves, measured on macOS. The material's middle on
Windows is not measured, and macOS's stands in for it.

At WCAG 2's 4.5:1, muted text reaches the same contrast as body text and
stands apart only by size or weight.

A single colour stored with no appearance to fit would leave one appearance
unreadable or unchosen, and is rejected. A contrast setting offered to the
person is rejected: the targets are Sval's, and the system's request for more
contrast is the one input. WCAG 2's 7:1 as the only target is rejected: it
bans most mid-tones. Capping transparency so text meets its targets over
the darkest and lightest backdrop is rejected: it held light colours to
about a third and left every window close to the material's grey. Locking
the window's brightness to the colour's, with the backdrop's hue laid over
it, is rejected: pale colours showed nothing behind them, and near-black
ones showed it banded and oversaturated. A private backdrop layer, which would allow a blur radius, is rejected: it is
private API. A dialog that shows what lies behind the window is rejected: a
dialog is about its window, and the desktop seen through it reads as
another app's. A home page sky tuned to each preset is rejected: a custom colour has
no tuned sky, and a sky drawn in a custom colour's hue read as another
colour once the colour stopped matching the window. A home page filled with the colour the window
shows is rejected: a light colour turned the page light, and the page lost
its sky.
