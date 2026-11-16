# Element picker: remove an element from a site, and a snip

**Status:** Built.
**Date:** 2026-10-22
**Author:** John Postlethwait
**Builds on:** `2026-10-12-protections-design.md` §5 (page rules) and §1.2
(My filters), decision 0132 (the site menu).

Two modes share one overlay. **Remove from this site** picks an element and
saves a rule in My filters that hides it on the site from then on. **Snip**
removes an element from the open page and saves nothing.

## Rules

- **Sval writes its own picker.** uBlock Origin's (`src/js/scriptlets/epicker.js`,
  GPL-3.0) and Brave's (`components/cosmetic_filters/resources/data/element_picker.ts`,
  MPL-2.0) are reference designs. Most of either is extension or Chromium
  plumbing that Sval has in another form; the part worth having is the
  selector heuristic, which is small.
- **Remove from this site is off in private windows.** A picked rule names
  the site and syncs, so a private window cannot make one. Rules made in
  normal windows apply in private ones, as My filters do, and the site menu
  and Settings list them there read-only.
- **Snip works in private windows.** It saves nothing.
- **No right-click entries.** A native menu item cannot offer the pointing,
  depth or confirm step. The entry points are two buttons that can be pinned
  in the site controls, the site menu's Elements section and the Tab menu.
- **Choosing and confirming are one card,** with a depth slider. Each use
  selects one element.
- **The network rule is on by default** for an image, iframe, video or audio
  whose source is on another site than the page, and is written as a line of
  its own. My filters feed the same engine as network rules, so this needs a
  rule and an option and no new mechanism.
- **A source on the page's own site gets no "Stop the download too".** The
  engine never blocks a request to the page's own site
  (`ContentClassifierEngine::CheckNetworkRequest`), so the option is not
  offered, and the parent refuses a save that sends such a URL (§2).
- **Every line of My filters is its own row** wherever rules are listed.
- **Undo lasts 8 seconds and is the toast's button only.** The page keeps
  the keyboard's undo.
- **No default shortcut keys.** Both commands can be given a key in Settings.
- **Remove from this site is off while ad blocking is Off.**
  `SvalBlocking.apply` gives the engine My filters only when the level is not
  Off, so a rule saved then would do nothing.
- **Class names are copied as the page has them**, as uBO and AdGuard do. A
  site whose class names are generated at build time breaks such a rule when
  it rebuilds; the preview shows what a rule matches before it is saved.

## How others do it

- **Overlay.** uBO appends an iframe holding its picker page; AdGuard
  Assistant and Brave use a closed shadow root. The pointer passes through it
  and `elementsFromPoint` finds what is under it.
- **Candidates.** One selector per ancestor, up to `body`: `#id` when it is
  unique, else the element's classes, else `img`/`iframe[src]`, `a[href]` or
  `[alt]` cut to 256 characters, then the tag and `:nth-of-type(n)` until it
  is unambiguous. uBO prefers `:nth-of-type` to `:nth-child` as less volatile.
- **Controls.** A depth control chooses the ancestor. uBO adds a specificity
  control that strips ids, classes and positions; AdGuard has "block similar",
  which joins the classes as alternatives.
- **Preview,** then **save** as `host##selector` in the user's own rules.
- **Network candidates** for `src`-bearing elements: `||host/path`, with
  `$domain=<site>`.
- **Trust.** Brave's renderer sends only the selector; the browser process
  adds the host, because a content process is not trusted to name it.
- **Snip.** uBO's picker in a mode that calls `remove()` on the element and
  saves nothing.

## 1. The picker

A `SvalElementPicker` JSWindowActor pair, top-level documents only, in
Sval's component directory.

- **The overlay is anonymous content** (`Document.insertAnonymousContent`),
  as Firefox's Screenshots overlay draws (`ScreenshotsOverlayChild.sys.mjs`).
  The API is `ChromeOnly` and the content goes in the document's canvas
  frame, outside the page's DOM (`AnonymousContent.webidl`), where uBO's
  iframe is a node the page can remove.
- **Hit-testing** reads `elementsFromPoint` under the pointer. An iframe is
  picked as the `<iframe>` element in the top document; the picker does not
  pick inside frames. Elements under 8 by 8 CSS px, `html` and `body` are skipped.
  Both modes may target a layer that fills the viewport: paywalls and
  consent walls are such layers, and the card's match count shows what a
  rule on one would hide.
- **One element per selection.** The chosen element is stop 1 of the depth
  slider. The other stops are its ancestors, nearest first, up to the last
  one that is not `body`, at most 6 stops in all.
- **Candidates** are built as above: one per stop, class names as the page
  has them. An attribute selector carries the value when the value is at most
  40 characters and the value narrows the match; a longer value falls back to
  the bare `tag[attr]`. Each is checked with
  `querySelectorAll` and the count of matches goes to the card.
