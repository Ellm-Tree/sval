# Colorshift (site styles)

**Status:** Draft.
**Date:** 2026-11-08
**Author:** John Postlethwait
**Builds on:** Zen Browser's boosts, decision 1980, `2026-11-04-host-scoped-rules-design.md`,
`2026-10-22-element-picker-design.md`, decision 0132 (the site menu).

## 1. What it is

A person restyles a site and it stays that way: a tint, contrast,
brightness and saturation, a light or dark theme, and a font. Its name in
the UI is Colorshift; the code, the pref and this spec say site styles. Arc
and Zen call this a Boost. Hiding part of a page is the element picker's job, and stays there.

The colors are Zen Browser's: its boosts backend
(`src/zen/boosts/nsZenBoostsBackend.cpp`, Zen commit 8f3ca12, MPL 2.0, by
the Zen OSS Team) tints and inverts each color as Gecko paints it, and Sval
ports that engine and its tests. The editor is Sval's own, drawn from the
site menu's parts, with Zen's two-dot wheel as its model.

## 2. Storage

- **One synced setting, `browser.sval.siteStyles`:** a JSON list of
  `{scope, hue?, strength?, complement?, contrast?, brightness?,
  saturation?, theme?, font?}`. `strength` is 1 to 100, and with it come
  `hue` and `complement`, whole degrees from 0 to 359; no `strength` is no
  tint. `complement` is the turn from `hue` to the second dot's hue.
  `contrast`, `brightness` and `saturation` are -100 to 100, absent at 0.
  `theme` is `light`, `dark` or absent for Automatic, and `font` is `system`, `serif`, `mono` or
  `readable`. An absent value leaves the page's own. `SvalSettingsSync`
  takes a synced value only when it parses as such a list.
- **Kept apart from My filters.** `SvalElementRules` reads every
  `example.com##…` line as an element removed from the site, so a `:style()`
  line there would be listed as a removal rule, counted on the eraser and
  forgotten as one. A style never touches My filters or `SvalElementRules`.
- **A scope is a host or a site** (decision 1980). The most specific scope
  holding a style decides for a page, and decides whole: a host's style
  replaces its site's. The editor opens a host with no style of its own on
  the style that applies there, so the first change saves that style with
  the change at the host.
- **The font's CSS is made only as a style is put into a page**
  (`sheetFor`), and its declaration passes `isSafeStyle`, the check the
  page rules give a filter's `:style()` action.
- Forget this site removes the styles of the site and its hosts, with the
  site's other choices.

## 3. The editor

- **Entry points:** Colorshift This Site… in the site menu's Colorshift
  section, the same item after Take Screenshot in the page context menu, in
  a tab's row menu in the Workspace (which selects the tab first) and in the
  menu bar's Tab menu, the Launcher's Colorshift this site command, and a
  `<key>`
  with no key until the person gives it one in Settings › Keyboard
  shortcuts.
- **A dialog of its own**: a `noautohide` panel opened at the screen
  (`openPopupAtScreen`), over the page's top end corner, anchored to no
  button. It wears the element picker's card edge, shadow and radius, and
  moves as the card does, by its title row and the bare surface between its
  sections, with the grab and grabbing cursors. It is drawn from the site
  menu's parts: its title and scope dropdown, under it the line "Allows you
  to change the site's look and feel. Changes sync to all your devices.",
  the zoom slider and its ticks, the value button and its menu, the footer.
- **Changes show at once and are kept by Save.** Each change is previewed
  in the tab (`SvalSiteStyles.previewIn`), which a load and a change to the
  setting keep showing until the dialog closes. Save writes the values at
  the scope in view and closes. Cancel, the Close button, Escape and a tab
  switch close without writing, and the tab shows its saved style again,
  so the page looks as it did when the dialog opened. A load of a page in
  another scope closes it as Cancel does.
- **It stays open while the person works with the page:** a load in the
  same scope, a click in the page, another window taking the focus, and
  the site menu open beside it. Opening it from the site menu closes the
  menu, which leaves its button as it was.
- **The wheel**, after Zen's: every hue around its edge, fading to the
  menu's surface in the middle. The dots reach the rim, and a dashed ring
  in the text color marks the distance both stand at. The accent dot's angle is the hue and its
  distance from the middle the tint's strength; the middle is no tint. The
  second, smaller dot stands at the same distance and turns on its own. A
  press on the wheel moves the accent dot there, a press on the second dot
  picks it up, and the dot follows the pointer, shown on the page as it
  moves. Each dot is a focusable slider whose value
  text gives its hue and strength. Left and Right turn it 5 degrees, 15
  with Shift; Up and Down move the strength 5 percent; Home and End go to
  the middle and the edge.
- **Contrast, brightness and saturation** are sliders from -100 to 100 in
  the zoom slider's look and ticks, the middle tick marking no change, with
  the dots' grab cursors. Dragging shows the value on the page.
- **Theme** is the control Settings › Appearance › Theme uses
  (`moz-visual-picker`, Automatic, Light and Dark), with the hint "Prefers
  the site's own light or dark theme". It works with a tint.
- **Font** is a value button with a menu, as the site menu's permissions
  are picked: the page's own font and four stacks of generic or installed
  families. A web font would need `url(`.
- **The footer** holds Reset style at its start, shown only while the scope
  has a saved style, then Cancel and Save, the primary last, as the element
  picker's card orders its buttons. Reset style puts every control back to
  the site's own look on the page; Save then removes the saved style, and
  Cancel undoes the reset.