- **Rule generation** takes the chosen element's classes, else its id, else a
  short attribute selector, else `tag:nth-of-type` under a classed parent.
  The attribute selector is tag-prefixed and takes `data-*` attributes and
  the like, never `role`, `aria-*`, `tabindex`, `type`, `width`, `height` or
  `style`, because a bare `[role]` would hide every element with a role. It
  does not judge whether a class looks generated, and the card says nothing
  about fragility.
- **Inside a shadow root.** Pointing at an element inside an open shadow root
  offers its outermost shadow host, never the element. A selector made from
  the page's tree does not match across a shadow boundary, so such a rule
  could name only the host. A hiding rule loaded as a user sheet
  (`loadSheetUsingURIString` with `USER_SHEET`) hides an element inside an
  open shadow root when its selector matches inside that tree, such as
  `.inner`, and a selector that crosses the boundary, such as
  `#host .inner`, matches nothing. `elementFromPoint` and `elementsFromPoint`
  retarget a point in a shadow tree to its host, so the picker offers the
  outermost host (`hostOf`) and never a rule for an element inside.
  `browser_sval_element_picker_shadow.js` asserts both.
- **Preview** marks every element the current candidate matches. A selector
  that also matches other elements hides them all, and the card says how
  many.
- **One card chooses and confirms.** The slider, the preview, the count, the
  rule, the download option and Cancel and Hide are all on it. Esc goes back
  to pointing with the outline left on the chosen element, and a second Esc
  leaves.
- **Keyboard.** Every step works without a pointer; Escape leaves (§10.10).

## 2. Saving a rule

- **The parent writes it.** The child sends the selector and, for a network
  rule, the URL. The parent takes the site from its own record of the
  document through `siteOf` (`SvalAgentPolicy.sys.mjs`), the same eTLD+1 Sval
  uses for every per-site choice, and writes `site##selector`, and
  `||host/path$domain=site` for a network rule. The content process is not
  trusted: the parent takes a save only from the actor of the tab's current
  document while that actor runs the picker, and the save ends the mode. It
  checks availability again at each save.
- **A network rule is its own line.** "Stop the download too" is on by
  default for an `img`, `picture`, `iframe`, `video` or `audio` whose source
  is on another site than the page; for a source on the page's own site the
  option is not offered, and the parent refuses a save that sends such a URL.
  With it on, Hide appends two lines, the hiding rule and then the network
  rule. They are separate rules from then on: each is listed, counted and
  removed alone. When the URL cannot make a narrow rule (§8), the save is the
  hiding line alone.
- **Through My filters.** The lines are appended to `MY_FILTERS_PREF` through
  `SvalBlocking`, the path the settings field takes, so they sync and reach
  the engine as an edit there does. An append the pref store refuses
  (`MAX_PREF_LENGTH`) is reported to the user and nothing is saved.
- **The selector is checked in the parent.** It is at most 1024 characters
  (a URL at most 2048). It holds no brace, line break or comment, and the
  CSS parser, run on an element of a document the parent makes, takes it as
  plain CSS. A scriptlet (`+js(`), an HTML filter (`^`) and the procedural
  operators (`:has-text(`, `:style(`, `:remove(`, `:xpath(`) are refused by
  that parse. My filters must read the line back as one hiding rule with the
  same selector. The child checks as page rules do (`usableSelector`, which
  `hidingSheet` applies) before it asks, and so does the parent.
- **A refused save shows an error toast.** When the parent refuses a save,
  the toast takes the place of the success toast, with no Undo and the same
  8-second timer, and the page is left as it is. It says whether My
  filters is full (the pref store refused the append) or the mode is off
  here (the picker became unavailable or the selector was refused). The mode
  ends as it does for a save.
- **The open page hides it at once.** Page rules load at document start, so
  the child loads the new rule into the open document with `hidingSheet` and
  `loadSheetUsingURIString`. The matches fade out, then the rule applies and
  the page closes the gap; under `prefers-reduced-motion: reduce` it applies
  at once. Other tabs on the site get it on their next load.
- **A toast follows,** with Undo as its button. Undo removes the lines from
  My filters and the sheet from the open page (`removeSheetUsingURIString`).
  It is open for 8 seconds, and hover or focus on the toast pauses the
  timer. There is no keyboard undo, and Esc closes the toast only while
  focus is in it, so the page keeps its own Esc.
- **Undo takes out only what the actor saved.** For each line it saved and
  has not undone, it removes the last occurrence of that line's text as My
  filters reads at that moment, since the text may have changed since the
  save. A line the actor did not save stays, so the content process cannot
  delete the person's other rules. An identical hand-typed line earlier in
  the list stays.
- **The picker ends when the rule is saved.** Focus returns to where it was
  before the picker opened.