- **The chevron carries a dot** while the selected tab's site has a saved
  style, and its name says so ("Site settings. This site has a
  Colorshift."). The site menu's Colorshift row carries the same dot, drawn
  as the chevron's, described as "This site has a Colorshift.", and its
  second line lists what the style changes, in the order tint, contrast,
  brightness, saturation, theme and font ("Blue tint, contrast +20, dark
  theme, serif font"). With none saved it reads "Change this site's colors,
  theme, and font".
- Private windows keep nothing, so the editor is not offered there.

## 4. Applying a style

- **Gecko paints every color through the style**
  (`chrome/layout/style/SvalSiteStyleColors.cpp`).
  `StyleAbsoluteColor::ToColor` is where a computed color becomes an
  nscolor, and it takes the frame the color is painted for. The frame's
  document's top BrowsingContext carries the style in six fields
  (`SvalSiteStyleAccent`, `…Rotation`, `…Contrast`, `…Brightness`,
  `…Saturation`, `…Dark`), set from the parent only. A frame in the parent
  process, a null frame and content the page did not author keep their
  colors: native anonymous UI such as scrollbars, and what
  `Document::InsertAnonymousContent` draws over the page, DevTools'
  highlighters and the screenshot overlay. Form controls' insides and
  pseudo-elements are the page's and are styled. An SVG mask's content
  keeps its colors, since a mask hides by luminance and dark would turn it
  inside out.
- **The patches** pass the painted frame to the color calls that skip
  `nsIFrame`: borders, outlines, backgrounds, gradient stops, SVG fill and
  stroke, collapsed table borders, the canvas's default background, the
  themed background of a text field, a button and a `<select>`, and a
  compositor background-color animation. A link's border is resolved
  without its frame and styled once, where it is drawn.
  The frame argument defaults to null, so every other caller is unchanged.
- **An SVG picture** is a document with no BrowsingContext, so the page's
  style travels in its `SVGImageContext`, which keys its cached renderings,
  and its pres context paints with it. A raster picture is never touched.
- **The page's computed styles are its own.** The style applies as colors
  are painted, so script reading `getComputedStyle` sees the page's colors.
- **Setting a field repaints the tab:** its documents recascade with a
  visual change hint, and their SVG pictures with them.
- `SvalPageRulesParent` sets the fields as a top-level web document asks
  for its rules, before it answers. Both travel the one channel to the
  document's process, in order, and the child holds the parser with
  `document.blockParsing` until the answer is in, so the style is in place
  for the first paint. A change to the setting, from the editor or a
  synced device, sets them on every open tab, and a top-level location
  change sets them for the page shown, which covers a page back from the
  back-forward cache and one with no web address.
- **The font** is a user sheet the child loads, which page script cannot
  read or remove. It covers every element but code and the elements icon
  fonts draw, told by the class and `aria-hidden` names their libraries use.

## 5. The colors

- **Tint**, Zen's duotone in Oklab. Each color moves toward one of two
  accents by its lightness, with a smooth crossfade: light colors toward the
  accent dot's hue, dark colors toward the second dot's. The engine takes
  the second dot's color and a turn to the first, measured in Oklab's a/b
  plane, where it turns. The strength sets
  how far a color's chroma moves, up to 90 percent at the edge, and how
  sharp the light and dark split is. Lightness moves toward the accent's by
  at most half the strength squared, so text keeps its contrast with its
  background. The accent is the hue at Zen's starting saturation and
  lightness, 50 and 55 percent. Zen carries the strength in the accent
  nscolor's alpha byte, and so does Sval.
- **Dark**, Zen's inversion: each channel is inverted, then all three are
  shifted by the sum of the inverted extremes, which turns lightness over
  and keeps the hue. A dark result is lifted to a floor of 15 per channel,
  so white inverts to near black; a light one is left as it is.
- **Contrast, brightness and saturation** are Sval's, applied after the
  tint and dark in Oklab, each keeping the hue. Contrast stretches lightness
  around its middle by up to half again; brightness moves it toward white
  or black by up to 40 percent of the room left; saturation scales chroma
  from none to double.
- **A theme always ends with a page in that scheme.** Automatic leaves the
  tab the scheme Sval gives every site and inverts nothing. Light and Dark
  set the tab's `prefersColorSchemeOverride` to the theme, so a site with
  that theme draws it. DevTools sets the same field, so Sval changes it only
  where it differs and puts back the value it found.
- **A page still in the other scheme is inverted.** Once the page prefers
  the theme, at `DOMContentLoaded` and again at its load, the child reads
  the computed background of the root, then of the body, and with neither
  the root's text color, which the canvas's default follows. A background
  whose WCAG relative luminance is above 0.4 is light. The child tells the
  parent whether the page draws dark. Dark inverts the page from its first
  paint, since most pages are light, and stops for a page that draws dark;
  Light inverts a page once it is measured dark. The answer holds until the
  page's next load.
- **Where it falls short:** under Dark, a page with a dark theme, or dark
  on its own, shows inverted, so light, until it is measured; under Light,
  a dark page shows dark until then. Checkboxes and radio
  buttons keep their themed colors. Selection and highlight colors and
  shadows given an exact color (`text-shadow`, `drop-shadow()`) keep the
  page's colors. A multi-column rule takes the style twice. Contrast repair for dark
  text, as Chromium's dark mode has, is left out until a page shows it is
  needed.

## 6. Text size

Left out. Gecko's text zoom (`BrowsingContext.textZoom`) is what a text size
means, and `FullZoom` sets it back to 1 on every page load when it applies
the site's zoom (`ZoomManager.setZoomForBrowser`). A user sheet can scale
only text sized against the root, and a root size overrides a site that sets
its own. The site menu's Zoom sizes a site and remembers it.