- **No comment line** is written with the rule. The site in it is what the
  rule needs.

## 3. Where it is off

Remove from this site is unavailable, and says so where it is offered, when:

- the window is private;
- ad blocking is Off;
- the site has its protection exception (`ContentBlockingAllowList`), because
  page rules do not run there (protections spec §5.4);
- the page is not http or https, so it has no site.

Snip is unavailable only for pages that are not http or https.

Where it is offered, an unavailable entry stays and dims. §10.9 has the
reasons as they read.

## 4. Snip

Snip shares the overlay. Each use removes one element from the open page and
saves nothing. Reload or navigation brings everything back.

- **One removal per use.** A click, or Tab and Enter or Space, removes the
  element under the pointer with a fade, and the mode ends. The toast offers Undo for
  8 seconds, as in §2.
- **A dialog's backdrop goes too.** When the removed element is a dialog
  (`dialog`, `[role=dialog]`, `[aria-modal=true]`), the topmost
  `position: fixed` element behind it at its centre that covers 90% or more of
  the viewport in both directions and holds no element and no text is removed
  as well. An ancestor of the dialog is never taken, so a fixed app shell
  stays. A backdrop that holds content is left for the person to remove
  separately.
- **Scroll unlocks.** When anything removed was `position: fixed` (or inside a
  fixed box) or `sticky` and covered 50% or more of the viewport by area,
  `overflow: hidden` is cleared on `html` and `body`. Undo gives them the
  `overflow` they had.

## 5. Entry points

- **Pinned buttons in the site controls,** after the media and JavaScript
  buttons and before the chevron: Remove from this site, then Snip. Snip is
  pinned by default (header-signals spec §3). A click starts the mode on the
  current tab and lights the button, and a second click leaves the mode.
- **The site menu's Elements section** has a row for each command, each with
  a pin button. Choosing a row closes the menu and starts the mode. The pin
  button works when its row is unavailable.
- **The pin choice is one pref,** global and synced
  (`browser.sval.siteControls.toolbarButtons`). The site menu's pin buttons
  and the Address bar page's "Pinned to the address bar" card write it
  (header-signals spec §4).
- **Shortcuts.** Each command is a key with none assigned (`MODE_KEYS` in
  `SvalShortcuts.sys.mjs`), named by a Tab menu item, "Remove from this
  site…" and "Snip…", because that is how Firefox's shortcut editor lists a
  command. Settings › Keyboard shortcuts lists both without the "…". A key
  set there starts the mode as the button does, or leaves it, and does
  nothing where the mode is not offered. The menu items are disabled where
  the selected tab does not offer the mode. The button's tooltip shows the
  key as plain text, "Name (key)", as the panel toggle's does. The overlay
  adds no global key.
- **Pages with no site** (`about:`, `file:`, Sval pages) have no site menu.
  The chevron dims and does nothing, and the pinned buttons' tooltips give
  the reason.

## 6. Managing rules

A site's hidden elements are every line in My filters that names the site,
hand-typed and imported lines included: each `site##…` line whose domain list
names it, and each network line whose `domain=` names it. A scriptlet
(`+js(`) or HTML-filter (`^`) line is not a hidden element and is left out of
every list and count (§8). Lists show them
newest first, the reverse of their order in My filters. A rule has no date.

- **The site menu** has a collapsible "Removal rules for this site" section, shown
  only when the site has rules and collapsed each time the menu opens. It
  lists each line as a row, six at most, and links to Settings. A hiding row
  says how many elements it hides on the page. A network row says it stops a
  download. A hiding row does not say that a download is still blocked.
- **Show again** takes the site out of the line's domain list, and deletes
  the line when no plain domain is left. A file loads on its next request.
  In the site menu, an element the picker hid in this visit shows again at
  once. A rule the page loaded with stays hidden until the page loads again,
  because page rules keep one sheet and cannot drop one rule from it. Other
  tabs and Settings follow on their next load.
- **Settings › Sites** lists a site whose only choice is removed elements
  too, and its filter has "Removed elements" (decision 1484). The site's page
  lists every line of the site, each with Show again, and links to My
  filters (site-page spec §2). The row's Reset removes the site from its
  lines as Show again does, and asks first when it would delete a line.
- **Settings › Privacy and protection › Ad blocking › My filters** is the
  full list, as text, and is where rules are edited.
- **Private windows** list the rules read-only, with no Show again.

## 7. Visual design

§10 holds the rules the look keeps. The values are in the stylesheets.

## 8. Code

- Added files: `SvalElementPickerChild.sys.mjs`, `SvalElementPickerParent.sys.mjs`,
  `SvalElementCandidates.sys.mjs`, which builds candidates with no DOM of its
  own, for xpcshell tests, `SvalElementRules.sys.mjs`, the module that reads and edits a site's lines
  in My filters (§2, §6), `SvalElementPicker.sys.mjs`, which decides where the
  picker is offered and keeps each tab's mode and the pins pref (§3, §5), and
  `SvalElementPointing.sys.mjs`, the outline, label and bar that the picker
  and Snip share. No Mozilla file is patched.
- `SvalElementRules` takes a line as the site's when the site is one of its
  plain domains. A `~` entry, an exception (`#@#`, `@@`), another host
  (including a subdomain), a scriptlet (`+js(`) and an HTML filter (`^`)
  never are. A line left with no plain domain after a removal is deleted, so
  a line is never widened to other sites. The module offers no network rule
  for a URL whose path is `/` or holds `*`, `^`, `|` or `$`, because such a
  rule would match more than that one file.
- `SvalPageRulesParent.sys.mjs` exports its protections-off check, so the
  picker's parent and page rules share one function.
- Logs carry no site, selector or URL (hard rule 10).

## 9. Tests

- xpcshell:
  - candidates for an id, classes, `src`/`href` attributes, an ambiguous
    sibling and an ancestor walk; selectors `hidingSheet` refuses are not
    offered;
  - `SvalElementRules` over a text of cosmetic, network, exception, `~` and
    other-host lines.
- browser:
  - a picked element is hidden at once and after reload, and the line is
    `site##selector` in My filters;
  - a network rule is a line of its own and blocks the image's request;
  - Undo unhides it and removes the lines, and no key undoes it;
  - Remove from this site is unavailable in a private window, with ad blocking Off, on
    a site with its exception, and on a non-web page;
  - a rule made in a normal window applies in a private one, listed
    read-only;
  - Snip removes an element, saves nothing, and works in a private window;
  - Snip removes a dialog's backdrop and unlocks scroll;
  - the Sites row's Reset asks when the site has lines, and removes only the
    site from a line that names others.

## 10. Values

The overlay's look is in `sval-element-picker.css`, the pinned buttons' in
`sval-header.css`, the site menu's in `sval-protection.css`, and Settings'
in `settings.css`. The rules those values keep:

- **The overlay carries its own tokens.** It is anonymous content in a web
  page with its own stylesheet, so it cannot use the chrome's. Only its
  surfaces (bar, card, toast) follow the chrome's colour scheme. The marks
  are the same in both schemes, because they sit on the page's colours, and
  each surface's shadow has an outer ring in the opposite tone so a card
  stays visible on a page of either tone.
- **The overlay's text is `system-ui` and its monospace `ui-monospace`**,
  because a web page cannot load Sval's fonts.
- **Forced colours.** The overlay sets `forced-color-adjust: none` and
  applies the system colours itself: `Highlight` for the outline, the primary
  button, the checked box, the lit pin and the slider fill. Snip's outline is
  dashed there, because it shares `Highlight` with the picker's.
- **Marks.** The pointed and chosen element gets an outline just outside its
  border box, clamped to the viewport, with a tab on its top-left naming the
  element and its size; the tab goes inside when the element's top is at the
  viewport's top. Every other match gets a dashed, hatched box. Snip's mark
  is the same in its own colour.
- **The pointing bar** sits at the bottom centre of the page area and moves
  to the top while the pointer is over its area.
- **The card** sits in the corner of the page area that overlaps the fewest
  marks, on a tie the corner farthest from the chosen element, and docked at
  the bottom centre when every corner covers it. It moves only when the
  chosen element changes. It is `role="dialog"`. Its slider is
  `role="slider"` with `aria-valuetext` naming the element and its selector.
  The count is a polite live region. Focus starts on Hide.
- **The toast** takes the bar's place and is `role="status"`.

### 10.9 Unavailable

A dimmed entry has `aria-disabled="true"`. A pinned button's tooltip names
the mode and the reason in brackets. The site menu's row gives the reason in
its sub line at full contrast, with the action where there is one: ad
blocking Off offers Turn on, which opens Settings › Privacy and protection ›
Ad blocking, and protections off for the site offers Turn on, which turns
them on and reloads. A page that is not a website has no site menu.

### 10.10 Motion and keyboard

Every transition is instant under `prefers-reduced-motion: reduce`.

- **Pointing:** Tab and Shift+Tab move the outline through pointable elements
  in document order, within the viewport, and scroll at the edge. Enter or
  Space chooses. Esc leaves.
- **Card:** focus is trapped in it. Up and down anywhere in the card, and
  left, right, Home and End on the focused slider, move between stops. Space
  toggles the download option. Enter is Hide.
- **Snip:** Tab and Shift+Tab, Enter or Space removes and ends the mode,
  Esc leaves.
- **Screen readers:** the bar is `role="toolbar"`. Moving the outline
  announces the element's name and size in a polite live region. The count
  is live.
